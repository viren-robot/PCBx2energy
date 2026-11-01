// Gerber RS-274X (with X2 file attributes) and Excellon drill writers.
import { fillNetOf, padOnLayer } from './draw';
import { buildSilk, type Silk } from './silk';
import type { Board } from './types';

const fmt = (v: number) => Math.round(v * 1e6).toString(); // 4.6 format, mm

export class GerberWriter {
  private aps = new Map<string, number>();
  private body: string[] = [];
  private cur = -1;
  constructor(private fileFunction: string, private polarityAttr: 'Positive' | 'Negative' = 'Positive', private date = new Date()) {}

  private ap(def: string): number {
    let d = this.aps.get(def);
    if (d === undefined) { d = 10 + this.aps.size; this.aps.set(def, d); }
    if (this.cur !== d) { this.body.push(`D${d}*`); this.cur = d; }
    return d;
  }
  static circle(d: number) { return `C,${d.toFixed(4)}`; }
  polarity(p: 'D' | 'C') { this.body.push(`%LP${p}*%`); }
  flashPad(x: number, y: number, w: number, h: number, shape: 'rect' | 'circle' | 'oval') {
    const def = shape === 'circle' ? GerberWriter.circle(Math.max(w, h))
      : shape === 'oval' ? (Math.abs(w - h) < 1e-6 ? GerberWriter.circle(w) : `O,${w.toFixed(4)}X${h.toFixed(4)}`)
        : `R,${w.toFixed(4)}X${h.toFixed(4)}`;
    this.ap(def);
    this.body.push(`X${fmt(x)}Y${fmt(y)}D03*`);
  }
  polyline(pts: [number, number][], width: number) {
    if (pts.length < 2) {
      if (pts.length === 1) { this.ap(GerberWriter.circle(width)); this.body.push(`X${fmt(pts[0][0])}Y${fmt(pts[0][1])}D03*`); }
      return;
    }
    this.ap(GerberWriter.circle(width));
    this.body.push(`X${fmt(pts[0][0])}Y${fmt(pts[0][1])}D02*`);
    for (let i = 1; i < pts.length; i++) this.body.push(`X${fmt(pts[i][0])}Y${fmt(pts[i][1])}D01*`);
  }
  region(pts: [number, number][]) {
    if (pts.length < 3) return;
    this.body.push('G36*');
    this.body.push(`X${fmt(pts[0][0])}Y${fmt(pts[0][1])}D02*`);
    for (let i = 1; i < pts.length; i++) this.body.push(`X${fmt(pts[i][0])}Y${fmt(pts[i][1])}D01*`);
    this.body.push(`X${fmt(pts[0][0])}Y${fmt(pts[0][1])}D01*`);
    this.body.push('G37*');
  }
  toString(): string {
    const head = [
      '%TF.GenerationSoftware,PCBx2energy,TextToPCB,0.1*%',
      `%TF.CreationDate,${this.date.toISOString().replace(/\.\d+Z$/, '+00:00')}*%`,
      '%TF.SameCoordinates,Original*%',
      `%TF.FileFunction,${this.fileFunction}*%`,
      `%TF.FilePolarity,${this.polarityAttr}*%`,
      '%FSLAX46Y46*%',
      '%MOMM*%',
      '%LPD*%',
      'G01*',
      'G75*',
    ];
    for (const [def, d] of this.aps) head.push(`%ADD${d}${def}*%`);
    return [...head, ...this.body, 'M02*', ''].join('\n');
  }
}

export function roundedRect(x0: number, y0: number, x1: number, y1: number, r: number, seg = 10): [number, number][] {
  const pts: [number, number][] = [];
  r = Math.max(0, Math.min(r, (x1 - x0) / 2, (y1 - y0) / 2));
  if (r < 1e-6) return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const corners: [number, number, number][] = [[x1 - r, y0 + r, -90], [x1 - r, y1 - r, 0], [x0 + r, y1 - r, 90], [x0 + r, y0 + r, 180]];
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i <= seg; i++) {
      const a = ((a0 + (90 * i) / seg) * Math.PI) / 180;
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  }
  return pts;
}

export interface LayerSet {
  /** Inner copper layers in order (empty for 2-layer boards). */
  inner: string[];
  F_Cu: string; B_Cu: string; F_Mask: string; B_Mask: string; F_Silk: string; B_Silk: string; F_Paste: string; B_Paste: string; Edge_Cuts: string;
  PTH: string; NPTH: string;
}

const MASK_EXP = 0.05;

function copper(board: Board, layer: number, date: Date): string {
  const NL = board.layers;
  const fn = layer === 0 ? 'Copper,L1,Top' : layer === NL - 1 ? `Copper,L${NL},Bot` : `Copper,L${layer + 1},Inr`;
  const gw = new GerberWriter(fn, 'Positive', date);
  const s = board.settings;
  const fillNet = fillNetOf(board, layer);
  if (fillNet >= 0) {
    const e = s.edgeClearance;
    gw.region(roundedRect(e, e, board.width - e, board.height - e, Math.max(0, board.cornerRadius - e)));
    gw.polarity('C');
    const pc = pourClearance(board);
    for (const p of board.pads) {
      if (p.type === 'npth') { gw.flashPad(p.x, p.y, (p.drill ?? p.w) + 2 * pc, (p.drill ?? p.w) + 2 * pc, 'circle'); continue; }
      if (!padOnLayer(p, layer) || p.net === fillNet) continue;
      gw.flashPad(p.x, p.y, p.w + 2 * pc, p.h + 2 * pc, p.shape === 'rect' ? 'rect' : p.shape);
    }
    for (const t of board.tracks) if (t.layer === layer && t.net !== fillNet) gw.polyline(t.pts, t.width + 2 * pc);
    for (const v of board.vias) if (v.net !== fillNet) gw.flashPad(v.x, v.y, v.d + 2 * pc, v.d + 2 * pc, 'circle');
    for (const k of board.keepouts) gw.region([[k.x0, k.y0], [k.x1, k.y0], [k.x1, k.y1], [k.x0, k.y1]]);
    gw.polarity('D');
  }
  for (const p of board.pads) if (padOnLayer(p, layer)) gw.flashPad(p.x, p.y, p.w, p.h, p.shape);
  for (const t of board.tracks) if (t.layer === layer) gw.polyline(t.pts, t.width);
  for (const v of board.vias) gw.flashPad(v.x, v.y, v.d, v.d, 'circle');
  return gw.toString();
}

export const pourClearance = (b: Board) => Math.max(b.settings.clearance + 0.1, 0.3);

function mask(board: Board, layer: 0 | 1, date: Date): string {
  const gw = new GerberWriter(layer === 0 ? 'Soldermask,Top' : 'Soldermask,Bot', 'Negative', date);
  for (const p of board.pads) {
    if (p.type === 'npth') { const d = (p.drill ?? p.w) + 2 * MASK_EXP; gw.flashPad(p.x, p.y, d, d, 'circle'); continue; }
    if (layer === 0 ? !p.top : !p.bottom) continue;
    gw.flashPad(p.x, p.y, p.w + 2 * MASK_EXP, p.h + 2 * MASK_EXP, p.shape);
  }
  return gw.toString();
}

function paste(board: Board, layer: 0 | 1, date: Date): string {
  const gw = new GerberWriter(layer === 0 ? 'Paste,Top' : 'Paste,Bot', 'Positive', date);
  if (layer === 0) for (const p of board.pads) if (p.type === 'smd') {
    const big = p.w * p.h > 9; // reduce paste on large thermal pads
    gw.flashPad(p.x, p.y, big ? p.w * 0.8 : p.w, big ? p.h * 0.8 : p.h, p.shape);
  }
  return gw.toString();
}

function silkLayer(silk: Silk | null, layer: 0 | 1, date: Date): string {
  const gw = new GerberWriter(layer === 0 ? 'Legend,Top' : 'Legend,Bot', 'Positive', date);
  if (silk && layer === 0) for (const l of silk.lines) gw.polyline(l.pts, l.w);
  return gw.toString();
}

function outline(board: Board, date: Date): string {
  const gw = new GerberWriter('Profile,NP', 'Positive', date);
  const pts = roundedRect(0, 0, board.width, board.height, board.cornerRadius, 16);
  gw.polyline([...pts, pts[0]], 0.1);
  return gw.toString();
}

const dfmt = (v: number) => v.toFixed(4);

export function excellon(board: Board, which: 'PTH' | 'NPTH' | 'ALL', date = new Date()): string {
  type Hole = { x: number; y: number; d: number; slot?: { x0: number; y0: number; x1: number; y1: number } };
  const holes: Hole[] = [];
  for (const p of board.pads) {
    const plated = p.type === 'tht';
    const np = p.type === 'npth';
    if (!plated && !np) continue;
    if (which === 'PTH' && !plated) continue;
    if (which === 'NPTH' && !np) continue;
    if (p.slot) {
      const d = Math.min(p.slot.w, p.slot.h);
      const half = (Math.max(p.slot.w, p.slot.h) - d) / 2;
      const horiz = p.slot.w > p.slot.h;
      holes.push({ x: p.x, y: p.y, d, slot: horiz ? { x0: p.x - half, y0: p.y, x1: p.x + half, y1: p.y } : { x0: p.x, y0: p.y - half, x1: p.x, y1: p.y + half } });
    } else holes.push({ x: p.x, y: p.y, d: p.drill ?? p.w });
  }
  if (which !== 'NPTH') for (const v of board.vias) holes.push({ x: v.x, y: v.y, d: v.drill });
  const tools = [...new Set(holes.map((h) => h.d.toFixed(3)))].sort((a, b) => +a - +b);
  const fn = which === 'PTH' ? 'Plated,1,2,PTH' : which === 'NPTH' ? 'NonPlated,1,2,NPTH' : 'MixedPlating,1,2';
  const out = [
    'M48',
    `; DRILL file {PCBx2energy 0.1} date ${date.toISOString()}`,
    '; FORMAT={-:-/ absolute / metric / decimal}',
    `; #@! TF.FileFunction,${fn}`,
    'FMAT,2',
    'METRIC',
  ];
  tools.forEach((t, i) => out.push(`T${i + 1}C${t}`));
  out.push('%', 'G05');
  tools.forEach((t, i) => {
    out.push(`T${i + 1}`);
    for (const h of holes) {
      if (h.d.toFixed(3) !== t) continue;
      if (h.slot) out.push(`X${dfmt(h.slot.x0)}Y${dfmt(h.slot.y0)}G85X${dfmt(h.slot.x1)}Y${dfmt(h.slot.y1)}`);
      else out.push(`X${dfmt(h.x)}Y${dfmt(h.y)}`);
    }
  });
  out.push('M30', '');
  return out.join('\n');
}

export function buildLayers(board: Board, date = new Date()): LayerSet {
  const silk = buildSilk(board);
  return {
    inner: Array.from({ length: board.layers - 2 }, (_, i) => copper(board, i + 1, date)),
    F_Cu: copper(board, 0, date),
    B_Cu: copper(board, board.layers - 1, date),
    F_Mask: mask(board, 0, date),
    B_Mask: mask(board, 1, date),
    F_Silk: silkLayer(silk, 0, date),
    B_Silk: silkLayer(null, 1, date),
    F_Paste: paste(board, 0, date),
    B_Paste: paste(board, 1, date),
    Edge_Cuts: outline(board, date),
    PTH: excellon(board, 'PTH', date),
    NPTH: excellon(board, 'NPTH', date),
  };
}
