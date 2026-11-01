// Canvas 2D drawing helpers shared by the 2D viewer and the 3D texture generator.
// All functions draw in board millimetres; callers set up the transform (y-up).
import { pourClearance } from './gerber';
import type { Board, Track, WorldPad } from './types';

export function roundedRectPath(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, r: number) {
  r = Math.max(0, Math.min(r, (x1 - x0) / 2, (y1 - y0) / 2));
  ctx.moveTo(x0 + r, y0);
  ctx.lineTo(x1 - r, y0);
  ctx.arcTo(x1, y0, x1, y0 + r, r);
  ctx.lineTo(x1, y1 - r);
  ctx.arcTo(x1, y1, x1 - r, y1, r);
  ctx.lineTo(x0 + r, y1);
  ctx.arcTo(x0, y1, x0, y1 - r, r);
  ctx.lineTo(x0, y0 + r);
  ctx.arcTo(x0, y0, x0 + r, y0, r);
  ctx.closePath();
}

export function padPath(ctx: CanvasRenderingContext2D, p: Pick<WorldPad, 'x' | 'y' | 'w' | 'h' | 'shape'>, grow = 0) {
  const w = p.w + 2 * grow, h = p.h + 2 * grow;
  if (p.shape === 'circle') { ctx.moveTo(p.x + Math.max(w, h) / 2, p.y); ctx.arc(p.x, p.y, Math.max(w, h) / 2, 0, Math.PI * 2); return; }
  if (p.shape === 'oval') { roundedRectPath(ctx, p.x - w / 2, p.y - h / 2, p.x + w / 2, p.y + h / 2, Math.min(w, h) / 2); return; }
  // slightly rounded rect looks closer to real pads
  roundedRectPath(ctx, p.x - w / 2, p.y - h / 2, p.x + w / 2, p.y + h / 2, Math.min(w, h) * 0.12);
}

export function strokeTrack(ctx: CanvasRenderingContext2D, t: Pick<Track, 'pts' | 'width'>, grow = 0) {
  ctx.lineWidth = t.width + 2 * grow;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  t.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  if (t.pts.length === 1) ctx.lineTo(t.pts[0][0] + 1e-3, t.pts[0][1]);
  ctx.stroke();
}

/** Does this pad have copper on physical layer `layer`? SMD: top only. THT: every layer. */
export const padOnLayer = (p: Pick<WorldPad, 'type' | 'top'>, layer: number) => (p.type === 'tht' ? true : p.type === 'smd' ? layer === 0 && p.top : false);

/** Net filled solid on this layer (inner plane or legacy 2-layer bottom pour), or -1. */
export function fillNetOf(board: Board, layer: number): number {
  const pl = board.planes.find((q) => q.layer === layer);
  if (pl) return pl.net;
  return board.pourNet >= 0 && layer === board.layers - 1 ? board.pourNet : -1;
}

export function holePath(ctx: CanvasRenderingContext2D, p: WorldPad) {
  if (p.slot) {
    const { w, h } = p.slot;
    roundedRectPath(ctx, p.x - w / 2, p.y - h / 2, p.x + w / 2, p.y + h / 2, Math.min(w, h) / 2);
  } else if (p.drill) {
    ctx.moveTo(p.x + p.drill / 2, p.y);
    ctx.arc(p.x, p.y, p.drill / 2, 0, Math.PI * 2);
  }
}

/**
 * Draw the copper of one layer (pads, tracks, vias and - on the pour layer - the ground pour)
 * in a single colour. Uses an offscreen canvas so pour clearances don't erase other layers.
 */
export function drawCopperLayer(ctx: CanvasRenderingContext2D, board: Board, layer: number, color: string, opts: { pour: boolean; highlightNet?: number; dim?: boolean } = { pour: true }) {
  const c = ctx.canvas;
  const off = document.createElement('canvas');
  off.width = c.width;
  off.height = c.height;
  const o = off.getContext('2d')!;
  o.setTransform(ctx.getTransform());
  o.fillStyle = color;
  o.strokeStyle = color;
  const fillNet = fillNetOf(board, layer);
  if (opts.pour && fillNet >= 0) {
    const e = board.settings.edgeClearance;
    o.beginPath();
    roundedRectPath(o, e, e, board.width - e, board.height - e, Math.max(0, board.cornerRadius - e));
    o.fill();
    o.globalCompositeOperation = 'destination-out';
    const pc = pourClearance(board);
    o.beginPath();
    for (const p of board.pads) {
      if (p.type === 'npth') { o.moveTo(p.x + (p.drill ?? p.w) / 2 + pc, p.y); o.arc(p.x, p.y, (p.drill ?? p.w) / 2 + pc, 0, Math.PI * 2); continue; }
      if (!padOnLayer(p, layer) || p.net === fillNet) continue;
      padPath(o, p, pc);
    }
    for (const v of board.vias) if (v.net !== fillNet) { o.moveTo(v.x + v.d / 2 + pc, v.y); o.arc(v.x, v.y, v.d / 2 + pc, 0, Math.PI * 2); }
    for (const k of board.keepouts) o.rect(k.x0, k.y0, k.x1 - k.x0, k.y1 - k.y0);
    o.fill();
    for (const t of board.tracks) if (t.layer === layer && t.net !== fillNet) strokeTrack(o, t, pc);
    o.globalCompositeOperation = 'source-over';
  }
  o.beginPath();
  for (const p of board.pads) if (padOnLayer(p, layer)) padPath(o, p);
  for (const v of board.vias) { o.moveTo(v.x + v.d / 2, v.y); o.arc(v.x, v.y, v.d / 2, 0, Math.PI * 2); }
  o.fill();
  for (const t of board.tracks) if (t.layer === layer) strokeTrack(o, t);
  // punch holes
  o.globalCompositeOperation = 'destination-out';
  o.beginPath();
  for (const p of board.pads) if (p.type !== 'smd') holePath(o, p);
  for (const v of board.vias) { o.moveTo(v.x + v.drill / 2, v.y); o.arc(v.x, v.y, v.drill / 2, 0, Math.PI * 2); }
  o.fill();
  o.globalCompositeOperation = 'source-over';
  if (opts.highlightNet !== undefined && opts.highlightNet >= 0) {
    o.fillStyle = '#ffffff';
    o.strokeStyle = '#ffffff';
    o.globalAlpha = 0.55;
    o.beginPath();
    for (const p of board.pads) if (p.net === opts.highlightNet && padOnLayer(p, layer)) padPath(o, p);
    for (const v of board.vias) if (v.net === opts.highlightNet) { o.moveTo(v.x + v.d / 2, v.y); o.arc(v.x, v.y, v.d / 2, 0, Math.PI * 2); }
    o.fill();
    for (const t of board.tracks) if (t.layer === layer && t.net === opts.highlightNet) strokeTrack(o, t);
    o.globalAlpha = 1;
  }
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (opts.dim) ctx.globalAlpha = 0.45;
  ctx.drawImage(off, 0, 0);
  ctx.restore();
}
