// Geometric design-rule check on the routed board (clearance, edge clearance, connectivity).
import { boardSdf, padShape } from './router';
import type { Board } from './types';

export interface DrcIssue { kind: 'clearance' | 'unrouted' | 'edge' | 'warning'; msg: string; x?: number; y?: number }

type Cap = { ax: number; ay: number; bx: number; by: number; r: number } | { rect: [number, number, number, number] };
interface Obj { net: number; layer: number; cap: Cap; what: string; box: [number, number, number, number] }

function segSegDist(a: [number, number], b: [number, number], c: [number, number], d: [number, number]): number {
  if (segIntersect(a, b, c, d)) return 0;
  return Math.min(ptSeg(a, c, d), ptSeg(b, c, d), ptSeg(c, a, b), ptSeg(d, a, b));
}
function ptSeg(p: [number, number], a: [number, number], b: [number, number]) {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const l2 = vx * vx + vy * vy;
  let t = l2 ? ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - a[0] - t * vx, p[1] - a[1] - t * vy);
}
function segIntersect(a: [number, number], b: [number, number], c: [number, number], d: [number, number]) {
  const o = (p: [number, number], q: [number, number], r: [number, number]) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
  return o1 !== o2 && o3 !== o4 && o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0;
}
function rectSegDist(r: [number, number, number, number], a: [number, number], b: [number, number]) {
  const inside = (p: [number, number]) => p[0] >= r[0] && p[0] <= r[2] && p[1] >= r[1] && p[1] <= r[3];
  if (inside(a) || inside(b)) return 0;
  const cs: [number, number][] = [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]];
  let d = Infinity;
  for (let i = 0; i < 4; i++) d = Math.min(d, segSegDist(a, b, cs[i], cs[(i + 1) % 4]));
  return d;
}
function dist(p: Cap, q: Cap): number {
  if ('rect' in p && 'rect' in q) {
    const dx = Math.max(p.rect[0] - q.rect[2], q.rect[0] - p.rect[2], 0);
    const dy = Math.max(p.rect[1] - q.rect[3], q.rect[1] - p.rect[3], 0);
    return Math.hypot(dx, dy);
  }
  if ('rect' in p) return dist(q, p);
  if ('rect' in q) return rectSegDist(q.rect, [p.ax, p.ay], [p.bx, p.by]) - p.r;
  return segSegDist([p.ax, p.ay], [p.bx, p.by], [q.ax, q.ay], [q.bx, q.by]) - p.r - q.r;
}

export function runDrc(board: Board): DrcIssue[] {
  const s = board.settings;
  const issues: DrcIssue[] = [];
  const objs: Obj[] = [];
  const add = (net: number, layer: number, cap: Cap, what: string) => {
    const box: [number, number, number, number] = 'rect' in cap ? cap.rect
      : [Math.min(cap.ax, cap.bx) - cap.r, Math.min(cap.ay, cap.by) - cap.r, Math.max(cap.ax, cap.bx) + cap.r, Math.max(cap.ay, cap.by) + cap.r];
    objs.push({ net, layer, cap, what, box });
  };
  for (const p of board.pads) {
    if (p.type === 'npth') {
      for (const L of [0, 1]) add(-100 - p.id, L, { ax: p.x, ay: p.y, bx: p.x, by: p.y, r: (p.drill ?? p.w) / 2 }, `hole ${p.ref}`);
      continue;
    }
    const sh = padShape(p);
    const cap: Cap = sh.t === 'rect' ? { rect: [sh.x0, sh.y0, sh.x1, sh.y1] } : sh.t === 'circle' ? { ax: sh.x, ay: sh.y, bx: sh.x, by: sh.y, r: sh.r } : sh;
    const net = p.net >= 0 ? p.net : -1000 - p.id;
    if (p.top) add(net, 0, cap, `pad ${p.ref}.${p.pin}`);
    if (p.bottom) add(net, 1, cap, `pad ${p.ref}.${p.pin}`);
  }
  for (const t of board.tracks) for (let i = 0; i + 1 < t.pts.length; i++) {
    add(t.net, t.layer, { ax: t.pts[i][0], ay: t.pts[i][1], bx: t.pts[i + 1][0], by: t.pts[i + 1][1], r: t.width / 2 }, `track ${board.nets[t.net]?.name}`);
  }
  for (const v of board.vias) for (const L of [0, 1]) add(v.net, L, { ax: v.x, ay: v.y, bx: v.x, by: v.y, r: v.d / 2 }, `via ${board.nets[v.net]?.name}`);

  // spatial hash
  const cell = 2;
  const grid = new Map<string, number[]>();
  objs.forEach((o, i) => {
    for (let gx = Math.floor(o.box[0] / cell); gx <= Math.floor(o.box[2] / cell); gx++)
      for (let gy = Math.floor(o.box[1] / cell); gy <= Math.floor(o.box[3] / cell); gy++) {
        const k = `${gx},${gy}`;
        const a = grid.get(k);
        if (a) a.push(i); else grid.set(k, [i]);
      }
  });
  const checked = new Set<string>();
  const tol = 0.005; // grid rounding tolerance
  let count = 0;
  for (const idxs of grid.values()) {
    for (let a = 0; a < idxs.length; a++) for (let b = a + 1; b < idxs.length; b++) {
      const A = objs[idxs[a]], B = objs[idxs[b]];
      if (A.layer !== B.layer || A.net === B.net) continue;
      // pads of the same footprint are a fixed land pattern - not our violation
      if (A.what.startsWith('pad') && B.what.startsWith('pad')) continue;
      const key = idxs[a] < idxs[b] ? `${idxs[a]}:${idxs[b]}` : `${idxs[b]}:${idxs[a]}`;
      if (checked.has(key)) continue;
      checked.add(key);
      const d = dist(A.cap, B.cap);
      if (d < s.clearance - tol) {
        count++;
        if (count <= 50) {
          const x = (Math.max(A.box[0], B.box[0]) + Math.min(A.box[2], B.box[2])) / 2;
          const y = (Math.max(A.box[1], B.box[1]) + Math.min(A.box[3], B.box[3])) / 2;
          issues.push({ kind: 'clearance', msg: `${A.what} ↔ ${B.what} on ${A.layer ? 'B.Cu' : 'F.Cu'}: ${Math.max(0, d).toFixed(3)} mm < ${s.clearance} mm`, x, y });
        }
      }
    }
  }
  if (count > 50) issues.push({ kind: 'clearance', msg: `…and ${count - 50} more clearance violations` });
  for (const t of board.tracks) for (const [x, y] of t.pts) {
    if (boardSdf(board.width, board.height, board.cornerRadius, x, y) > -(t.width / 2 + Math.min(0.3, s.edgeClearance) - 0.01)) {
      issues.push({ kind: 'edge', msg: `Track ${board.nets[t.net]?.name} too close to board edge`, x, y });
      break;
    }
  }
  for (const u of board.unrouted) {
    issues.push({ kind: 'unrouted', msg: `Unrouted: ${board.nets[u.net]?.name} near (${u.a[0].toFixed(1)}, ${u.a[1].toFixed(1)})`, x: u.a[0], y: u.a[1] });
  }
  for (const w of board.warnings) issues.push({ kind: 'warning', msg: w });
  return issues;
}
