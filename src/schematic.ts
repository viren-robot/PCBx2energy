// Schematic generation from a board (PCB -> schematic): symbol per component, net labels,
// power/ground symbols and AI labels. Output is a self-contained SVG string styled with CSS variables.
import type { Board, FootprintDef, PlacedComponent } from './types';

export interface Schematic { svg: string; width: number; height: number; symbols: number }

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const TW = 6.4; // approx text width per char at 11px

function pinName(fp: FootprintDef, id: string): string {
  if (!/^\d+$/.test(id)) return id;
  if (fp.aliases) {
    const names = Object.entries(fp.aliases).filter(([k, v]) => v === id && !/^\d+$/.test(k) && !/^(TX|RX|TXD|RXD|VCC)$/.test(k));
    if (names.length) return names.sort((a, b) => a[0].length - b[0].length)[0][0];
  }
  return id;
}

interface PinRef { id: string; name: string; net: number }

function uniquePins(board: Board, c: PlacedComponent): PinRef[] {
  const seen = new Map<string, PinRef>();
  for (const p of board.pads) {
    if (p.ref !== c.ref || p.type === 'npth') continue;
    if (!seen.has(p.pin)) seen.set(p.pin, { id: p.pin, name: pinName(c.fp, p.pin), net: p.net });
  }
  const pins = [...seen.values()];
  pins.sort((a, b) => {
    const na = Number(a.id), nb = Number(b.id);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
    return a.id.localeCompare(b.id);
  });
  return pins;
}

type TwoKind = 'R' | 'C' | 'CP' | 'L' | 'LED' | 'D' | 'F' | 'XTAL' | 'SW';
function twoPinKind(c: PlacedComponent, pins: PinRef[]): TwoKind | null {
  if (pins.length !== 2) return null;
  const id = c.fp.id;
  if (id.startsWith('R_')) return 'R';
  if (id.startsWith('CP_')) return 'CP';
  if (id.startsWith('C_')) return 'C';
  if (id.startsWith('L_')) return 'L';
  if (id.startsWith('LED_')) return 'LED';
  if (id.startsWith('D_')) return 'D';
  if (id.startsWith('F_')) return 'F';
  if (id.startsWith('Crystal')) return 'XTAL';
  if (id.startsWith('SW_')) return 'SW';
  return null;
}

function bodySymbol(kind: TwoKind, cx: number, cy: number): string {
  const l = `class="sch-body"`;
  switch (kind) {
    case 'R': return `<rect ${l} x="${cx - 22}" y="${cy - 8}" width="44" height="16"/>`;
    case 'F': return `<rect ${l} x="${cx - 22}" y="${cy - 8}" width="44" height="16"/><line ${l} x1="${cx - 22}" y1="${cy}" x2="${cx + 22}" y2="${cy}"/>`;
    case 'C': return `<line ${l} x1="${cx - 4}" y1="${cy - 14}" x2="${cx - 4}" y2="${cy + 14}"/><line ${l} x1="${cx + 4}" y1="${cy - 14}" x2="${cx + 4}" y2="${cy + 14}"/>`;
    case 'CP': return `<line ${l} x1="${cx - 4}" y1="${cy - 14}" x2="${cx - 4}" y2="${cy + 14}"/><path ${l} d="M ${cx + 9} ${cy - 14} Q ${cx + 3} ${cy} ${cx + 9} ${cy + 14}" fill="none"/><text class="sch-pin" x="${cx - 12}" y="${cy - 8}" text-anchor="end">+</text>`;
    case 'L': return `<path ${l} d="M ${cx - 24} ${cy} a 6 6 0 0 1 12 0 a 6 6 0 0 1 12 0 a 6 6 0 0 1 12 0 a 6 6 0 0 1 12 0" fill="none"/>`;
    case 'D': return `<polygon ${l} points="${cx - 10},${cy - 12} ${cx - 10},${cy + 12} ${cx + 10},${cy}"/><line ${l} x1="${cx + 10}" y1="${cy - 12}" x2="${cx + 10}" y2="${cy + 12}"/>`;
    case 'LED': return `<polygon ${l} points="${cx - 10},${cy - 12} ${cx - 10},${cy + 12} ${cx + 10},${cy}"/><line ${l} x1="${cx + 10}" y1="${cy - 12}" x2="${cx + 10}" y2="${cy + 12}"/>`
      + `<path ${l} d="M ${cx - 2} ${cy - 18} l 8 -8 m -4 0 h 4 v 4 M ${cx + 6} ${cy - 15} l 8 -8 m -4 0 h 4 v 4" fill="none"/>`;
    case 'XTAL': return `<rect ${l} x="${cx - 7}" y="${cy - 10}" width="14" height="20"/><line ${l} x1="${cx - 13}" y1="${cy - 13}" x2="${cx - 13}" y2="${cy + 13}"/><line ${l} x1="${cx + 13}" y1="${cy - 13}" x2="${cx + 13}" y2="${cy + 13}"/>`;
    case 'SW': return `<circle ${l} cx="${cx - 16}" cy="${cy}" r="2.5"/><circle ${l} cx="${cx + 16}" cy="${cy}" r="2.5"/><line ${l} x1="${cx - 16}" y1="${cy - 2}" x2="${cx + 14}" y2="${cy - 14}"/>`;
  }
}

class Svg {
  parts: string[] = [];
  add(s: string) { this.parts.push(s); }
}

export function buildSchematic(board: Board): Schematic {
  const out = new Svg();
  const netName = (n: number) => board.nets[n]?.name ?? '';
  const netCls = (n: number) => (board.nets[n]?.isGround ? 'gnd' : board.nets[n]?.isPower ? 'pwr' : 'sig');
  const labelsBy = new Map<string, { text: string; pin?: string }[]>();
  for (const l of board.design.labels ?? []) {
    const a = labelsBy.get(l.ref) ?? [];
    a.push({ text: l.text, pin: l.pin });
    labelsBy.set(l.ref, a);
  }

  // Draw one net terminal at the end of a pin stub. dir: -1 stub points left, +1 right.
  const terminal = (x: number, y: number, dir: number, net: number, extra?: string) => {
    if (net < 0) { out.add(`<path class="sch-nc" d="M ${x - 3} ${y - 3} l 6 6 m 0 -6 l -6 6"/>`); return; }
    const nm = netName(net);
    const cls = netCls(net);
    const hit = `data-net="${net}"`;
    if (cls === 'gnd') {
      out.add(`<g class="sch-net gnd" ${hit}><line class="sch-wire" x1="${x}" y1="${y}" x2="${x + dir * 8}" y2="${y}"/>`
        + `<line class="sch-wire" x1="${x + dir * 8}" y1="${y - 7}" x2="${x + dir * 8}" y2="${y + 7}"/><line class="sch-wire" x1="${x + dir * 12}" y1="${y - 4}" x2="${x + dir * 12}" y2="${y + 4}"/>`
        + `<line class="sch-wire" x1="${x + dir * 16}" y1="${y - 1.5}" x2="${x + dir * 16}" y2="${y + 1.5}"/>`
        + `<text class="sch-label" x="${x + dir * 22}" y="${y + 4}" text-anchor="${dir > 0 ? 'start' : 'end'}">${esc(nm)}${extra ? ` <tspan class="sch-ai">${esc(extra)}</tspan>` : ''}</text></g>`);
    } else if (cls === 'pwr') {
      out.add(`<g class="sch-net pwr" ${hit}><line class="sch-wire" x1="${x}" y1="${y}" x2="${x + dir * 10}" y2="${y}"/>`
        + `<polygon class="sch-power" points="${x + dir * 10},${y - 6} ${x + dir * 10},${y + 6} ${x + dir * 18},${y}"/>`
        + `<text class="sch-label" x="${x + dir * 24}" y="${y + 4}" text-anchor="${dir > 0 ? 'start' : 'end'}">${esc(nm)}${extra ? ` <tspan class="sch-ai">${esc(extra)}</tspan>` : ''}</text></g>`);
    } else {
      const w = (nm.length + (extra ? extra.length + 1 : 0)) * TW + 12;
      const x2 = x + dir * 8;
      const pts = dir > 0
        ? `${x2},${y} ${x2 + 6},${y - 7} ${x2 + w},${y - 7} ${x2 + w},${y + 7} ${x2 + 6},${y + 7}`
        : `${x2},${y} ${x2 - 6},${y - 7} ${x2 - w},${y - 7} ${x2 - w},${y + 7} ${x2 - 6},${y + 7}`;
      out.add(`<g class="sch-net sig" ${hit}><line class="sch-wire" x1="${x}" y1="${y}" x2="${x2}" y2="${y}"/><polygon class="sch-flag" points="${pts}"/>`
        + `<text class="sch-label" x="${x2 + dir * 9}" y="${y + 4}" text-anchor="${dir > 0 ? 'start' : 'end'}">${esc(nm)}${extra ? ` <tspan class="sch-ai">${esc(extra)}</tspan>` : ''}</text></g>`);
    }
  };
  const termWidth = (net: number, extra?: string) => {
    if (net < 0) return 10;
    const n = netName(net).length + (extra ? extra.length + 1 : 0);
    return netCls(net) === 'sig' ? n * TW + 28 : n * TW + 34;
  };

  // ------ symbols ------
  interface Placed { w: number; h: number; draw: (x: number, y: number) => void }
  const items: { order: number; ref: string; p: Placed }[] = [];
  const order = (ref: string) => ({ J: 0, U: 1, Q: 2, Y: 3 } as Record<string, number>)[ref[0]] ?? (/^[RCLDF]/.test(ref) ? 5 : 4);

  for (const c of board.comps) {
    if (c.fp.body.kind === 'hole') continue;
    const pins = uniquePins(board, c);
    if (!pins.length) continue;
    const lbls = labelsBy.get(c.ref) ?? [];
    const pinLbl = (id: string) => lbls.find((l) => l.pin && (l.pin === id || l.pin === pins.find((p) => p.id === id)?.name))?.text;
    const note = lbls.find((l) => !l.pin)?.text;
    const kind = twoPinKind(c, pins);
    if (kind) {
      // pin order: diodes/LEDs anode left, cathode right; polarised caps + on left
      let [a, b] = pins;
      if ((kind === 'LED' || kind === 'D') && a.id === '1') [a, b] = [b, a];
      const stub = 28, bodyW = 70;
      const lw = Math.max(termWidth(a.net, pinLbl(a.id)), 40), rw = Math.max(termWidth(b.net, pinLbl(b.id)), 40);
      const w = lw + stub + bodyW + stub + rw;
      items.push({ order: order(c.ref), ref: c.ref, p: { w, h: 74, draw: (x, y) => {
        const cy = y + 40, cx = x + lw + stub + bodyW / 2;
        out.add(`<g class="sch-sym" data-ref="${esc(c.ref)}"><title>${esc(c.ref)} ${esc(c.comp.value)} (${esc(c.fp.id)})</title>`);
        out.add(`<line class="sch-wire" x1="${x + lw}" y1="${cy}" x2="${cx - bodyW / 2}" y2="${cy}"/><line class="sch-wire" x1="${cx + bodyW / 2}" y1="${cy}" x2="${x + w - rw}" y2="${cy}"/>`);
        out.add(bodySymbol(kind, cx, cy));
        out.add(`<text class="sch-ref" x="${cx}" y="${cy - (kind === 'LED' ? 34 : 20)}" text-anchor="middle">${esc(c.ref)}</text><text class="sch-val" x="${cx}" y="${cy + 28}" text-anchor="middle">${esc(c.comp.value)}</text>`);
        if (note) out.add(`<text class="sch-ai" x="${cx}" y="${cy + 41}" text-anchor="middle">${esc(note)}</text>`);
        out.add('</g>');
        terminal(x + lw, cy, -1, a.net, pinLbl(a.id));
        terminal(x + w - rw, cy, 1, b.net, pinLbl(b.id));
        out.add(`<text class="sch-pin" x="${x + lw + 4}" y="${cy - 4}">${esc(a.name)}</text><text class="sch-pin" x="${x + w - rw - 4}" y="${cy - 4}" text-anchor="end">${esc(b.name)}</text>`);
      } } });
      continue;
    }
    // generic IC / connector box
    const half = Math.ceil(pins.length / 2);
    const isConn = /^J/.test(c.ref) && pins.length <= 24 && !/USB/.test(c.fp.id);
    const left = isConn ? pins : pins.slice(0, half);
    const right = isConn ? [] : pins.slice(half);
    const pitch = 20, stub = 22;
    const rows = Math.max(left.length, right.length);
    const nameW = (arr: PinRef[]) => Math.max(0, ...arr.map((p) => p.name.length)) * 7 + 12;
    const boxW = Math.max(110, nameW(left) + (right.length ? nameW(right) : 0) + 24, (c.comp.value.length + 2) * 7);
    const boxH = rows * pitch + 36;
    const lw = Math.max(40, ...left.map((p) => termWidth(p.net, pinLbl(p.id))));
    const rw = right.length ? Math.max(40, ...right.map((p) => termWidth(p.net, pinLbl(p.id)))) : 14;
    const w = lw + stub + boxW + (right.length ? stub : 0) + rw;
    items.push({ order: order(c.ref), ref: c.ref, p: { w, h: boxH + 28 + (note ? 14 : 0), draw: (x, y) => {
      const bx = x + lw + stub, by = y + 14;
      out.add(`<g class="sch-sym" data-ref="${esc(c.ref)}"><title>${esc(c.ref)} ${esc(c.comp.value)} (${esc(c.fp.id)})${c.comp.mpn ? ` - ${esc(c.comp.mpn)}` : ''}</title>`);
      out.add(`<rect class="sch-box" x="${bx}" y="${by}" width="${boxW}" height="${boxH}" rx="2"/>`);
      out.add(`<text class="sch-ref" x="${bx}" y="${by - 4}">${esc(c.ref)}</text><text class="sch-val" x="${bx + boxW}" y="${by - 4}" text-anchor="end">${esc(c.comp.value)}</text>`);
      if (note) out.add(`<text class="sch-ai" x="${bx}" y="${by + boxH + 12}">${esc(note)}</text>`);
      out.add('</g>');
      left.forEach((p, i) => {
        const py = by + 28 + i * pitch;
        out.add(`<line class="sch-wire" x1="${bx - stub}" y1="${py}" x2="${bx}" y2="${py}"/><text class="sch-pin" x="${bx - 4}" y="${py - 3}" text-anchor="end">${esc(p.id)}</text>`);
        out.add(`<text class="sch-pname" x="${bx + 6}" y="${py + 4}">${esc(p.name)}</text>`);
        terminal(bx - stub, py, -1, p.net, pinLbl(p.id));
      });
      right.forEach((p, i) => {
        const py = by + 28 + i * pitch;
        out.add(`<line class="sch-wire" x1="${bx + boxW}" y1="${py}" x2="${bx + boxW + stub}" y2="${py}"/><text class="sch-pin" x="${bx + boxW + 4}" y="${py - 3}">${esc(p.id)}</text>`);
        out.add(`<text class="sch-pname" x="${bx + boxW - 6}" y="${py + 4}" text-anchor="end">${esc(p.name)}</text>`);
        terminal(bx + boxW + stub, py, 1, p.net, pinLbl(p.id));
      });
    } } });
  }
  items.sort((a, b) => a.order - b.order || a.ref.localeCompare(b.ref, undefined, { numeric: true }));

  // ------ flow layout ------
  const margin = 40, gapX = 36, gapY = 30, titleH = 70;
  const targetW = Math.max(900, Math.min(1800, Math.sqrt(items.reduce((s, i) => s + i.p.w * i.p.h, 0) * 2.2)));
  let x = margin, y = margin + titleH, rowH = 0, maxX = 0;
  const placed: { x: number; y: number; it: typeof items[0] }[] = [];
  let lastOrder = -1;
  for (const it of items) {
    if (it.order !== lastOrder && lastOrder !== -1 && x > margin) { x = margin; y += rowH + gapY; rowH = 0; }
    if (x + it.p.w > targetW && x > margin) { x = margin; y += rowH + gapY; rowH = 0; }
    placed.push({ x, y, it });
    x += it.p.w + gapX;
    rowH = Math.max(rowH, it.p.h);
    maxX = Math.max(maxX, x - gapX);
    lastOrder = it.order;
  }
  const W = Math.max(maxX + margin, 700), H = y + rowH + margin;
  for (const p of placed) p.it.p.draw(p.x, p.y);

  // title block
  const head = `<rect class="sch-sheet" x="8" y="8" width="${W - 16}" height="${H - 16}"/>`
    + `<text class="sch-title" x="${margin}" y="${margin + 18}">${esc(board.design.name)}</text>`
    + `<text class="sch-val" x="${margin}" y="${margin + 38}">${esc(board.design.description.slice(0, 140))}</text>`
    + `<text class="sch-pin" x="${W - margin}" y="${margin + 18}" text-anchor="end">${items.length} symbols · ${board.nets.length} nets · generated from PCB by PCBx2energy</text>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="sch">${head}${out.parts.join('')}</svg>`;
  return { svg, width: W, height: H, symbols: items.length };
}

/** Standalone SVG for download (inlines the stylesheet). */
export function schematicDownload(s: Schematic, dark: boolean): string {
  const c = dark
    ? { bg: '#0d1117', sheet: '#30363d', wire: '#7ee787', body: '#e6edf3', box: '#58a6ff', fill: '#161b22', text: '#e6edf3', muted: '#8b949e', ai: '#e3b341', flag: '#1f6feb' }
    : { bg: '#ffffff', sheet: '#8b949e', wire: '#0a7d2c', body: '#24292f', box: '#0b5cad', fill: '#fffbe6', text: '#24292f', muted: '#57606a', ai: '#9a6700', flag: '#0969da' };
  const css = `<style>.sch{background:${c.bg};font-family:system-ui,sans-serif}.sch-sheet{fill:none;stroke:${c.sheet}}.sch-wire{stroke:${c.wire};stroke-width:1.4;fill:none}.sch-body{stroke:${c.body};stroke-width:1.6;fill:none}.sch-box{stroke:${c.box};stroke-width:1.6;fill:${c.fill}}.sch-flag{fill:none;stroke:${c.flag};stroke-width:1}.sch-power{fill:${c.wire}}.sch-nc{stroke:#f85149;stroke-width:1.5;fill:none}text{font-size:11px;fill:${c.text}}.sch-title{font-size:20px;font-weight:700}.sch-ref{font-weight:700;fill:${c.box}}.sch-val{fill:${c.muted}}.sch-pin{font-size:9px;fill:${c.muted}}.sch-pname{font-size:10.5px}.sch-ai{fill:${c.ai};font-style:italic}</style>`;
  return s.svg.replace('>', `>${css}`);
}
