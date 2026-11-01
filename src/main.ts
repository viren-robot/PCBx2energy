import './style.css';
import { generateDesign, MODELS } from './ai';
import { runDrc, type DrcIssue } from './drc';
import { bomLines, buildFabPackage, FABS, type OutFile } from './export';
import { buildSilk, type Silk } from './silk';
import { EXAMPLES, offlineDesign } from './templates';
import { DEFAULT_SETTINGS, type Board, type Design, type FabId, type Settings } from './types';
import { View2D, type Layers2D } from './view2d';
import { View3D } from './view3d';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const LS = { key: 'pcbx2.apiKey', model: 'pcbx2.model', design: 'pcbx2.design', settings: 'pcbx2.settings', fab: 'pcbx2.fab' };

// ---------------- state ----------------
let design: Design | null = null;
let board: Board | null = null;
let silk: Silk | null = null;
let drc: DrcIssue[] = [];
let fab: FabId = (localStorage.getItem(LS.fab) as FabId) || 'jlcpcb';
let settings: Settings = { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(LS.settings) || '{}') };
let apiKey = localStorage.getItem(LS.key) || '';
let model = localStorage.getItem(LS.model) || MODELS[0].id;
let busy = false;
let abort: AbortController | null = null;
let view3dDirty = true;

const view2d = new View2D($<HTMLCanvasElement>('c2d'));
const view3d = new View3D($('c3d'));
view2d.onHover = (t) => ($('hover').textContent = t);

// ---------------- worker ----------------
let worker: Worker | null = null;
let jobId = 0;
function getWorker() {
  if (!worker) worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  return worker;
}
function layoutInWorker(d: Design, s: Settings): Promise<Board> {
  const id = ++jobId;
  const w = getWorker();
  return new Promise((resolve, reject) => {
    const onMsg = (e: MessageEvent) => {
      if (e.data.id !== id) return;
      if (e.data.type === 'progress') { setProgress(e.data.fraction); setStatus(e.data.msg, 'busy'); return; }
      w.removeEventListener('message', onMsg);
      if (e.data.type === 'done') resolve(e.data.board as Board);
      else reject(new Error(e.data.message));
    };
    w.addEventListener('message', onMsg);
    w.addEventListener('error', (ev) => reject(new Error(ev.message || 'Layout worker crashed')), { once: true });
    w.postMessage({ id, design: d, settings: s });
  });
}

// ---------------- UI helpers ----------------
function setStatus(msg: string, kind: 'idle' | 'busy' | 'err' | 'ok' = 'idle') {
  const el = $('status');
  el.textContent = msg;
  el.className = `status ${kind}`;
}
function setProgress(f: number) { $('progress-bar').style.width = `${Math.round(Math.max(0, Math.min(1, f)) * 100)}%`; }
function log(html: string) {
  const li = document.createElement('li');
  li.innerHTML = `<span class="muted">${new Date().toLocaleTimeString()}</span> ${html}`;
  $('log').prepend(li);
}
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

function setBusy(on: boolean) {
  busy = on;
  $<HTMLButtonElement>('btn-generate').disabled = on;
  $<HTMLButtonElement>('btn-reroute').disabled = on;
  $<HTMLButtonElement>('btn-json-apply').disabled = on;
  $('btn-cancel').classList.toggle('hidden', !on);
  if (!on) setProgress(0);
}

function updateAiMode() {
  const el = $('ai-mode');
  if (apiKey) { el.textContent = `AI: ${MODELS.find((m) => m.id === model)?.label.split(' (')[0] ?? model}`; el.className = 'pill ok'; }
  else { el.textContent = 'Offline templates · add API key for full AI'; el.className = 'pill'; }
}

// ---------------- core flow ----------------
async function generate() {
  if (busy) return;
  const prompt = $<HTMLTextAreaElement>('prompt').value.trim();
  if (!prompt) { setStatus('Type a description first.', 'err'); return; }
  const refine = $<HTMLInputElement>('refine').checked && !!design;
  setBusy(true);
  abort = new AbortController();
  try {
    let d: Design;
    if (apiKey) {
      log(`<b>${refine ? 'Modify' : 'Generate'}:</b> ${esc(prompt)}`);
      d = await generateDesign({ apiKey, model, prompt, current: refine ? design : null, signal: abort.signal, onProgress: (m) => setStatus(m, 'busy') });
    } else {
      if (refine) log('Offline mode cannot modify designs - generating a new one. Add an API key in Settings for AI edits.');
      const r = offlineDesign(prompt);
      d = r.design;
      log(`<b>Offline template:</b> ${esc(r.matched)} (from "${esc(prompt)}")`);
    }
    log(`Circuit: <b>${esc(d.name)}</b> - ${d.components.length} parts, ${d.nets.length} nets`);
    for (const n of d.notes ?? []) log(`Note: ${esc(n)}`);
    await layout(d);
  } catch (e) {
    setStatus((e as Error).message, 'err');
    log(`<span style="color:var(--danger)">Error:</span> ${esc((e as Error).message)}`);
  } finally {
    abort = null;
    setBusy(false);
  }
}

async function layout(d: Design) {
  setStatus('Placing and routing…', 'busy');
  const t0 = performance.now();
  const b = await layoutInWorker(d, settings);
  design = d;
  localStorage.setItem(LS.design, JSON.stringify(d));
  setBoard(b);
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  if (b.unrouted.length) {
    setStatus(`Done in ${secs}s - ${b.unrouted.length} connection(s) could not be routed.`, 'err');
    log(`Routed with <b>${b.unrouted.length}</b> unrouted connection(s). Try a bigger board or narrower tracks.`);
  } else {
    setStatus(`Done in ${secs}s - fully routed, ready to export.`, 'ok');
    log(`Layout: ${b.width.toFixed(0)}×${b.height.toFixed(0)} mm, ${b.tracks.length} tracks, ${b.vias.length} vias - <b>100% routed</b>`);
  }
}

function setBoard(b: Board | null, keepView = false) {
  board = b;
  if (b) b.settings.maskColor = settings.maskColor;
  silk = b ? buildSilk(b) : null;
  drc = b ? runDrc(b) : [];
  view2d.markers = drc.filter((d) => d.kind !== 'warning' && d.x !== undefined).map((d) => ({ x: d.x!, y: d.y! }));
  view2d.setBoard(b, silk, keepView);
  view3dDirty = true;
  if ($('pane-v3d').classList.contains('active')) refresh3d();
  renderStats();
  renderDrc();
  renderBom();
  renderNets();
  $<HTMLTextAreaElement>('json-edit').value = design ? JSON.stringify(design, null, 2) : '';
  for (const id of ['dl-gerber', 'dl-bom', 'dl-pnp', 'dl-all']) $<HTMLButtonElement>(id).disabled = !b;
}

function refresh3d() {
  if (!view3dDirty) return;
  view3dDirty = false;
  view3d.setBoard(board, silk);
}

// ---------------- panels ----------------
function renderStats() {
  const el = $('stats');
  if (!board) { el.className = 'stats muted'; el.textContent = 'No board yet.'; return; }
  const b = board;
  const smd = b.comps.filter((c) => c.fp.mount === 'smd' && c.fp.body.kind !== 'hole').length;
  const tht = b.comps.filter((c) => c.fp.mount === 'tht' && c.fp.body.kind !== 'hole').length;
  const len = b.tracks.reduce((a, t) => a + t.pts.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - t.pts[i][0], p[1] - t.pts[i][1]), 0), 0);
  const rows: [string, string][] = [
    ['Name', b.design.name],
    ['Size', `${b.width.toFixed(1)} × ${b.height.toFixed(1)} mm`],
    ['Layers', `2 · ${b.settings.thickness} mm · ${b.settings.finish}`],
    ['Parts', `${smd} SMD · ${tht} THT`],
    ['Nets', String(b.nets.length)],
    ['Tracks', `${b.tracks.length} · ${(len / 10).toFixed(1)} cm`],
    ['Vias', String(b.vias.length)],
    ['Routed', b.unrouted.length ? `${b.unrouted.length} unrouted` : '100 %'],
  ];
  el.className = 'stats';
  el.innerHTML = rows.map(([k, v]) => `<span class="muted">${k}</span><b>${esc(v)}</b>`).join('');
}

function renderDrc() {
  const ul = $('drc');
  ul.innerHTML = '';
  const errors = drc.filter((d) => d.kind !== 'warning');
  const cnt = $('drc-count');
  cnt.textContent = board ? (errors.length ? `${errors.length} issue(s)` : 'pass') : '';
  cnt.className = `pill ${board ? (errors.length ? 'bad' : 'ok') : ''}`;
  if (board && !errors.length) {
    const li = document.createElement('li');
    li.className = 'good';
    li.textContent = `All connections routed, no clearance violations (${board.settings.clearance} mm).`;
    ul.append(li);
  }
  for (const d of drc) {
    const li = document.createElement('li');
    li.className = d.kind;
    li.textContent = d.msg;
    if (d.x !== undefined) li.onclick = () => { activateTab('v2d'); view2d.markers = [{ x: d.x!, y: d.y! }]; view2d.draw(); };
    ul.append(li);
  }
}

function renderBom() {
  const el = $('bom-table');
  if (!board) { el.innerHTML = '<p class="muted">No design yet.</p>'; return; }
  const lines = bomLines(board);
  const missing = lines.filter((l) => !l.comp.lcsc).length;
  el.innerHTML = `<p class="muted">${lines.length} line items, ${board.comps.filter((c) => c.fp.body.kind !== 'hole').length} parts.
    ${missing ? `${missing} line(s) have no LCSC part number - fill them in for JLCPCB assembly (edits are saved into the design).` : ''}</p>
    <table><thead><tr><th>Designators</th><th>Qty</th><th>Value</th><th>Footprint</th><th>Manufacturer</th><th>MPN</th><th>LCSC #</th><th>Description</th></tr></thead><tbody>
    ${lines.map((l) => `<tr data-refs="${l.refs.join(',')}">
      <td class="mono">${esc(l.refs.join(', '))}</td><td>${l.refs.length}</td>
      <td><input data-f="value" value="${esc(l.comp.value)}" /></td><td class="mono">${esc(l.fp.id)}</td>
      <td><input data-f="manufacturer" value="${esc(l.comp.manufacturer)}" /></td>
      <td><input data-f="mpn" value="${esc(l.comp.mpn)}" /></td>
      <td><input data-f="lcsc" value="${esc(l.comp.lcsc)}" placeholder="C…" /></td>
      <td class="muted">${esc(l.comp.description)}</td></tr>`).join('')}
    </tbody></table>`;
  el.querySelectorAll('input').forEach((inp) => {
    inp.addEventListener('change', () => {
      const refs = (inp.closest('tr') as HTMLElement).dataset.refs!.split(',');
      const f = inp.dataset.f as 'value' | 'manufacturer' | 'mpn' | 'lcsc';
      for (const r of refs) {
        const dc = design?.components.find((c) => c.ref === r);
        if (dc) dc[f] = inp.value;
        const bc = board?.comps.find((c) => c.ref === r);
        if (bc) bc.comp[f] = inp.value;
      }
      if (design) localStorage.setItem(LS.design, JSON.stringify(design));
      $<HTMLTextAreaElement>('json-edit').value = JSON.stringify(design, null, 2);
      if (f === 'value') { silk = board ? buildSilk(board) : null; view3dDirty = true; }
    });
  });
}

function renderNets() {
  const el = $('net-table');
  if (!board) { el.innerHTML = '<p class="muted">No design yet.</p>'; return; }
  const pins = new Map<number, string[]>();
  for (const p of board.pads) if (p.net >= 0) {
    const a = pins.get(p.net) ?? [];
    const k = `${p.ref}.${p.pin}`;
    if (!a.includes(k)) a.push(k);
    pins.set(p.net, a);
  }
  el.innerHTML = `<table><thead><tr><th>Net</th><th>Class</th><th>Width</th><th>Pins</th></tr></thead><tbody>
    ${board.nets.map((n, i) => `<tr><td><b>${esc(n.name)}</b></td><td>${n.isGround ? 'Ground' : n.isPower ? 'Power' : 'Signal'}</td><td>${n.width} mm</td>
      <td class="mono">${esc((pins.get(i) ?? []).join('  '))}</td></tr>`).join('')}
    </tbody></table>`;
}

function renderFab() {
  const f = FABS[fab];
  document.querySelectorAll<HTMLButtonElement>('.fab-picker .seg').forEach((b) => b.classList.toggle('active', b.dataset.fab === fab));
  $('fab-name').textContent = f.name;
  $('fab-notes').innerHTML = f.notes.map((n) => `<li>${esc(n)}</li>`).join('');
  const a = $<HTMLAnchorElement>('fab-link');
  a.href = f.url;
  a.textContent = `Open ${f.name} order page ↗`;
  $('dl-pnp').textContent = fab === 'jlcpcb' ? '⬇ CPL / pick & place (.csv)' : fab === 'pcbway' ? '⬇ Centroid file (.csv)' : '⬇ Pick & place (.csv)';
}

// ---------------- downloads ----------------
function download(f: OutFile) {
  const blob = new Blob([f.content as BlobPart], { type: f.mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = f.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
async function exportFile(which: 'gerberZip' | 'bom' | 'pnp' | 'all') {
  if (!board) return;
  const errs = drc.filter((d) => d.kind === 'clearance' || d.kind === 'unrouted' || d.kind === 'edge').length;
  if (errs && which !== 'bom' && !confirm(`The design check reports ${errs} issue(s). Export anyway?`)) return;
  const pkg = await buildFabPackage(board, fab);
  download(pkg[which]);
  log(`Exported <b>${esc(pkg[which].name)}</b> for ${FABS[fab].name}`);
}

// ---------------- tabs ----------------
function activateTab(name: string) {
  document.querySelectorAll<HTMLButtonElement>('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll<HTMLElement>('.pane').forEach((p) => p.classList.toggle('active', p.id === `pane-${name}`));
  view3d.setActive(name === 'v3d');
  if (name === 'v3d') refresh3d();
  if (name === 'v2d') view2d.resize();
}

// ---------------- settings ----------------
function loadRules() {
  $<HTMLInputElement>('r-track').value = String(settings.trackWidth);
  $<HTMLInputElement>('r-power').value = String(settings.powerTrackWidth);
  $<HTMLInputElement>('r-clear').value = String(settings.clearance);
  $<HTMLInputElement>('r-via').value = String(settings.viaDiameter);
  $<HTMLInputElement>('r-drill').value = String(settings.viaDrill);
  $<HTMLSelectElement>('r-thick').value = String(settings.thickness);
  $<HTMLSelectElement>('r-finish').value = settings.finish;
  $<HTMLSelectElement>('r-mask').value = settings.maskColor;
  $<HTMLInputElement>('r-pour').checked = settings.groundPour;
}
function readRules() {
  const num = (id: string, min: number, def: number) => { const v = parseFloat($<HTMLInputElement>(id).value); return Number.isFinite(v) && v >= min ? v : def; };
  settings = {
    ...settings,
    trackWidth: num('r-track', 0.1, 0.25),
    powerTrackWidth: num('r-power', 0.1, 0.5),
    clearance: num('r-clear', 0.1, 0.2),
    viaDiameter: num('r-via', 0.45, 0.6),
    viaDrill: num('r-drill', 0.2, 0.3),
    thickness: parseFloat($<HTMLSelectElement>('r-thick').value),
    finish: $<HTMLSelectElement>('r-finish').value as 'HASL' | 'ENIG',
    maskColor: $<HTMLSelectElement>('r-mask').value,
    groundPour: $<HTMLInputElement>('r-pour').checked,
  };
  if (settings.viaDrill > settings.viaDiameter - 0.2) settings.viaDrill = Math.max(0.2, settings.viaDiameter - 0.3);
  localStorage.setItem(LS.settings, JSON.stringify(settings));
}

// ---------------- wiring ----------------
for (const ex of EXAMPLES) {
  const b = document.createElement('button');
  b.textContent = ex.label;
  b.title = ex.prompt;
  b.onclick = () => { $<HTMLTextAreaElement>('prompt').value = ex.prompt; $<HTMLInputElement>('refine').checked = false; };
  $('examples').append(b);
}
$('btn-generate').onclick = generate;
$('prompt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) generate(); });
$('btn-cancel').onclick = () => {
  abort?.abort();
  if (worker) { worker.terminate(); worker = null; }
  setBusy(false);
  setStatus('Cancelled.', 'idle');
};
$('btn-reroute').onclick = async () => {
  if (!design || busy) return;
  readRules();
  setBusy(true);
  try { await layout(design); } catch (e) { setStatus((e as Error).message, 'err'); } finally { setBusy(false); }
};
for (const id of ['r-mask', 'r-finish', 'r-thick']) $(id).addEventListener('change', () => {
  readRules();
  if (board) { board.settings.maskColor = settings.maskColor; board.settings.finish = settings.finish; board.settings.thickness = settings.thickness; view3dDirty = true; if ($('pane-v3d').classList.contains('active')) refresh3d(); }
});
for (const id of ['r-track', 'r-power', 'r-clear', 'r-via', 'r-drill', 'r-pour']) $(id).addEventListener('change', () => { readRules(); log('Design rules changed - press <b>Re-place &amp; re-route</b> to apply.'); });

document.querySelectorAll<HTMLButtonElement>('.tab').forEach((t) => (t.onclick = () => activateTab(t.dataset.tab!)));
document.querySelectorAll<HTMLButtonElement>('.fab-picker .seg').forEach((b) => (b.onclick = () => {
  const prev = fab;
  fab = b.dataset.fab as FabId;
  localStorage.setItem(LS.fab, fab);
  // switch to the fab's signature mask colour if the user was on the previous default
  if (settings.maskColor === FABS[prev].defaultMask && FABS[fab].defaultMask !== settings.maskColor) {
    settings.maskColor = FABS[fab].defaultMask;
    $<HTMLSelectElement>('r-mask').value = settings.maskColor;
    readRules();
    if (board) { board.settings.maskColor = settings.maskColor; view3dDirty = true; if ($('pane-v3d').classList.contains('active')) refresh3d(); }
  }
  renderFab();
}));
document.querySelectorAll<HTMLInputElement>('[data-layer]').forEach((c) => c.addEventListener('change', () => {
  view2d.layers[c.dataset.layer as keyof Layers2D] = c.checked;
  view2d.draw();
}));
$<HTMLInputElement>('flip2d').addEventListener('change', (e) => { view2d.flipped = (e.target as HTMLInputElement).checked; view2d.draw(); });
$('btn-fit').onclick = () => view2d.fit();
const pngName = () => `${(board?.design.name ?? 'board').replace(/\W+/g, '_')}`;
$('btn-png2d').onclick = () => { const a = document.createElement('a'); a.href = view2d.snapshot(); a.download = `${pngName()}_2d.png`; a.click(); };
$('btn-png3d').onclick = () => { const a = document.createElement('a'); a.href = view3d.snapshot(); a.download = `${pngName()}_3d.png`; a.click(); };
document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) => (b.onclick = () => view3d.view(b.dataset.view as 'iso' | 'top' | 'bottom')));
$<HTMLInputElement>('show-comps').addEventListener('change', (e) => view3d.showComponents((e.target as HTMLInputElement).checked));

$('dl-gerber').onclick = () => exportFile('gerberZip');
$('dl-bom').onclick = () => exportFile('bom');
$('dl-pnp').onclick = () => exportFile('pnp');
$('dl-all').onclick = () => exportFile('all');

$('btn-json-apply').onclick = async () => {
  if (busy) return;
  let d: Design;
  try { d = JSON.parse($<HTMLTextAreaElement>('json-edit').value); } catch (e) { setStatus(`Invalid JSON: ${(e as Error).message}`, 'err'); return; }
  if (!Array.isArray(d.components) || !Array.isArray(d.nets)) { setStatus('JSON needs "components" and "nets" arrays.', 'err'); return; }
  d.board ??= { width: 0, height: 0, cornerRadius: 1 };
  d.notes ??= [];
  d.name ??= 'board';
  d.description ??= '';
  for (const c of d.components) { c.value ??= ''; c.description ??= ''; c.manufacturer ??= ''; c.mpn ??= ''; c.lcsc ??= ''; }
  setBusy(true);
  try { await layout(d); log('Applied edited design JSON.'); } catch (e) { setStatus((e as Error).message, 'err'); } finally { setBusy(false); }
};
$('btn-json-load').onclick = () => $<HTMLInputElement>('json-file').click();
$<HTMLInputElement>('json-file').addEventListener('change', async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  $<HTMLTextAreaElement>('json-edit').value = await f.text();
  activateTab('json');
});

// settings dialog
const dlg = $<HTMLDialogElement>('settings');
const modelSel = $<HTMLSelectElement>('s-model');
modelSel.innerHTML = MODELS.map((m) => `<option value="${m.id}">${m.label}</option>`).join('');
$('btn-settings').onclick = () => { $<HTMLInputElement>('s-key').value = apiKey; modelSel.value = model; dlg.showModal(); };
$('ai-mode').onclick = () => $('btn-settings').click();
dlg.addEventListener('close', () => {
  if (dlg.returnValue === 'save') {
    apiKey = $<HTMLInputElement>('s-key').value.trim();
    model = modelSel.value;
    if (apiKey) localStorage.setItem(LS.key, apiKey); else localStorage.removeItem(LS.key);
    localStorage.setItem(LS.model, model);
  } else if (dlg.returnValue === 'clear') {
    apiKey = '';
    localStorage.removeItem(LS.key);
  }
  updateAiMode();
});

// ---------------- boot ----------------
loadRules();
renderFab();
updateAiMode();
setBoard(null);
const saved = localStorage.getItem(LS.design);
if (saved) {
  try {
    const d = JSON.parse(saved) as Design;
    setBusy(true);
    layout(d).then(() => log('Restored your last design.')).catch(() => undefined).finally(() => setBusy(false));
  } catch { /* ignore */ }
} else {
  $<HTMLTextAreaElement>('prompt').value = EXAMPLES[2].prompt;
}
