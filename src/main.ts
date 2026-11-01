import type { Session } from '@supabase/supabase-js';
import * as THREE from 'three';
import './style.css';
import { generateDesign, MODELS, validateApiKey } from './ai';
import { adminLogin, deleteCloudDesign, displayName, isAdminSession, listCloudDesigns, saveCloudDesign, sendMagicLink, signOut, supabase } from './cloud';
import { runDrc, runLvs, type DrcIssue } from './drc';
import { bomLines, buildFabPackage, FABS, type OutFile } from './export';
import { FOOTPRINT_IDS, getFootprint, resolvePin } from './footprints';
import { buildSchematic, schematicDownload, type Schematic } from './schematic';
import { buildSilk, type Silk } from './silk';
import { isStyleOnly, parseStyle } from './style';
import { EXAMPLES, offlineDesign } from './templates';
import { applyTransform, autoMove, boundsOf, checkFit, countTriangles, IDENTITY, loadModelBuffer, type FitResult, type MechModel, type MechTransform } from './mech';
import { simulate, STATUS_COLOR, STATUS_ICON, STATUS_RANK, type SimResult, type SimSource } from './sim';
import { SimView } from './simview';
import { DEFAULT_SETTINGS, type Board, type Design, type DesignStyle, type FabId, type Settings } from './types';
import { layerColor, layerName } from './stackup';
import { DRC_RUNS, REVIEW_PASSES, selfReview, type DrcRun, type ReviewPass } from './verify';
import { View2D, type Layers2D } from './view2d';
import { View3D } from './view3d';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const LS = { key: 'pcbx2.apiKey', model: 'pcbx2.model.v2', design: 'pcbx2.design', settings: 'pcbx2.settings', fab: 'pcbx2.fab', theme: 'pcbx2.theme' };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

// ---------------- state ----------------
let design: Design | null = null;
let board: Board | null = null;
let silk: Silk | null = null;
let drc: DrcIssue[] = [];
let schem: Schematic | null = null;
let session: Session | null = null;
let cloudId: string | undefined;
let fab: FabId = (localStorage.getItem(LS.fab) as FabId) || 'jlcpcb';
let settings: Settings = { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(LS.settings) || '{}') };
let apiKey = localStorage.getItem(LS.key) || '';
let model = localStorage.getItem(LS.model) || MODELS[0].id;
let busy = false;
let abort: AbortController | null = null;
let view3dDirty = true;
let selected: string | null = null;
const vstate: { reviews: ReviewPass[]; drc: DrcRun[]; running: string; stale: boolean; hasRun: boolean } = { reviews: [], drc: [], running: '', stale: false, hasRun: false };

const view2d = new View2D($<HTMLCanvasElement>('c2d'));
const view3d = new View3D($('c3d'));
const viewMech = new View3D($('c-mech'));
const simView = new SimView($<HTMLCanvasElement>('c-sim'));
view2d.onHover = (t) => ($('hover').textContent = t);

// ---------------- theme ----------------
function setTheme(t: 'dark' | 'light') {
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem(LS.theme, t);
  view3d.setTheme(t === 'dark');
  viewMech.setTheme(t === 'dark');
  view2d.draw();
  simView.draw();
}
const curTheme = () => (document.documentElement.getAttribute('data-theme') as 'dark' | 'light') || 'dark';
const toggleTheme = () => setTheme(curTheme() === 'dark' ? 'light' : 'dark');
$('btn-theme').onclick = toggleTheme;
$('a-theme').onclick = toggleTheme;
view3d.setTheme(curTheme() === 'dark');
viewMech.setTheme(curTheme() === 'dark');

// ---------------- worker ----------------
let worker: Worker | null = null;
let jobId = 0;
let rejectJob: ((e: Error) => void) | null = null;
function getWorker() {
  if (!worker) worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  return worker;
}
function runJob(kind: 'layout' | 'verify', d: Design, s: Settings, onRun?: (r: DrcRun) => void): Promise<{ board: Board }> {
  const id = ++jobId;
  const w = getWorker();
  return new Promise((resolve, reject) => {
    rejectJob = reject;
    const done = () => { w.removeEventListener('message', onMsg); rejectJob = null; };
    const onMsg = (e: MessageEvent) => {
      if (e.data.id !== id) return;
      const t = e.data.type;
      if (t === 'progress') { setProgress(e.data.fraction); setStatus(e.data.msg, 'busy'); return; }
      if (t === 'run') { onRun?.(e.data.run as DrcRun); return; }
      done();
      if (t === 'done') resolve({ board: e.data.board as Board });
      else reject(new Error(e.data.message));
    };
    w.addEventListener('message', onMsg);
    w.addEventListener('error', (ev) => { done(); reject(new Error(ev.message || 'Layout worker crashed')); }, { once: true });
    w.postMessage({ id, kind, design: d, settings: s });
  });
}

// ---------------- UI helpers ----------------
let statusMsg = '';
let busySince = 0;
let busyTicker: ReturnType<typeof setInterval> | undefined;
function fmtElapsed(ms: number) { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
function renderStatus(kind: string) {
  $('status').textContent = kind === 'busy' && busySince ? `${statusMsg}  ⏱ ${fmtElapsed(Date.now() - busySince)}` : statusMsg;
}
function setStatus(msg: string, kind: 'idle' | 'busy' | 'err' | 'ok' = 'idle') {
  statusMsg = msg;
  $('status').className = `status ${kind}`;
  renderStatus(kind);
}
function setProgress(f: number) { $('progress-bar').style.width = `${Math.round(Math.max(0, Math.min(1, f)) * 100)}%`; }
function say(html: string, who: 'ai' | 'user' | 'sys' = 'ai', cls = '') {
  const d = document.createElement('div');
  d.className = `msg ${who} ${cls}`.trim();
  d.innerHTML = html;
  const chat = $('chat');
  chat.append(d);
  chat.scrollTop = chat.scrollHeight;
}
/** Short assistant note in the chat. */
function log(html: string) { say(html, 'ai'); }
function setBusy(on: boolean) {
  busy = on;
  for (const id of ['btn-generate', 'btn-reroute', 'btn-json-apply', 'e-add', 'sch-regen']) $<HTMLButtonElement>(id).disabled = on;
  $('btn-cancel').classList.toggle('hidden', !on);
  clearInterval(busyTicker);
  if (on) {
    busySince = Date.now();
    busyTicker = setInterval(() => { if ($('status').classList.contains('busy')) renderStatus('busy'); }, 1000);
  } else { busySince = 0; setProgress(0); }
}
function updateAiMode() {
  const el = $('ai-mode');
  if (apiKey) { el.textContent = `● ${MODELS.find((m) => m.id === model)?.label.split(' (')[0] ?? model}`; el.className = 'pill ok'; }
  else { el.textContent = 'Demo mode · add Claude key'; el.className = 'pill'; }
  $('demo-banner').classList.toggle('hidden', !!apiKey);
}

// ---------------- auth ----------------
const authMsg = (t: string, kind: 'err' | 'ok' | '' = '') => { const el = $('a-msg'); el.textContent = t; el.className = `amsg ${kind}`; };
document.querySelectorAll<HTMLButtonElement>('[data-atab]').forEach((b) => (b.onclick = () => {
  document.querySelectorAll<HTMLButtonElement>('[data-atab]').forEach((x) => x.classList.toggle('active', x === b));
  $('form-email').classList.toggle('hidden', b.dataset.atab !== 'email');
  $('form-admin').classList.toggle('hidden', b.dataset.atab !== 'admin');
  authMsg('');
}));
$<HTMLFormElement>('form-email').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $<HTMLButtonElement>('a-send');
  btn.disabled = true;
  authMsg('Sending…');
  try {
    const sent = await sendMagicLink($<HTMLInputElement>('a-email').value);
    authMsg(`Sign-in link sent to ${sent}. Open that inbox (check spam) and click the link.`, 'ok');
    setTimeout(() => (btn.disabled = false), 30_000);
  } catch (err) {
    authMsg((err as Error).message, 'err');
    btn.disabled = false;
  }
});
$<HTMLFormElement>('form-admin').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $<HTMLButtonElement>('a-login');
  btn.disabled = true;
  authMsg('Signing in…');
  try {
    await adminLogin($<HTMLInputElement>('a-user').value, $<HTMLInputElement>('a-pass').value);
    authMsg('');
  } catch (err) { authMsg((err as Error).message, 'err'); }
  btn.disabled = false;
});
$('btn-logout').onclick = async () => { await signOut(); };

let booted = false;
function applySession(s: Session | null) {
  session = s;
  $('auth').classList.toggle('hidden', !!s);
  $('user-name').textContent = displayName(s);
  $('admin-badge').classList.toggle('hidden', !isAdminSession(s));
  $('btn-logout').classList.toggle('hidden', !s);
  if (s && !booted) { booted = true; bootApp(); }
  if (s && location.hash.includes('access_token')) history.replaceState(null, '', location.pathname + location.search);
  if (s) refreshCloud().catch(() => undefined);
}
supabase.auth.onAuthStateChange((_ev, s) => applySession(s));
void supabase.auth.getSession().then(({ data }) => applySession(data.session));

// ---------------- style (colours / finish) ----------------
function setSelectOrCustom(sel: HTMLSelectElement, hex: string) {
  if (![...sel.options].some((o) => o.value.toLowerCase() === hex.toLowerCase())) {
    let o = sel.querySelector<HTMLOptionElement>('option[data-custom]');
    if (!o) { o = document.createElement('option'); o.dataset.custom = '1'; sel.append(o); }
    o.value = hex; o.textContent = `Custom ${hex}`;
  }
  sel.value = hex;
}
function syncStyleControls() {
  setSelectOrCustom($<HTMLSelectElement>('r-mask'), settings.maskColor);
  $<HTMLInputElement>('r-maskc').value = settings.maskColor;
  setSelectOrCustom($<HTMLSelectElement>('r-silk'), settings.silkColor);
  $<HTMLInputElement>('r-silkc').value = settings.silkColor;
  $<HTMLSelectElement>('r-finish').value = settings.finish;
}
function applyStyle(st: DesignStyle) {
  if (st.maskColor) settings.maskColor = st.maskColor;
  if (st.silkColor) settings.silkColor = st.silkColor;
  if (st.finish) settings.finish = st.finish;
  localStorage.setItem(LS.settings, JSON.stringify(settings));
  syncStyleControls();
  if (design) design.style = { ...design.style, ...st };
  if (board) {
    Object.assign(board.settings, { maskColor: settings.maskColor, silkColor: settings.silkColor, finish: settings.finish });
    silk = buildSilk(board);
    view2d.silk = silk;
    view2d.draw();
    view3dDirty = true;
    if ($('pane-v3d').classList.contains('active')) refresh3d();
  }
}

// ---------------- core flow ----------------

async function generate() {
  if (busy) return;
  const prompt = $<HTMLTextAreaElement>('prompt').value.trim();
  if (!prompt) { setStatus('Type a description first.', 'err'); return; }
  const refine = $<HTMLInputElement>('refine').checked && !!design;
  say(esc(prompt), 'user');
  $<HTMLTextAreaElement>('prompt').value = '';
  // purely cosmetic request on an existing board: restyle instantly, no re-design needed
  if (design && board && isStyleOnly(prompt)) {
    const st = parseStyle(prompt);
    applyStyle(st);
    say(`🎨 Done — ${[st.maskColor && 'board colour', st.silkColor && 'text colour', st.finish && 'pad finish'].filter(Boolean).join(' and ')} updated. Check the 3D tab!`, 'ai', 'ok');
    setStatus('Board colour updated.', 'ok');
    return;
  }
  // "make it 4 layers": just re-route with a new layer count, no redesign needed
  const lm = prompt.match(/\b(2|4|6|8|10)[ -]?layers?\b/i);
  if (design && board && lm && prompt.length < 70 && !/\b(add|remove|replace|connect|esp32|usb|button|led)\b/i.test(prompt)) {
    settings.layers = +lm[1];
    localStorage.setItem(LS.settings, JSON.stringify(settings));
    loadRules();
    setBusy(true);
    try {
      const d: Design = JSON.parse(JSON.stringify(design));
      freeze(d);
      d.board.layers = settings.layers;
      say(`Switching to <b>${settings.layers} layers</b> and re-routing…`);
      await verifyAndShow(d, false);
    } catch (e) { setStatus((e as Error).message, 'err'); say(esc((e as Error).message), 'ai', 'err'); } finally { setBusy(false); }
    return;
  }
  setBusy(true);
  abort = new AbortController();
  vstate.reviews = []; vstate.drc = []; vstate.stale = false; vstate.hasRun = false; vstate.running = '';
  try {
    let d: Design;
    if (apiKey) {
      d = await generateDesign({ apiKey, model, prompt, current: refine ? design : null, signal: abort.signal, onProgress: (m) => setStatus(m, 'busy') });
    } else {
      if (refine) say('Demo mode can’t edit an existing design, so I’ll build a new one. Add your Claude API key (⚙) to edit boards by chatting.', 'ai', 'err');
      const r = offlineDesign(prompt);
      d = r.design;
      say(`Demo mode: I matched your request to my <b>${esc(r.matched)}</b> template. (With a Claude key I can design anything.)`, 'sys');
    }
    if (!refine) { cloudId = undefined; for (const c of d.components) { c.x = null; c.y = null; } }
    // appearance: what the user typed wins over what the AI inferred
    const st = { ...d.style, ...parseStyle(prompt) };
    if (st.maskColor || st.silkColor || st.finish) { applyStyle(st); log(`Board style: ${Object.values(st).filter(Boolean).join(' · ')}`); }
    say(`I designed <b>${esc(d.name)}</b>: ${d.components.length} parts, ${d.nets.length} connections, ${(d.labels ?? []).length} labels.${(d.notes ?? []).length ? `<br><span class="muted">${(d.notes ?? []).map(esc).join('<br>')}</span>` : ''}`);

    // --- 3 self-review passes ---
    vstate.running = 'review'; renderVerify();
    const rv = await selfReview(d, {
      apiKey: apiKey || undefined, model, signal: abort.signal,
      onProgress: (m) => setStatus(m, 'busy'),
      onPass: (p) => {
        vstate.reviews.push(p); renderVerify(); setProgress(p.pass / REVIEW_PASSES / 2);
        setStatus(`Self-review ${p.pass}/${REVIEW_PASSES} done`, 'busy');
      },
    });
    d = rv.design;
    design = d;

    // --- 5 DRC runs (worker) ---
    await verifyAndShow(d, true);
    localStorage.setItem(LS.design, JSON.stringify(design));
  } catch (e) {
    setStatus((e as Error).message, 'err');
    log(`<span style="color:var(--danger)">Error:</span> ${esc((e as Error).message)}`);
  } finally {
    abort = null;
    vstate.running = '';
    renderVerify();
    setBusy(false);
  }
}

/** Run place+route+DRC+LVS 5x in the worker and show the best board. */
async function verifyAndShow(d: Design, fresh: boolean) {
  setStatus('Placing, routing and running DRC…', 'busy');
  vstate.running = 'drc'; vstate.drc = []; renderVerify();
  const t0 = performance.now();
  const r = await runJob('verify', d, settings, (run) => {
    vstate.drc.push(run); renderVerify();
    setStatus(`Design check ${run.run}/${DRC_RUNS} done`, 'busy');
  });
  design = d;
  vstate.stale = false; vstate.hasRun = true; vstate.running = '';
  setBoard(r.board, !fresh);
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  const errs = drc.filter((x) => x.kind !== 'warning').length;
  if (errs) { setStatus(`Done in ${secs}s - ${errs} issue(s) remain. See Health checks.`, 'err'); say(`⚠ The board is built but ${errs} issue(s) remain — see <b>Health checks</b> on the right. Try a bigger board or more layers.`, 'ai', 'err'); }
  else { setStatus(`Done in ${secs}s - ${r.board.layers}-layer board passed ${REVIEW_PASSES} reviews and ${DRC_RUNS} DRC runs. Ready to export.`, 'ok'); say(`✅ <b>Your board is ready</b> — ${r.board.width.toFixed(0)} × ${r.board.height.toFixed(0)} mm, ${r.board.layers} layers, ${r.board.tracks.length} wires. It passed ${REVIEW_PASSES} self-reviews and ${DRC_RUNS} design checks.<br><span class="muted">Next: spin it in <b>3D</b>, then try <b>Test power &amp; heat</b>.</span>`, 'ai', 'ok'); }
  renderVerify();
}

/** Single quick layout pass (used after manual edits). */
async function relayout(d: Design, msg?: string) {
  setStatus(msg ?? 'Re-routing…', 'busy');
  const r = await runJob('layout', d, settings);
  design = d;
  vstate.stale = true;
  setBoard(r.board, true);
  const errs = drc.filter((x) => x.kind !== 'warning').length;
  setStatus(errs ? `Updated - ${errs} issue(s) in Design check.` : 'Updated - no issues. Re-verify runs automatically on export.', errs ? 'err' : 'ok');
  localStorage.setItem(LS.design, JSON.stringify(d));
  renderVerify();
}

function setBoard(b: Board | null, keepView = false) {
  board = b;
  if (b) Object.assign(b.settings, { maskColor: settings.maskColor, silkColor: settings.silkColor, finish: settings.finish });
  silk = b ? buildSilk(b) : null;
  drc = b ? runDrc(b) : [];
  view2d.markers = drc.filter((d) => d.kind !== 'warning' && d.x !== undefined).map((d) => ({ x: d.x!, y: d.y! }));
  view2d.selected = selected && b?.comps.some((c) => c.ref === selected) ? selected : null;
  if (!view2d.selected) selected = null;
  view2d.setBoard(b, silk, keepView);
  renderLayerToggles();
  view3dDirty = true;
  if ($('pane-v3d').classList.contains('active')) refresh3d();
  if ($('pane-sch').classList.contains('active')) renderSchematic();
  else schem = null;
  renderStats(); renderDrc(); renderBom(); renderNets(); renderSel();
  onBoardChangedForTabs();
  renderChrome();
  $<HTMLTextAreaElement>('json-edit').value = design ? JSON.stringify(design, null, 2) : '';
  for (const id of ['dl-gerber', 'dl-bom', 'dl-pnp', 'dl-all']) $<HTMLButtonElement>(id).disabled = !b;
  if (b && design) { $<HTMLInputElement>('r-bw').value = String(design.board.width || 0); $<HTMLInputElement>('r-bh').value = String(design.board.height || 0); $<HTMLInputElement>('r-corner').value = String(design.board.cornerRadius ?? 1); }
}

function renderLayerToggles() {
  const b = board;
  const box = $('layer-toggles');
  const sel = $<HTMLSelectElement>('active-layer');
  if (!b) { box.innerHTML = ''; sel.innerHTML = ''; return; }
  const NL = b.layers;
  if (view2d.visibleLayers.length !== NL) view2d.visibleLayers = Array.from({ length: NL }, (_, l) => l === 0 || l === NL - 1);
  box.innerHTML = Array.from({ length: NL }, (_, l) => `<label class="chk" title="${b.stack[l] === 'S' ? 'signal layer' : b.stack[l] === 'G' ? 'ground plane' : 'power plane'}"><input type="checkbox" data-lyr="${l}" ${view2d.visibleLayers[l] ? 'checked' : ''}/> <i class="sw" style="background:${layerColor(l, NL)}"></i>${layerName(l, NL)}<span class="muted small">${b.stack[l] === 'S' ? '' : b.stack[l]}</span></label>`).join('');
  box.querySelectorAll<HTMLInputElement>('[data-lyr]').forEach((c) => c.addEventListener('change', () => { view2d.visibleLayers[+c.dataset.lyr!] = c.checked; view2d.draw(); }));
  sel.innerHTML = Array.from({ length: NL }, (_, l) => `<option value="${l}">${layerName(l, NL)}</option>`).join('');
  sel.value = String(Math.min(view2d.activeLayer, NL - 1));
}
$('active-layer').addEventListener('change', (e) => { view2d.activeLayer = +(e.target as HTMLSelectElement).value; view2d.draw(); });

function refresh3d() {
  if (!view3dDirty) return;
  view3dDirty = false;
  view3d.setBoard(board, silk);
}

// ---------------- editing ----------------
/** Freeze the current placement and board size into the design so manual edits only change what the user touched. */
function freeze(d: Design) {
  if (!board) return;
  for (const c of board.comps) {
    const dc = d.components.find((x) => x.ref === c.ref);
    if (dc) { dc.x = c.x; dc.y = c.y; dc.rotation = c.rot; }
  }
  d.board.width = board.width;
  d.board.height = board.height;
}
async function edit(mut: (d: Design) => void, msg: string) {
  if (!design || !board || busy) return;
  const d: Design = JSON.parse(JSON.stringify(design));
  freeze(d);
  mut(d);
  setBusy(true);
  try { await relayout(d, msg); } catch (e) { setStatus((e as Error).message, 'err'); } finally { setBusy(false); }
}
view2d.onMove = (ref, x, y) => void edit((d) => { const c = d.components.find((q) => q.ref === ref); if (c) { c.x = x; c.y = y; } }, `Moving ${ref} and re-routing…`);
view2d.onSelect = (ref) => { selected = ref; renderSel(); };
view3d.onPick = (ref) => { selected = ref; view2d.selected = ref; view2d.draw(); renderSel(); };

function renderSel() {
  const c = selected ? board?.comps.find((q) => q.ref === selected) : undefined;
  $('sel-info').textContent = c ? `${c.ref} · ${c.comp.value} · ${c.fp.id} · (${c.x.toFixed(1)}, ${c.y.toFixed(1)}) ${c.rot}°` : 'Drag a part to move it · click to select';
  $<HTMLButtonElement>('e-rot').disabled = !c || busy;
  $<HTMLButtonElement>('e-del').disabled = !c || busy;
}
const rotateSel = () => { const ref = selected; if (ref) void edit((d) => { const c = d.components.find((q) => q.ref === ref); if (c) c.rotation = (((c.rotation ?? 0) + 90) % 360); }, `Rotating ${ref}…`); };
const deleteSel = () => {
  const ref = selected;
  if (!ref) return;
  selected = null;
  void edit((d) => {
    d.components = d.components.filter((c) => c.ref !== ref);
    d.nets = d.nets.map((n) => ({ ...n, pins: n.pins.filter((p) => !p.startsWith(`${ref}.`)) })).filter((n) => n.pins.length > 0);
    d.labels = (d.labels ?? []).filter((l) => l.ref !== ref);
  }, `Removing ${ref}…`);
};
$('e-rot').onclick = rotateSel;
$('e-del').onclick = deleteSel;
const REF_PREFIX = (fp: string) => /^R_/.test(fp) ? 'R' : /^(C_|CP_)/.test(fp) ? 'C' : /^L_/.test(fp) ? 'L' : /^(LED_|D_)/.test(fp) ? 'D' : /^F_/.test(fp) ? 'F' : /^SW_/.test(fp) ? 'SW' : /^Crystal/.test(fp) ? 'Y' : /^(PinHeader|JST|Terminal|USB)/.test(fp) ? 'J' : /^TO-/.test(fp) ? 'Q' : /^Mounting/.test(fp) ? 'H' : /^SOT-23$/.test(fp) ? 'Q' : 'U';
$('e-add').onclick = () => {
  const fpId = $<HTMLSelectElement>('e-fp').value;
  const fp = getFootprint(fpId);
  if (!fp || !design) return;
  const value = $<HTMLInputElement>('e-val').value.trim() || fp.id;
  void edit((d) => {
    const pre = REF_PREFIX(fp.id);
    let n = 1;
    while (d.components.some((c) => c.ref === `${pre}${n}`)) n++;
    d.components.push({ ref: `${pre}${n}`, footprint: fp.id, value, description: 'Added manually', manufacturer: '', mpn: '', lcsc: '', x: d.board.width / 2, y: d.board.height / 2, rotation: 0 });
    selected = `${pre}${n}`;
  }, 'Adding part…');
};
window.addEventListener('keydown', (e) => {
  if (!$('pane-v2d').classList.contains('active') || !selected || busy) return;
  const t = e.target as HTMLElement;
  if (/INPUT|TEXTAREA|SELECT/.test(t.tagName)) return;
  if (e.key === 'r' || e.key === 'R') { e.preventDefault(); rotateSel(); }
  else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSel(); }
  else if (e.key === 'Escape') { selected = null; view2d.selected = null; view2d.draw(); renderSel(); }
  else if (e.key.startsWith('Arrow')) {
    e.preventDefault();
    const step = e.shiftKey ? 2 : 0.5, ref = selected;
    const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0, dy = e.key === 'ArrowDown' ? -step : e.key === 'ArrowUp' ? step : 0;
    void edit((d) => { const c = d.components.find((q) => q.ref === ref); if (c) { c.x = (c.x ?? 0) + dx; c.y = (c.y ?? 0) + dy; } }, `Nudging ${ref}…`);
  }
});

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
    ['Layers', `${b.layers} (${b.stack.join('')}) · ${b.settings.thickness} mm · ${b.settings.finish}`],
    ['Parts', `${smd} SMD · ${tht} THT`],
    ['Nets', String(b.nets.length)],
    ['Tracks', `${b.tracks.length} · ${(len / 10).toFixed(1)} cm`],
    ['Vias', String(b.vias.length)],
    ['Labels', String((b.design.labels ?? []).length)],
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
    li.textContent = `Clean: all connections routed, copper matches the netlist (no shorts/opens), clearance ≥ ${board.settings.clearance} mm.`;
    ul.append(li);
  }
  for (const d of drc) {
    const li = document.createElement('li');
    li.className = d.kind === 'lvs' || d.kind === 'courtyard' ? 'clearance' : d.kind;
    li.textContent = d.msg;
    if (d.x !== undefined) li.onclick = () => { activateTab('v2d'); view2d.markers = [{ x: d.x!, y: d.y! }]; view2d.draw(); };
    ul.append(li);
  }
}

function renderVerify() {
  const el = $('verify');
  const pill = $('verify-pill');
  const okDrc = vstate.drc.length === DRC_RUNS && vstate.drc.every((r) => r.errors === 0);
  const verified = vstate.hasRun && !vstate.stale && vstate.reviews.length >= REVIEW_PASSES && okDrc;
  pill.textContent = vstate.running ? 'running…' : vstate.stale ? 'stale' : verified ? 'verified ✓' : vstate.hasRun ? 'issues' : '';
  pill.className = `pill ${vstate.running ? '' : vstate.stale ? '' : verified ? 'ok' : vstate.hasRun ? 'bad' : ''}`;
  renderCoach();
  if (!vstate.reviews.length && !vstate.drc.length && !vstate.running) { el.innerHTML = '<div class="muted small">AI review ×3 and DRC ×5 run after every generation.</div>'; return; }
  const rows: string[] = [];
  for (let i = 1; i <= REVIEW_PASSES; i++) {
    const r = vstate.reviews[i - 1];
    rows.push(r
      ? `<div class="vstep ${r.errorsAfter ? 'bad' : 'ok'}">Review ${i}/${REVIEW_PASSES} · ${r.source === 'ai' ? 'AI' : 'rules'}<small>${r.errorsBefore} → ${r.errorsAfter} error(s)${r.fixes.length ? ` · ${r.fixes.length} fix(es)` : ''}${r.rejected ? ' · edit rejected' : ''}</small></div>`
      : `<div class="vstep ${vstate.running === 'review' && vstate.reviews.length === i - 1 ? 'run' : ''}">Review ${i}/${REVIEW_PASSES}<small>${vstate.running === 'review' && vstate.reviews.length === i - 1 ? 'running…' : 'pending'}</small></div>`);
  }
  for (let i = 1; i <= DRC_RUNS; i++) {
    const r = vstate.drc[i - 1];
    rows.push(r
      ? `<div class="vstep ${r.errors ? 'bad' : 'ok'}">DRC run ${i}/${DRC_RUNS}<small>${r.errors ? `${r.errors} issue(s): ${esc(r.messages[0] ?? '')}` : 'clean'} · ${r.boardSize}</small></div>`
      : `<div class="vstep ${vstate.running === 'drc' && vstate.drc.length === i - 1 ? 'run' : ''}">DRC run ${i}/${DRC_RUNS}<small>${vstate.running === 'drc' && vstate.drc.length === i - 1 ? 'running…' : 'pending'}</small></div>`);
  }
  el.innerHTML = rows.join('') + (vstate.stale ? '<div class="muted small" style="margin:6px 0">Edited since the last check. <button class="ghost sm" id="v-rerun">Re-run 5× DRC</button></div>' : '');
  const b = document.getElementById('v-rerun');
  if (b) b.onclick = () => void reverify();
}
async function reverify(): Promise<boolean> {
  if (!design || busy) return false;
  setBusy(true);
  try {
    const d: Design = JSON.parse(JSON.stringify(design));
    freeze(d);
    await verifyAndShow(d, false);
    return drc.filter((x) => x.kind !== 'warning').length === 0;
  } catch (e) { setStatus((e as Error).message, 'err'); return false; } finally { setBusy(false); }
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
      if (f === 'value') { silk = board ? buildSilk(board) : null; view3dDirty = true; schem = null; }
    });
  });
}

/** Netlist tab doubles as a net editor: remove pins, add pins, create nets. */
function renderNets() {
  const el = $('net-table');
  if (!board || !design) { el.innerHTML = '<p class="muted">No design yet.</p>'; return; }
  const pins = new Map<number, string[]>();
  for (const p of board.pads) if (p.net >= 0) {
    const a = pins.get(p.net) ?? [];
    const k = `${p.ref}.${p.pin}`;
    if (!a.includes(k)) a.push(k);
    pins.set(p.net, a);
  }
  el.innerHTML = `<p class="muted small">Edit connectivity: remove a pin with ×, add <code>REF.PIN</code> (e.g. <code>U1.IO4</code>) to a net, or create a new net. The board re-routes automatically.</p>
  <table><thead><tr><th>Net</th><th>Class</th><th>Pins</th></tr></thead><tbody>
    ${board.nets.map((n, i) => `<tr data-net="${esc(n.name)}"><td><b>${esc(n.name)}</b><div class="muted small">${n.width} mm</div></td><td>${n.isGround ? 'Ground' : n.isPower ? 'Power' : 'Signal'}</td>
      <td><div class="chips">${(pins.get(i) ?? []).map((p) => `<span class="chip">${esc(p)}<button data-rm="${esc(p)}" title="Remove from net">×</button></span>`).join('')}
      <input class="addpin" placeholder="+ REF.PIN" data-add="${esc(n.name)}" /></div></td></tr>`).join('')}
    <tr><td><input class="addpin" id="newnet-name" placeholder="new net name" /></td><td></td><td><input class="addpin" id="newnet-pin" placeholder="first REF.PIN" /></td></tr>
    </tbody></table>`;
  el.querySelectorAll<HTMLButtonElement>('[data-rm]').forEach((b) => (b.onclick = () => {
    const pin = b.dataset.rm!, net = (b.closest('tr') as HTMLElement).dataset.net!;
    void edit((d) => { const n = d.nets.find((q) => q.name === net); if (n) { const [ref, id] = pin.split('.'); const fp = getFootprint(d.components.find((c) => c.ref === ref)?.footprint ?? ''); n.pins = n.pins.filter((p) => { const [r, i] = p.split('.'); return !(r === ref && (i === id || (fp && resolvePin(fp, i) === id))); }); } d.nets = d.nets.filter((q) => q.pins.length); }, `Disconnecting ${pin}…`);
  }));
  const addPin = (net: string, raw: string): string | null => {
    const m = raw.trim().match(/^([^.\s]+)\.(.+)$/);
    if (!m || !design) return 'Use the form REF.PIN, e.g. U1.IO4';
    const c = design.components.find((q) => q.ref.toLowerCase() === m[1].toLowerCase());
    if (!c) return `No component ${m[1]}`;
    const fp = getFootprint(c.footprint);
    if (!fp || !resolvePin(fp, m[2])) return `${c.ref} (${c.footprint}) has no pin "${m[2]}"`;
    void edit((d) => {
      const id = resolvePin(fp, m[2])!;
      for (const n of d.nets) n.pins = n.pins.filter((p) => { const [r, i] = p.split('.'); return !(r === c.ref && resolvePin(fp, i) === id); });
      const t = d.nets.find((q) => q.name.toLowerCase() === net.toLowerCase());
      if (t) t.pins.push(`${c.ref}.${m[2]}`); else d.nets.push({ name: net, pins: [`${c.ref}.${m[2]}`] });
      d.nets = d.nets.filter((q) => q.pins.length);
    }, `Connecting ${c.ref}.${m[2]} to ${net}…`);
    return null;
  };
  el.querySelectorAll<HTMLInputElement>('[data-add]').forEach((inp) => inp.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !inp.value.trim()) return;
    const err = addPin(inp.dataset.add!, inp.value);
    if (err) { inp.style.borderColor = 'var(--danger)'; inp.title = err; setStatus(err, 'err'); }
  }));
  const nn = $<HTMLInputElement>('newnet-name'), np = $<HTMLInputElement>('newnet-pin');
  np.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !nn.value.trim() || !np.value.trim()) return;
    const err = addPin(nn.value.trim(), np.value);
    if (err) setStatus(err, 'err');
  });
}

function renderFab() {
  const f = FABS[fab];
  document.querySelectorAll<HTMLButtonElement>('.fab-picker .seg').forEach((b) => b.classList.toggle('active', b.dataset.fab === fab));
  $('fab-name').textContent = f.name;
  $('fab-notes').innerHTML = f.notes.map((n) => `<li>${esc(n)}</li>`).join('');
  const a = $<HTMLAnchorElement>('fab-link');
  a.href = f.url;
  a.textContent = `Open ${f.name} order page ↗`;
  $('dl-pnp').textContent = fab === 'jlcpcb' ? '⬇ Part positions (CPL)' : fab === 'pcbway' ? '⬇ Part positions (centroid)' : '⬇ Part positions';
}

// ---------------- schematic ----------------
let schVb = { x: 0, y: 0, w: 100, h: 100 };
function renderSchematic() {
  const wrap = $('sch-wrap');
  if (!board) { wrap.innerHTML = '<p class="muted" style="padding:16px">No board yet.</p>'; return; }
  schem = buildSchematic(board);
  wrap.innerHTML = schem.svg;
  const svg = wrap.querySelector('svg')!;
  svg.removeAttribute('width'); svg.removeAttribute('height');
  schVb = { x: 0, y: 0, w: schem.width, h: schem.height };
  fitSchematic();
  const lvs = runLvs(board);
  $('sch-info').textContent = `${schem.symbols} symbols · ${board.nets.length} nets · PCB ↔ schematic: ${lvs.length ? `${lvs.length} mismatch(es)` : 'match ✓ (no shorts/opens)'}`;
  svg.addEventListener('click', (e) => {
    const t = e.target as Element;
    const net = t.closest('[data-net]')?.getAttribute('data-net');
    svg.querySelectorAll('.hl').forEach((x) => x.classList.remove('hl'));
    if (net) svg.querySelectorAll(`[data-net="${net}"]`).forEach((x) => x.classList.add('hl'));
    const sym = t.closest('[data-ref]')?.getAttribute('data-ref');
    if (sym) { selected = sym; view2d.selected = sym; view2d.draw(); renderSel(); svg.querySelectorAll('.sel').forEach((x) => x.classList.remove('sel')); t.closest('[data-ref]')!.classList.add('sel'); }
  });
}
function applySchVb() { const svg = $('sch-wrap').querySelector('svg'); if (svg) svg.setAttribute('viewBox', `${schVb.x} ${schVb.y} ${schVb.w} ${schVb.h}`); }
function fitSchematic() {
  if (!schem) return;
  const wrap = $('sch-wrap');
  const ar = wrap.clientWidth / Math.max(1, wrap.clientHeight);
  const w = Math.max(schem.width, schem.height * ar), h = w / ar;
  schVb = { x: (schem.width - w) / 2, y: 0, w, h };
  applySchVb();
}
{
  const wrap = $('sch-wrap');
  let drag: { x: number; y: number; vx: number; vy: number } | null = null;
  wrap.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = wrap.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
    const f = Math.exp(e.deltaY * 0.0015);
    const nw = schVb.w * f, nh = schVb.h * f;
    schVb = { x: schVb.x + (schVb.w - nw) * px, y: schVb.y + (schVb.h - nh) * py, w: nw, h: nh };
    applySchVb();
  }, { passive: false });
  wrap.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, vx: schVb.x, vy: schVb.y }; });
  wrap.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const r = wrap.getBoundingClientRect();
    schVb.x = drag.vx - ((e.clientX - drag.x) / r.width) * schVb.w;
    schVb.y = drag.vy - ((e.clientY - drag.y) / r.height) * schVb.h;
    applySchVb();
  });
  window.addEventListener('pointerup', () => (drag = null));
  wrap.addEventListener('dblclick', fitSchematic);
}
$('sch-regen').onclick = () => { renderSchematic(); log('Schematic regenerated from the current PCB.'); };
$('sch-fit').onclick = fitSchematic;
$('sch-dl').onclick = () => { if (schem) download({ name: `${(board?.design.name ?? 'board').replace(/\W+/g, '_')}_schematic.svg`, content: schematicDownload(schem, curTheme() === 'dark'), mime: 'image/svg+xml' }); };

// ---------------- downloads / export ----------------
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
  if (!board || !design || busy) return;
  // Every export re-runs the 5x DRC on the current design first.
  if (fab === 'oshpark' && board.layers > 4 && !confirm(`OSH Park only builds 2- and 4-layer boards; this design has ${board.layers} layers. Export anyway (e.g. to send to another fab)?`)) return;
  const ok = await reverify();
  if (!board) return;
  const errs = drc.filter((d) => d.kind !== 'warning').length;
  if (!ok && errs && !confirm(`DRC still reports ${errs} issue(s). Export anyway?`)) return;
  const pkg = await buildFabPackage(board, fab);
  download(pkg[which]);
  exported = true; renderCoach();
  say(`⬇ Downloaded <b>${esc(pkg[which].name)}</b> for ${FABS[fab].name}. Upload it on their website to order.`, 'ai', 'ok');
}

// ---------------- cloud ----------------
async function refreshCloud() {
  const list = $('cloud-list');
  if (!session) return;
  const admin = isAdminSession(session);
  $('cloud-info').textContent = admin ? 'Admin: you can see and manage every user’s designs.' : 'Your saved designs.';
  try {
    const rows = await listCloudDesigns();
    list.innerHTML = rows.length
      ? `<table><thead><tr><th>Name</th>${admin ? '<th>Owner</th>' : ''}<th>Parts</th><th>Updated</th><th></th></tr></thead><tbody>${rows.map((r) => `<tr><td><b>${esc(r.name)}</b></td>${admin ? `<td class="mono">${esc(r.owner.slice(0, 8))}</td>` : ''}<td>${r.design.components?.length ?? 0}</td><td>${new Date(r.updated_at).toLocaleString()}</td><td><button class="ghost sm" data-open="${r.id}">Open</button> <button class="ghost sm" data-del="${r.id}">Delete</button></td></tr>`).join('')}</tbody></table>`
      : '<p class="muted">Nothing saved yet. Generate a board and press “Save current design”.</p>';
    list.querySelectorAll<HTMLButtonElement>('[data-open]').forEach((b) => (b.onclick = async () => {
      const r = rows.find((x) => x.id === b.dataset.open);
      if (!r || busy) return;
      cloudId = r.id;
      if (r.settings) { settings = { ...settings, ...r.settings }; syncStyleControls(); }
      setBusy(true);
      try { await verifyAndShow(r.design, true); activateTab('v2d'); log(`Opened <b>${esc(r.name)}</b> from the cloud.`); } catch (e) { setStatus((e as Error).message, 'err'); } finally { setBusy(false); }
    }));
    list.querySelectorAll<HTMLButtonElement>('[data-del]').forEach((b) => (b.onclick = async () => {
      if (!confirm('Delete this design?')) return;
      try { await deleteCloudDesign(b.dataset.del!); if (cloudId === b.dataset.del) cloudId = undefined; await refreshCloud(); } catch (e) { setStatus((e as Error).message, 'err'); }
    }));
  } catch (e) { list.innerHTML = `<p style="color:var(--danger)">${esc((e as Error).message)}</p>`; }
}
$('cloud-refresh').onclick = () => void refreshCloud();
$('cloud-save').onclick = async () => {
  if (!design) { setStatus('Nothing to save yet.', 'err'); return; }
  try {
    const d: Design = JSON.parse(JSON.stringify(design));
    freeze(d);
    cloudId = await saveCloudDesign(d, settings, cloudId);
    log(`Saved <b>${esc(d.name)}</b> to the cloud.`);
    setStatus('Saved to your cloud designs.', 'ok');
    await refreshCloud();
  } catch (e) { setStatus((e as Error).message, 'err'); }
};

// ---------------- tabs ----------------
function activateTab(name: string) {
  document.querySelectorAll<HTMLButtonElement>('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll<HTMLElement>('.pane').forEach((p) => p.classList.toggle('active', p.id === `pane-${name}`));
  visited.add(name);
  $('app').classList.toggle('wide', name === 'sim' || name === 'mech');
  $('empty').classList.toggle('hidden', !!board || name === 'cloud' || name === 'json');
  view3d.setActive(name === 'v3d');
  viewMech.setActive(name === 'mech');
  if (name === 'v3d') refresh3d();
  if (name === 'mech') refreshMech();
  if (name === 'sim') { renderSimInputs(); simView.resize(); scheduleSim(0); }
  if (name === 'v2d') view2d.resize();
  if (name === 'sch') renderSchematic();
  if (name === 'cloud') void refreshCloud();
  renderCoach();
}

// ---------------- rules ----------------
function loadRules() {
  $<HTMLInputElement>('r-track').value = String(settings.trackWidth);
  $<HTMLInputElement>('r-power').value = String(settings.powerTrackWidth);
  $<HTMLInputElement>('r-clear').value = String(settings.clearance);
  $<HTMLInputElement>('r-via').value = String(settings.viaDiameter);
  $<HTMLInputElement>('r-drill').value = String(settings.viaDrill);
  $<HTMLSelectElement>('r-thick').value = String(settings.thickness);
  $<HTMLInputElement>('r-pour').checked = settings.groundPour;
  $<HTMLSelectElement>('r-layers').value = String(settings.layers || 0);
  syncStyleControls();
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
    groundPour: $<HTMLInputElement>('r-pour').checked,
    layers: parseInt($<HTMLSelectElement>('r-layers').value, 10) || 0,
  };
  if (settings.viaDrill > settings.viaDiameter - 0.2) settings.viaDrill = Math.max(0.2, settings.viaDiameter - 0.3);
  localStorage.setItem(LS.settings, JSON.stringify(settings));
}

// ---------------- wiring ----------------
const DESC: Record<string, string> = { 'LED board': 'Blue LEDs with resistors, powered over USB-C.', '555 blinker': 'The classic blinking-LED timer circuit.', 'ESP32 dev board': 'Wi-Fi/Bluetooth microcontroller board with USB-C.', 'ATmega328P': 'Arduino-compatible board with crystal and ISP header.', '3.3V LDO': 'Voltage regulator breakout with power LED.', 'MOSFET switch': 'Switch a 12 V LED strip from a logic signal.', 'USB-UART': 'USB-C to serial adapter (CH340C).' };
for (const ex of EXAMPLES) {
  const b = document.createElement('button');
  b.className = 'ex-card';
  b.innerHTML = `<b>${esc(ex.label)}</b><span>${esc(DESC[ex.label] ?? ex.prompt)}</span>`;
  b.title = ex.prompt;
  b.onclick = () => { $<HTMLTextAreaElement>('prompt').value = ex.prompt; $<HTMLInputElement>('refine').checked = false; void generate(); };
  $('examples').append(b);
}
$<HTMLSelectElement>('e-fp').innerHTML = FOOTPRINT_IDS.map((f) => `<option>${f}</option>`).join('');
$('btn-generate').onclick = generate;
$('prompt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) generate(); });
$('btn-cancel').onclick = () => {
  abort?.abort();
  rejectJob?.(new Error('Cancelled.'));
  if (worker) { worker.terminate(); worker = null; }
  setBusy(false);
  setStatus('Cancelled.', 'idle');
};
$('btn-reroute').onclick = async () => {
  if (!design || busy) return;
  readRules();
  const d: Design = JSON.parse(JSON.stringify(design));
  freeze(d);
  const bw = parseFloat($<HTMLInputElement>('r-bw').value), bh = parseFloat($<HTMLInputElement>('r-bh').value), cr = parseFloat($<HTMLInputElement>('r-corner').value);
  if (Number.isFinite(bw) && Number.isFinite(bh)) { d.board.width = Math.max(0, bw); d.board.height = Math.max(0, bh); }
  if (Number.isFinite(cr)) d.board.cornerRadius = Math.max(0, cr);
  setBusy(true);
  try { await verifyAndShow(d, false); } catch (e) { setStatus((e as Error).message, 'err'); } finally { setBusy(false); }
};
$('r-mask').addEventListener('change', () => applyStyle({ maskColor: $<HTMLSelectElement>('r-mask').value }));
$('r-maskc').addEventListener('input', () => applyStyle({ maskColor: $<HTMLInputElement>('r-maskc').value }));
$('r-silk').addEventListener('change', () => applyStyle({ silkColor: $<HTMLSelectElement>('r-silk').value }));
$('r-silkc').addEventListener('input', () => applyStyle({ silkColor: $<HTMLInputElement>('r-silkc').value }));
$('r-finish').addEventListener('change', () => applyStyle({ finish: $<HTMLSelectElement>('r-finish').value as 'HASL' | 'ENIG' }));
$('r-thick').addEventListener('change', () => { readRules(); if (board) { board.settings.thickness = settings.thickness; view3dDirty = true; if ($('pane-v3d').classList.contains('active')) refresh3d(); } });
for (const id of ['r-track', 'r-power', 'r-clear', 'r-via', 'r-drill', 'r-pour', 'r-bw', 'r-bh', 'r-corner', 'r-layers']) $(id).addEventListener('change', () => { readRules(); log('Rules changed - press <b>Apply &amp; re-route</b>.'); });

document.querySelectorAll<HTMLButtonElement>('.tab').forEach((t) => (t.onclick = () => activateTab(t.dataset.tab!)));
document.querySelectorAll<HTMLButtonElement>('.fab-picker .seg').forEach((b) => (b.onclick = () => {
  const prev = fab;
  fab = b.dataset.fab as FabId;
  localStorage.setItem(LS.fab, fab);
  if (settings.maskColor === FABS[prev].defaultMask && FABS[fab].defaultMask !== settings.maskColor) applyStyle({ maskColor: FABS[fab].defaultMask });
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
$<HTMLInputElement>('xray').addEventListener('change', (e) => view3d.setXray((e.target as HTMLInputElement).checked));
$<HTMLInputElement>('autorot').addEventListener('change', (e) => view3d.setAutoRotate((e.target as HTMLInputElement).checked));

$('dl-gerber').onclick = () => void exportFile('gerberZip');
$('dl-bom').onclick = () => void exportFile('bom');
$('dl-pnp').onclick = () => void exportFile('pnp');
$('dl-all').onclick = () => void exportFile('all');

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
  try { await verifyAndShow(d, true); log('Applied edited design JSON.'); } catch (e) { setStatus((e as Error).message, 'err'); } finally { setBusy(false); }
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
$('btn-settings').onclick = () => { $('s-msg').textContent = ''; $<HTMLInputElement>('s-key').value = apiKey; modelSel.value = model; dlg.showModal(); };
$('ai-mode').onclick = () => $('btn-settings').click();
$('s-save').addEventListener('click', async (ev) => {
  ev.preventDefault();
  const key = $<HTMLInputElement>('s-key').value.trim();
  const msg = $('s-msg');
  if (!key) { dlg.close('save'); return; } // empty = demo mode
  const btn = $<HTMLButtonElement>('s-save');
  btn.disabled = true; btn.textContent = 'Checking key…';
  msg.className = 'amsg'; msg.textContent = '';
  const r = await validateApiKey(key, modelSel.value);
  btn.disabled = false; btn.textContent = 'Save';
  if (r.ok) dlg.close('save');
  else { msg.className = 'amsg err'; msg.textContent = r.error; }
});
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

// ================= Simulation tab =================
let simSources: SimSource[] = [];
let simResult: SimResult | null = null;
let simTimer: number | undefined;
let simSeq = 1;
const simClosed = new Set<string>();
let simSelected: string | null = null;

function defaultSources(b: Board): SimSource[] {
  const names = b.nets.map((n) => n.name);
  const usb = names.find((n) => /^vbus$/i.test(n));
  if (usb) return [{ id: 'S1', target: usb, volts: 5, limitA: 0.5, enabled: true }];
  const pw = b.nets.map((n, i) => ({ n, i, c: b.pads.filter((p) => p.net === i).length })).filter((x) => x.n.isPower).sort((a, c) => c.c - a.c)[0];
  if (!pw) return [{ id: 'S1', target: names.find((n) => !/gnd/i.test(n)) ?? '', volts: 5, limitA: 1, enabled: true }];
  const m = pw.n.name.match(/(\d+)V(\d)?/i);
  const v = m ? parseFloat(`${m[1]}${m[2] ? '.' + m[2] : ''}`) : 5;
  return [{ id: 'S1', target: pw.n.name, volts: v, limitA: 1, enabled: true }];
}
function renderSimInputs() {
  const b = board;
  if (!b) { $('sim-sources').innerHTML = '<p class="muted small">Generate a board first.</p>'; return; }
  if (!simSources.length || !simSources.every((s) => b.nets.some((n) => n.name.toLowerCase() === s.target.toLowerCase()) || /^[^.]+\.\w+/.test(s.target))) simSources = defaultSources(b);
  const dl = $('sim-targets');
  const pins = new Set<string>();
  for (const p of b.pads) if (p.net >= 0 && /^J|^SW|^U/.test(p.ref) && pins.size < 120) pins.add(`${p.ref}.${p.pin}`);
  dl.innerHTML = [...b.nets.map((n) => `<option value="${esc(n.name)}">net</option>`), ...[...pins].map((q) => `<option value="${esc(q)}">pin</option>`)].join('');
  $('sim-sources').innerHTML = simSources.map((s, i) => `<div class="src" data-i="${i}">
    <div class="r1"><input type="checkbox" data-f="enabled" ${s.enabled ? 'checked' : ''} title="Enable" /><input type="text" data-f="target" list="sim-targets" value="${esc(s.target)}" placeholder="net or REF.PIN" style="flex:1" /><button class="ghost sm" data-del="${i}" title="Remove">✕</button></div>
    <div class="r2"><span>Voltage</span><span></span><input type="range" data-f="volts" min="-30" max="60" step="0.1" value="${s.volts}" /><input type="number" data-f="volts" step="0.1" value="${s.volts}" /></div>
    <div class="r2"><span>Current limit (A)</span><span></span><input type="range" data-f="limitA" min="0.01" max="10" step="0.01" value="${s.limitA}" /><input type="number" data-f="limitA" step="0.01" min="0.01" value="${s.limitA}" /></div>
  </div>`).join('');
  $('sim-sources').querySelectorAll<HTMLInputElement>('input[data-f]').forEach((inp) => inp.addEventListener('input', () => {
    const i = +(inp.closest('.src') as HTMLElement).dataset.i!;
    const f = inp.dataset.f as 'enabled' | 'target' | 'volts' | 'limitA';
    const src = simSources[i];
    if (f === 'enabled') src.enabled = inp.checked;
    else if (f === 'target') src.target = inp.value;
    else { const v = parseFloat(inp.value); if (Number.isFinite(v)) { (src as unknown as Record<string, number>)[f] = v; (inp.closest('.src') as HTMLElement).querySelectorAll<HTMLInputElement>(`input[data-f="${f}"]`).forEach((o) => { if (o !== inp) o.value = String(v); }); } }
    scheduleSim();
  }));
  $('sim-sources').querySelectorAll<HTMLButtonElement>('[data-del]').forEach((x) => (x.onclick = () => { simSources.splice(+x.dataset.del!, 1); renderSimInputs(); scheduleSim(0); }));
  const sws = b.comps.filter((c) => /^SW_/.test(c.fp.id));
  $('sim-sw').innerHTML = sws.length ? `<div class="h" style="margin-top:10px">Switches</div>${sws.map((c) => `<label class="chk"><input type="checkbox" data-sw="${c.ref}" ${simClosed.has(c.ref) ? 'checked' : ''} /> Press ${c.ref} (${esc(c.comp.description || c.comp.value)})</label>`).join('<br>')}` : '';
  $('sim-sw').querySelectorAll<HTMLInputElement>('[data-sw]').forEach((c) => c.addEventListener('change', () => { if (c.checked) simClosed.add(c.dataset.sw!); else simClosed.delete(c.dataset.sw!); scheduleSim(0); }));
}
function scheduleSim(delay = 120) {
  window.clearTimeout(simTimer);
  simTimer = window.setTimeout(() => { if ($('pane-sim').classList.contains('active') || simResult) runSim(); }, delay);
}
function runSim() {
  if (!board) return;
  const amb = +$<HTMLInputElement>('sim-amb').value;
  $('sim-amb-v').textContent = String(amb);
  const t0 = performance.now();
  const res = simulate(board, { sources: simSources, ambientC: amb, closedSwitches: [...simClosed], cascade: $<HTMLInputElement>('sim-cascade').checked });
  simResult = res;
  simView.overlay = $<HTMLSelectElement>('sim-overlay').value as 'temp' | 'volt';
  simView.set(board, res, amb);
  view3d.setSim($<HTMLInputElement>('sim-3dov').checked && res.ok ? res : null, amb);
  renderSimResults(res, performance.now() - t0);
}
function renderSimResults(res: SimResult, ms: number) {
  const ev = $('sim-events'), tb = $('sim-table'), nt = $('sim-nets'), pills = $('sim-pills');
  if (!res.ok) { ev.innerHTML = `<div class="ev">${esc(res.error ?? 'Simulation failed')}</div>`; tb.innerHTML = ''; nt.innerHTML = ''; pills.innerHTML = ''; return; }
  const worst = res.comps.reduce((a, c) => (STATUS_RANK[c.status] > STATUS_RANK[a] ? c.status : a), 'off' as SimResult['comps'][0]['status']);
  pills.innerHTML = [
    `<span class="stat ${STATUS_RANK[worst] >= STATUS_RANK.failed ? 'bad' : STATUS_RANK[worst] >= STATUS_RANK.hot ? 'warn' : ''}">${STATUS_ICON[worst]} ${worst === 'off' ? 'idle' : worst}</span>`,
    `<span class="stat">Total ${res.totalW.toFixed(2)} W</span>`,
    `<span class="stat">Hot spot ${res.maxBoardC.toFixed(0)} °C</span>`,
    ...res.sources.map((s) => `<span class="stat ${s.limited ? 'bad' : ''}">${esc(s.net)} ${s.vActual.toFixed(2)} V · ${(s.iA * 1000).toFixed(0)} mA${s.limited ? ' (limit!)' : ''}</span>`),
  ].join('');
  const bad = res.events;
  ev.innerHTML = (bad.length ? bad.map((e) => `<div class="ev">${esc(e)}</div>`).join('') : '<div class="ev ok">All parts and traces are within their ratings for these inputs.</div>') + `<div class="muted small" style="margin:4px 0">${res.cascadeRounds ? `${res.cascadeRounds} failure round(s) simulated · ` : ''}solved in ${ms.toFixed(0)} ms</div>`;
  const rows = [...res.comps].sort((a, c) => STATUS_RANK[c.status] - STATUS_RANK[a.status] || c.tempC - a.tempC);
  tb.innerHTML = `<table><thead><tr><th></th><th>Part</th><th>V</th><th>I</th><th>P</th><th>T</th></tr></thead><tbody>${rows.map((r) => `<tr data-ref="${r.ref}" class="${r.ref === simSelected ? 'sel' : ''}"><td class="st" style="color:${STATUS_COLOR[r.status]}" title="${r.status}">${STATUS_ICON[r.status]}</td><td><b>${esc(r.ref)}</b> <span class="muted">${esc(r.value)}</span>${r.messages.length ? `<div class="muted small">${esc(r.messages.join(' · '))}</div>` : ''}</td><td class="mono">${(r.vSupply || r.vAcross).toFixed(2)}</td><td class="mono">${Math.abs(r.i) < 1 ? (r.i * 1000).toFixed(1) + 'mA' : r.i.toFixed(2) + 'A'}</td><td class="mono">${(r.p * 1000).toFixed(0)}mW</td><td class="mono">${r.tempC.toFixed(0)}°</td></tr>`).join('')}</tbody></table>`;
  tb.querySelectorAll<HTMLElement>('tr[data-ref]').forEach((tr) => (tr.onclick = () => { simSelected = tr.dataset.ref!; simView.selected = simSelected; simView.draw(); renderSimResults(res, ms); }));
  nt.innerHTML = `<div class="h" style="margin-top:12px">Net voltages</div><table><tbody>${Object.entries(res.netV).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="mono">${v.toFixed(3)} V</td></tr>`).join('')}</tbody></table>`;
}
simView.onHover = (t) => ($('sim-hover').textContent = t);
simView.onPick = (ref) => { simSelected = ref; if (simResult) renderSimResults(simResult, 0); };
$('sim-add').onclick = () => { simSources.push({ id: `S${++simSeq}`, target: board?.nets.find((n) => n.isPower)?.name ?? '', volts: 5, limitA: 1, enabled: true }); renderSimInputs(); scheduleSim(0); };
$('sim-preset').addEventListener('change', (e) => {
  const sel = e.target as HTMLSelectElement;
  const P: Record<string, [number, number]> = { usb: [5, 0.5], usb3: [5, 3], lipo: [3.7, 2], 9: [9, 1], 12: [12, 2], 24: [24, 5] };
  const pr = P[sel.value];
  if (pr && simSources[0]) { simSources[0].volts = pr[0]; simSources[0].limitA = pr[1]; simSources[0].enabled = true; renderSimInputs(); scheduleSim(0); }
  sel.value = '';
});
for (const id of ['sim-amb', 'sim-cascade']) $(id).addEventListener('input', () => scheduleSim());
$('sim-overlay').addEventListener('change', () => { simView.overlay = $<HTMLSelectElement>('sim-overlay').value as 'temp' | 'volt'; simView.draw(); });
$('sim-3dov').addEventListener('change', () => { if ($<HTMLInputElement>('sim-3dov').checked && simResult?.ok) view3d.setSim(simResult, +$<HTMLInputElement>('sim-amb').value); else view3d.setSim(null, 25); });
$('sim-run').onclick = () => runSim();
$('sim-3d').onclick = () => { runSim(); activateTab('v3d'); };

// ================= Mechanic tab =================
const mech: { models: MechModel[]; sel: string | null; fit: FitResult | null; seq: number; dirty: boolean } = { models: [], sel: null, fit: null, seq: 1, dirty: true };
const mechMargin = () => Math.max(0, parseFloat($<HTMLInputElement>('m-margin').value) || 0);
function refreshMech() {
  if (!mech.dirty) return;
  mech.dirty = false;
  viewMech.setBoard(board, silk);
  viewMech.dragEnabled = true;
  viewMech.setModels(mech.models.filter((m) => m.visible).map((m) => m.object));
  viewMech.setCollisions(mech.fit?.partsCollide ?? []);
}
function onBoardChangedForTabs() {
  mech.dirty = true;
  if ($('pane-mech').classList.contains('active')) { refreshMech(); if ($<HTMLInputElement>('m-live').checked && mech.models.length) runFit(); }
  if (simSources.length || $('pane-sim').classList.contains('active')) { renderSimInputs(); scheduleSim(0); }
}
function syncModels() {
  for (const m of mech.models) applyTransform(m.object, m.t);
  viewMech.setModels(mech.models.filter((m) => m.visible).map((m) => m.object));
}
function renderModelList() {
  $('m-list').innerHTML = mech.models.map((m) => {
    const sz = boundsOf(m.object).getSize(new THREE.Vector3());
    return `<div class="mrow ${m.id === mech.sel ? 'sel' : ''}" data-id="${m.id}"><input type="checkbox" data-vis ${m.visible ? 'checked' : ''} title="Visible" /><span class="nm" title="${esc(m.name)}">${esc(m.name)}</span><span class="muted small">${sz.x.toFixed(0)}×${sz.y.toFixed(0)}×${sz.z.toFixed(0)} mm</span><button class="ghost" data-rm title="Remove">✕</button></div>`;
  }).join('');
  $('m-list').querySelectorAll<HTMLElement>('.mrow').forEach((row) => {
    const m = mech.models.find((q) => q.id === row.dataset.id)!;
    row.addEventListener('click', (e) => { const t = e.target as HTMLElement; if (t.closest('[data-rm]')) return; if (t.matches('[data-vis]')) return; mech.sel = m.id; renderModelList(); loadXform(); });
    row.querySelector<HTMLInputElement>('[data-vis]')!.addEventListener('change', (e) => { m.visible = (e.target as HTMLInputElement).checked; syncModels(); autoFit(); });
    row.querySelector<HTMLElement>('[data-rm]')!.addEventListener('click', () => { mech.models = mech.models.filter((q) => q !== m); if (mech.sel === m.id) mech.sel = mech.models[0]?.id ?? null; syncModels(); renderModelList(); loadXform(); mech.fit = null; renderFit(); autoFit(); });
  });
}
const selModel = () => mech.models.find((m) => m.id === mech.sel);
function loadXform() {
  const m = selModel();
  $('m-xform').classList.toggle('hidden', !m);
  if (!m) return;
  const t = m.t;
  for (const [id, v] of Object.entries({ 'm-x': t.x, 'm-y': t.y, 'm-z': t.z, 'm-s': t.scale, 'm-rx': t.rx, 'm-ry': t.ry, 'm-rz': t.rz })) $<HTMLInputElement>(id).value = String(+v.toFixed(3));
  $<HTMLInputElement>('m-solid').checked = m.solid;
}
function readXform() {
  const m = selModel();
  if (!m) return;
  const n = (id: string, d: number) => { const v = parseFloat($<HTMLInputElement>(id).value); return Number.isFinite(v) ? v : d; };
  m.t = { x: n('m-x', 0), y: n('m-y', 0), z: n('m-z', 0), scale: n('m-s', 1) || 1, rx: n('m-rx', 0), ry: n('m-ry', 0), rz: n('m-rz', 0) };
  m.solid = $<HTMLInputElement>('m-solid').checked;
  syncModels(); renderModelList(); autoFit();
}
['m-x', 'm-y', 'm-z', 'm-s', 'm-rx', 'm-ry', 'm-rz', 'm-solid'].forEach((id) => $(id).addEventListener('input', readXform));
function placeModel(m: MechModel, mode: 'center' | 'floor') {
  if (!board) return;
  applyTransform(m.object, { ...m.t, x: 0, y: 0, z: 0 });
  const bb = boundsOf(m.object);
  const c = bb.getCenter(new THREE.Vector3());
  const t: MechTransform = { ...m.t };
  if (mode === 'center') { t.x = board.width / 2 - c.x; t.y = board.height / 2 - c.y; }
  else t.z = -2 - bb.min.z; // floor 2 mm below the PCB underside
  m.t = t;
  applyTransform(m.object, t);
}
$('m-center').onclick = () => { const m = selModel(); if (m) { placeModel(m, 'center'); loadXform(); syncModels(); autoFit(); } };
$('m-floor').onclick = () => { const m = selModel(); if (m) { placeModel(m, 'floor'); loadXform(); syncModels(); autoFit(); } };
$('m-reset').onclick = () => { const m = selModel(); if (m) { m.t = { ...IDENTITY }; loadXform(); syncModels(); autoFit(); } };
$('m-import').onclick = () => $<HTMLInputElement>('m-file').click();
$<HTMLInputElement>('m-file').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  for (const f of Array.from(input.files ?? [])) {
    try {
      setStatus(`Importing ${f.name}…`, 'busy');
      const obj = await loadModelBuffer(f.name, await f.arrayBuffer());
      const m: MechModel = { id: `m${mech.seq++}`, name: f.name, object: obj, t: { ...IDENTITY }, visible: true, solid: true, tris: countTriangles(obj) };
      mech.models.push(m); mech.sel = m.id;
      placeModel(m, 'center');
      log(`Imported <b>${esc(f.name)}</b> (${m.tris.toLocaleString()} triangles)`);
      setStatus(`Imported ${f.name}.`, 'ok');
    } catch (err) { setStatus((err as Error).message, 'err'); log(`<span style="color:var(--danger)">Import failed:</span> ${esc((err as Error).message)}`); }
  }
  input.value = '';
  syncModels(); renderModelList(); loadXform(); mech.dirty = true; refreshMech(); autoFit();
});
function runFit() {
  if (!board) return;
  mech.fit = checkFit(board, mech.models, mechMargin());
  viewMech.setCollisions(mech.fit.partsCollide);
  renderFit();
}
function autoFit() { if ($<HTMLInputElement>('m-live').checked && mech.models.length) runFit(); }
function renderFit() {
  const el = $('m-result'), f = mech.fit;
  if (!f) { el.innerHTML = '<div class="muted small" style="margin-top:8px">Import a model and press “Check fit”.</div>'; return; }
  if (!f.collisions.length) { el.innerHTML = `<div class="ev ok" style="margin-top:8px">✓ Everything fits: ${f.checkedParts} parts and the PCB outline clear the model by ≥ ${mechMargin()} mm (${f.ms} ms).</div>`; return; }
  el.innerHTML = `<div style="margin-top:8px">${f.collisions.map((c) => `<div class="ev" data-ref="${esc(c.ref)}" style="cursor:pointer">${c.kind === 'board' ? '⛔' : '⚠'} ${esc(c.message)}</div>`).join('')}</div>${f.partsCollide.length ? '<div class="muted small">Drag the red parts, or press “Auto-move parts”.</div>' : '<div class="muted small">Move or rotate the model, or enlarge the case.</div>'}`;
  el.querySelectorAll<HTMLElement>('[data-ref]').forEach((d) => (d.onclick = () => { selected = d.dataset.ref!; view2d.selected = selected; renderSel(); }));
}
$('m-check').onclick = () => { if (!mech.models.length) { setStatus('Import a STEP/STL file first.', 'err'); return; } runFit(); };
$('m-margin').addEventListener('change', autoFit);
$('m-live').addEventListener('change', autoFit);
$('m-ghost').addEventListener('change', () => { const op = $<HTMLInputElement>('m-ghost').checked ? 0.4 : 1; for (const m of mech.models) m.object.traverse((o) => { const me = o as THREE.Mesh; if (me.isMesh) { const mt = me.material as THREE.MeshStandardMaterial; mt.opacity = op; mt.transparent = op < 1; } }); });
$('m-auto').onclick = async () => {
  if (!board || !design || busy) return;
  if (!mech.models.length) { setStatus('Import a STEP/STL file first.', 'err'); return; }
  const fit = checkFit(board, mech.models, mechMargin());
  mech.fit = fit; renderFit();
  if (!fit.partsCollide.length) { setStatus(fit.boardCollides ? 'Parts are fine, but the PCB outline itself touches the model.' : 'Nothing to move - everything fits.', fit.boardCollides ? 'err' : 'ok'); return; }
  const r = autoMove(board, mech.models, mechMargin(), fit.partsCollide);
  if (!r.moves.length) { setStatus(`Could not find free space for ${r.stuck.join(', ')}. Enlarge the board or move the model.`, 'err'); return; }
  await edit((d) => { for (const m of r.moves) { const c = d.components.find((q) => q.ref === m.ref); if (c) { c.x = m.toX; c.y = m.toY; c.rotation = m.rot; } } }, `Moving ${r.moves.length} part(s) to fit the case…`);
  log(`Mechanical auto-fit moved <b>${r.moves.map((m) => m.ref).join(', ')}</b>${r.stuck.length ? `; could not move ${r.stuck.join(', ')}` : ''}. Traces re-routed.`);
  const ok = await reverify(); // 5x DRC on the updated board so the Gerbers it produces are clean
  mech.dirty = true; refreshMech(); runFit();
  setStatus(`${r.moves.length} part(s) moved, PCB re-routed${ok ? ' and verified (5× DRC)' : ' - DRC reports issues'}. Gerber/BOM/CPL now reflect the new layout.`, ok ? 'ok' : 'err');
  const left = mech.fit?.collisions.length ?? 0;
  if (left) log(`${left} mechanical conflict(s) remain (edge connectors, the PCB outline, or no free space).`);
};
viewMech.onPick = (ref) => { selected = ref; view2d.selected = ref; renderSel(); };
viewMech.onDrag = (ref, x, y) => { void edit((d) => { const c = d.components.find((q) => q.ref === ref); if (c) { c.x = x; c.y = y; } }, `Moving ${ref}…`); };
document.querySelectorAll<HTMLButtonElement>('[data-mview]').forEach((b) => (b.onclick = () => viewMech.view(b.dataset.mview as 'iso' | 'top' | 'front' | 'side')));

// ================= app chrome: coach, suggestions, empty state, modals =================
const visited = new Set<string>(['v2d']);
let exported = false;

function openExport() { if (!board) { setStatus('Create a board first.', 'err'); $('prompt').focus(); return; } $<HTMLDialogElement>('export').showModal(); }
function greet() {
  if ($('chat').children.length) return;
  say(`Hi! I’m your PCB copilot. <b>Tell me what you want to build</b> and I’ll design it, wire it up and check it for you.<br><span class="muted">Try “ESP32 board with USB-C power and a reset button”, or pick an example in the middle of the screen.</span>`);
}
function renderCoach() {
  const el = $('coach');
  const built = !!board;
  const checked = built && vstate.hasRun && !vstate.stale && vstate.drc.length === DRC_RUNS && vstate.drc.every((r) => r.errors === 0);
  type Step = { id: string; label: string; hint: string; done: boolean; optional?: boolean; go: () => void };
  const steps: Step[] = [
    { id: 'describe', label: 'Describe your board', hint: 'Type it in the Copilot box', done: built, go: () => $('prompt').focus() },
    { id: 'check', label: 'AI builds & checks it', hint: checked ? 'Self-review ×3 and design check ×5 passed' : 'Waiting for checks', done: checked, go: () => { if (board) void reverify(); } },
    { id: '3d', label: 'Look at it in 3D', hint: 'Spin it, hover the parts', done: visited.has('v3d'), go: () => activateTab('v3d') },
    { id: 'sim', label: 'Test power & heat', hint: 'See what gets hot or burns out', done: visited.has('sim'), go: () => activateTab('sim') },
    { id: 'mech', label: 'Check it fits your case', hint: 'Optional — import a STEP/STL case', done: visited.has('mech'), optional: true, go: () => activateTab('mech') },
    { id: 'export', label: 'Export & order', hint: 'Pick a factory and download files', done: exported, go: openExport },
  ];
  const next = steps.find((x) => !x.done && !x.optional);
  el.innerHTML = `<ul class="coach">${steps.map((x) => `<li class="${x.done ? 'done' : x === next ? 'next' : ''}" data-id="${x.id}"><span class="dot">${x.done ? '✓' : ''}</span><span>${esc(x.label)}${x.optional ? ' <span class="muted">(optional)</span>' : ''}<small>${esc(x.hint)}</small></span></li>`).join('')}</ul>`;
  el.querySelectorAll<HTMLElement>('li').forEach((li) => (li.onclick = () => steps.find((x) => x.id === li.dataset.id)!.go()));
}
function renderSuggest() {
  const el = $('chat-suggest');
  const ideas = !board ? [] : apiKey
    ? ['Make the PCB matte black', 'Make it 4 layers', 'Add a reset button', 'Add labels to the headers', 'Make the board smaller', 'Use gold finish and white text']
    : ['Make the PCB matte black', 'Make it 4 layers', 'Make the board purple with white text'];
  el.innerHTML = ideas.map((t) => `<button data-t="${esc(t)}">${esc(t)}</button>`).join('');
  el.querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.onclick = () => { $<HTMLTextAreaElement>('prompt').value = b.dataset.t!; $<HTMLInputElement>('refine').checked = true; void generate(); }));
}
function renderChrome() {
  $('empty').classList.toggle('hidden', !!board || ['pane-cloud', 'pane-json'].some((id) => $(id).classList.contains('active')));
  if (design) { const pn = $<HTMLInputElement>('proj-name'); if (document.activeElement !== pn) pn.value = design.name; }
  renderCoach();
  renderSuggest();
}
$('proj-name').addEventListener('change', () => {
  const v = $<HTMLInputElement>('proj-name').value.trim() || 'Untitled board';
  if (design) design.name = v;
  if (board) { board.design.name = v; silk = buildSilk(board); view2d.silk = silk; view2d.draw(); view3dDirty = true; if (design) localStorage.setItem(LS.design, JSON.stringify(design)); }
});
function newBoard() {
  if (busy) return;
  if (board && !confirm('Start a new board? Your current one will be cleared (save it to My designs first if you want to keep it).')) return;
  design = null; board = null; cloudId = undefined; selected = null; simSources = []; simResult = null; exported = false;
  vstate.reviews = []; vstate.drc = []; vstate.hasRun = false; vstate.stale = false; vstate.running = '';
  mech.fit = null;
  localStorage.removeItem(LS.design);
  setBoard(null);
  renderVerify();
  say('Fresh start — what would you like to build?');
  $('prompt').focus();
}
$('btn-newchat').onclick = newBoard;
$('btn-export').onclick = openExport;
$('btn-export2').onclick = openExport;
$('banner-key').onclick = () => $('btn-settings').click();
$('btn-help').onclick = () => $<HTMLDialogElement>('help').showModal();
document.querySelectorAll<HTMLButtonElement>('[data-close]').forEach((b) => (b.onclick = () => (b.closest('dialog') as HTMLDialogElement).close()));
document.querySelectorAll<HTMLDialogElement>('dialog.modal').forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) d.close(); }));
$('empty-go').onclick = () => { const v = $<HTMLTextAreaElement>('empty-prompt').value.trim(); if (!v) { $('empty-prompt').focus(); return; } $<HTMLTextAreaElement>('prompt').value = v; $<HTMLInputElement>('refine').checked = false; $<HTMLTextAreaElement>('empty-prompt').value = ''; void generate(); };
$('empty-prompt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('empty-go').click(); } });
function applyMode(m: 'beginner' | 'pro') { document.documentElement.setAttribute('data-mode', m); localStorage.setItem('pcbx2.mode', m); $('btn-mode').textContent = m === 'pro' ? 'Pro' : 'Beginner'; }
$('btn-mode').onclick = () => { const next = document.documentElement.getAttribute('data-mode') === 'pro' ? 'beginner' : 'pro'; applyMode(next); say(next === 'pro' ? 'Pro mode on: advanced rules, the Advanced data tab and extra view options are now visible.' : 'Beginner mode on: advanced controls are hidden to keep things simple.', 'sys'); };
applyMode((localStorage.getItem('pcbx2.mode') as 'beginner' | 'pro') || 'beginner');
$('tgl-right').onclick = () => {
  const ins = document.querySelector('.inspector')!;
  if (window.innerWidth <= 1280) ins.classList.toggle('show'); else $('app').classList.toggle('no-right');
  window.setTimeout(() => { view2d.resize(); simView.resize(); view3d.resize(); viewMech.resize(); }, 220);
};
$('z-in').onclick = () => view2d.zoomBy(1.3);
$('z-out').onclick = () => view2d.zoomBy(1 / 1.3);
$('prompt').addEventListener('input', () => { const t = $<HTMLTextAreaElement>('prompt'); t.style.height = 'auto'; t.style.height = `${Math.min(160, t.scrollHeight)}px`; });

// ---------------- boot ----------------
loadRules();
renderFab();
updateAiMode();
setBoard(null);
renderVerify();

function bootApp() {
  const saved = localStorage.getItem(LS.design);
  if (saved) {
    try {
      const d = JSON.parse(saved) as Design;
      setBusy(true);
      relayout(d, 'Restoring your last design…').then(() => { vstate.stale = false; vstate.hasRun = false; renderVerify(); say(`Welcome back! I restored <b>${esc(d.name)}</b>.`); renderChrome(); }).catch(() => undefined).finally(() => setBusy(false));
      return;
    } catch { /* ignore */ }
  }
  greet();
  if (!localStorage.getItem('pcbx2.welcomed')) { localStorage.setItem('pcbx2.welcomed', '1'); $<HTMLDialogElement>('welcome').showModal(); }
}
