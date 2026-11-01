// Silkscreen generation: body outlines clipped away from pads, pin-1 markers, reference designators.
import { textStrokes, textWidth } from './font';
import { rotPt, courtyardRect, type Rect } from './layout';
import type { Board } from './types';

export interface SilkLine { pts: [number, number][]; w: number }
export interface SilkText { text: string; x: number; y: number; h: number; ref: string }

export interface Silk { lines: SilkLine[]; texts: SilkText[] }

const LINE_W = 0.15;

function clipSegment(a: [number, number], b: [number, number], rects: Rect[]): [number, number][][] {
  // Remove parts of segment a-b that lie inside any rect (Liang-Barsky intervals).
  let keep: [number, number][] = [[0, 1]];
  const dx = b[0] - a[0], dy = b[1] - a[1];
  for (const r of rects) {
    let t0 = 0, t1 = 1;
    const p = [-dx, dx, -dy, dy];
    const q = [a[0] - r.x0, r.x1 - a[0], a[1] - r.y0, r.y1 - a[1]];
    let hit = true;
    for (let i = 0; i < 4; i++) {
      if (Math.abs(p[i]) < 1e-12) { if (q[i] < 0) { hit = false; break; } continue; }
      const t = q[i] / p[i];
      if (p[i] < 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
    }
    if (!hit || t0 >= t1) continue;
    const next: [number, number][] = [];
    for (const [s, e] of keep) {
      if (e <= t0 || s >= t1) { next.push([s, e]); continue; }
      if (s < t0) next.push([s, t0]);
      if (e > t1) next.push([t1, e]);
    }
    keep = next;
  }
  return keep.filter(([s, e]) => (e - s) * Math.hypot(dx, dy) > 0.2).map(([s, e]) => [
    [a[0] + dx * s, a[1] + dy * s], [a[0] + dx * e, a[1] + dy * e],
  ]);
}

export function buildSilk(board: Board): Silk {
  const lines: SilkLine[] = [];
  const texts: SilkText[] = [];
  const padRects: Rect[] = board.pads.map((p) => ({ x0: p.x - p.w / 2 - 0.2, y0: p.y - p.h / 2 - 0.2, x1: p.x + p.w / 2 + 0.2, y1: p.y + p.h / 2 + 0.2 }));
  const bodies: Rect[] = [];
  for (const c of board.comps) {
    const kind = c.fp.body.kind;
    if (kind === 'hole') continue;
    const swap = c.rot % 180 !== 0;
    const bw = (swap ? c.fp.body.h : c.fp.body.w) / 2 + 0.1;
    const bh = (swap ? c.fp.body.w : c.fp.body.h) / 2 + 0.1;
    const r: Rect = { x0: c.x - bw, y0: c.y - bh, x1: c.x + bw, y1: c.y + bh };
    bodies.push(r);
    const corners: [number, number][] = [[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]];
    for (let i = 0; i < 4; i++) {
      for (const seg of clipSegment(corners[i], corners[(i + 1) % 4], padRects)) lines.push({ pts: seg, w: LINE_W });
    }
    // Pin-1 / polarity marker: small dot just outside pad 1 (for parts with >2 pins or polarized ones).
    const polar = /LED|D_|CP_|SOT|SOIC|TSSOP|LQFP|DIP|ESP32|PinHeader_2/.test(c.fp.id) || c.fp.pinCount > 2;
    if (polar) {
      const p1 = c.fp.pads.find((p) => p.pin === '1');
      if (p1) {
        const [dx, dy] = rotPt(p1.x, p1.y, c.rot);
        const px = c.x + dx, py = c.y + dy;
        // push the marker outward from component centre
        const vx = px - c.x, vy = py - c.y;
        const len = Math.hypot(vx, vy) || 1;
        const pw = swap ? p1.h : p1.w, ph = swap ? p1.w : p1.h;
        const off = Math.max(pw, ph) / 2 + 0.45;
        let mx = px + (vx / len) * off, my = py + (vy / len) * off;
        if (!Number.isFinite(mx)) { mx = px; my = py; }
        const hit = padRects.some((pr) => mx > pr.x0 - 0.1 && mx < pr.x1 + 0.1 && my > pr.y0 - 0.1 && my < pr.y1 + 0.1);
        if (!hit) {
          const d = 0.15;
          lines.push({ pts: [[mx - d, my], [mx + d, my]], w: 0.3 });
        }
      }
    }
  }
  // Reference designators.
  const used: Rect[] = [];
  const inside = (r: Rect) => r.x0 > 0.5 && r.y0 > 0.5 && r.x1 < board.width - 0.5 && r.y1 < board.height - 0.5;
  const clash = (r: Rect, self: Rect) =>
    padRects.some((p) => over(r, p)) || used.some((u) => over(r, u)) || bodies.some((b) => b !== self && over(r, b));
  board.comps.forEach((c) => {
    if (c.fp.body.kind === 'hole') return;
    const cr = courtyardRect(c.fp, c.x, c.y, c.rot);
    const self = bodies[board.comps.filter((k) => k.fp.body.kind !== 'hole').indexOf(c)];
    for (const h of [1.0, 0.8]) {
      const tw = textWidth(c.ref, h);
      const cands: [number, number][] = [
        [c.x, cr.y1 + h / 2 + 0.15], [c.x, cr.y0 - h / 2 - 0.15],
        [cr.x0 - tw / 2 - 0.2, c.y], [cr.x1 + tw / 2 + 0.2, c.y],
        [cr.x0 + tw / 2, cr.y1 + h / 2 + 0.15], [cr.x1 - tw / 2, cr.y0 - h / 2 - 0.15],
      ];
      // inside body for large parts
      if (self && self.x1 - self.x0 > tw + 1 && self.y1 - self.y0 > h + 1) cands.push([c.x, c.y]);
      for (const [x, y] of cands) {
        const r: Rect = { x0: x - tw / 2 - 0.1, y0: y - h / 2 - 0.1, x1: x + tw / 2 + 0.1, y1: y + h / 2 + 0.1 };
        const isInsideBody = x === c.x && y === c.y;
        if (!inside(r)) continue;
        if (isInsideBody ? padRects.some((p) => over(r, p)) || used.some((u) => over(r, u)) : clash(r, self)) continue;
        used.push(r);
        texts.push({ text: c.ref, x, y, h, ref: c.ref });
        return;
      }
    }
  });
  // Board name + date in a free spot.
  const title = board.design.name.slice(0, 32);
  for (const h of [1.2, 1.0]) {
    const tw = textWidth(title, h);
    let placed = false;
    for (let y = 1.5; y < board.height - 1.5 && !placed; y += 0.5) {
      for (let x = tw / 2 + 1.5; x < board.width - tw / 2 - 1.5; x += 0.5) {
        const r: Rect = { x0: x - tw / 2 - 0.3, y0: y - h / 2 - 0.3, x1: x + tw / 2 + 0.3, y1: y + h / 2 + 0.3 };
        if (padRects.some((p) => over(r, p)) || used.some((u) => over(r, u)) || bodies.some((b) => over(r, b))) continue;
        if (board.tracks.length === 0 && board.comps.some((c) => over(r, courtyardRect(c.fp, c.x, c.y, c.rot)))) continue;
        used.push(r);
        texts.push({ text: title, x, y, h, ref: '' });
        placed = true;
        break;
      }
    }
    if (placed) break;
  }
  for (const t of texts) {
    for (const pts of textStrokes(t.text, t.x, t.y, t.h)) lines.push({ pts, w: t.h >= 1 ? 0.15 : 0.13 });
  }
  return { lines, texts };
}

const over = (a: Rect, b: Rect) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
