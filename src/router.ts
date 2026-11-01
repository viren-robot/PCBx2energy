// Two-layer grid maze router (A*), with vias, two track-width classes, keep-outs,
// GND-to-pour routing and rip-up/retry. Pure function: runs in a Web Worker or in Node.
import { chooseGrid } from './layout';
import type { Board, RouteResult, Track, Via, WorldPad } from './types';

const FREE = -1;
const BLOCK = -2;

type Shape =
  | { t: 'rect'; x0: number; y0: number; x1: number; y1: number }
  | { t: 'circle'; x: number; y: number; r: number }
  | { t: 'seg'; ax: number; ay: number; bx: number; by: number; r: number };

function shapeDist(s: Shape, px: number, py: number): number {
  if (s.t === 'rect') {
    const dx = Math.max(s.x0 - px, 0, px - s.x1);
    const dy = Math.max(s.y0 - py, 0, py - s.y1);
    return Math.hypot(dx, dy);
  }
  if (s.t === 'circle') return Math.hypot(px - s.x, py - s.y) - s.r;
  const vx = s.bx - s.ax, vy = s.by - s.ay;
  const l2 = vx * vx + vy * vy;
  let t = l2 > 0 ? ((px - s.ax) * vx + (py - s.ay) * vy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (s.ax + t * vx), py - (s.ay + t * vy)) - s.r;
}
function shapeBox(s: Shape): [number, number, number, number] {
  if (s.t === 'rect') return [s.x0, s.y0, s.x1, s.y1];
  if (s.t === 'circle') return [s.x - s.r, s.y - s.r, s.x + s.r, s.y + s.r];
  return [Math.min(s.ax, s.bx) - s.r, Math.min(s.ay, s.by) - s.r, Math.max(s.ax, s.bx) + s.r, Math.max(s.ay, s.by) + s.r];
}

export function padShape(p: WorldPad): Shape {
  if (p.shape === 'circle') return { t: 'circle', x: p.x, y: p.y, r: Math.max(p.w, p.h) / 2 };
  if (p.shape === 'oval') {
    if (p.w >= p.h) { const d = (p.w - p.h) / 2; return { t: 'seg', ax: p.x - d, ay: p.y, bx: p.x + d, by: p.y, r: p.h / 2 }; }
    const d = (p.h - p.w) / 2;
    return { t: 'seg', ax: p.x, ay: p.y - d, bx: p.x, by: p.y + d, r: p.w / 2 };
  }
  return { t: 'rect', x0: p.x - p.w / 2, y0: p.y - p.h / 2, x1: p.x + p.w / 2, y1: p.y + p.h / 2 };
}

/** Signed distance to the rounded-rectangle board outline (negative inside). */
export function boardSdf(W: number, H: number, r: number, px: number, py: number): number {
  const qx = Math.abs(px - W / 2) - (W / 2 - r);
  const qy = Math.abs(py - H / 2) - (H / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

class Heap {
  k: Float64Array = new Float64Array(1024);
  v: Int32Array = new Int32Array(1024);
  n = 0;
  clear() { this.n = 0; }
  push(key: number, val: number) {
    if (this.n === this.k.length) {
      const k = new Float64Array(this.n * 2); k.set(this.k); this.k = k;
      const v = new Int32Array(this.n * 2); v.set(this.v); this.v = v;
    }
    let i = this.n++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.k[p] <= key) break;
      this.k[i] = this.k[p]; this.v[i] = this.v[p]; i = p;
    }
    this.k[i] = key; this.v[i] = val;
  }
  lastKey = 0;
  pop(): number {
    const top = this.v[0];
    this.lastKey = this.k[0];
    const lk = this.k[--this.n], lv = this.v[this.n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.n) break;
      if (c + 1 < this.n && this.k[c + 1] < this.k[c]) c++;
      if (this.k[c] >= lk) break;
      this.k[i] = this.k[c]; this.v[i] = this.v[c]; i = c;
    }
    this.k[i] = lk; this.v[i] = lv;
    return top;
  }
}

interface Node { pads: WorldPad[] } // pads that are already electrically one point

export type Progress = (fraction: number, msg: string) => void;

export function route(board: Board, progress?: Progress): RouteResult {
  const s = board.settings;
  const W = board.width, H = board.height;
  const g = chooseGrid(board.design, s, W, H);
  const nx = Math.floor(W / g) + 1;
  const ny = Math.floor(H / g) + 1;
  const N = nx * ny;
  const log: string[] = [`Grid ${g} mm, ${nx}x${ny} cells x 2 layers`];
  // kinds: 0 = signal track, 1 = power track, 2 = via. map index = kind*2 + layer
  const halfW = [s.trackWidth / 2, s.powerTrackWidth / 2, s.viaDiameter / 2];
  const reach = halfW.map((h) => h + s.clearance);
  const netKind = board.nets.map((n) => (n.width > s.trackWidth + 1e-6 ? 1 : 0));

  const cx = (c: number) => (c % nx) * g;
  const cy = (c: number) => Math.floor(c / nx) * g;

  const stamp = (maps: Int16Array[], layer: number, shape: Shape, net: number, kinds = [0, 1, 2]) => {
    const [bx0, by0, bx1, by1] = shapeBox(shape);
    for (const k of kinds) {
      const m = maps[k * 2 + layer];
      const e = reach[k];
      const i0 = Math.max(0, Math.floor((bx0 - e) / g)), i1 = Math.min(nx - 1, Math.ceil((bx1 + e) / g));
      const j0 = Math.max(0, Math.floor((by0 - e) / g)), j1 = Math.min(ny - 1, Math.ceil((by1 + e) / g));
      for (let j = j0; j <= j1; j++) {
        const row = j * nx;
        for (let i = i0; i <= i1; i++) {
          const c = row + i;
          const v = m[c];
          if (v === BLOCK || v === net) continue;
          if (shapeDist(shape, i * g, j * g) < e - 1e-9) m[c] = v === FREE && net >= 0 ? net : BLOCK;
        }
      }
    }
  };

  // ---------- base obstacle maps ----------
  const base: Int16Array[] = Array.from({ length: 6 }, () => new Int16Array(N).fill(FREE));
  for (let k = 0; k < 3; k++) {
    const lim = -(s.edgeClearance + halfW[k]);
    for (let c = 0; c < N; c++) {
      if (boardSdf(W, H, board.cornerRadius, cx(c), cy(c)) > lim) { base[k * 2][c] = BLOCK; base[k * 2 + 1][c] = BLOCK; }
    }
  }
  for (const ko of board.keepouts) {
    for (const L of [0, 1]) stamp(base, L, { t: 'rect', ...ko }, BLOCK);
  }
  const thtNet = new Int16Array(N).fill(FREE); // cells inside THT copper (free layer change)
  const noVia = new Uint8Array(N); // cells where a via would touch an SMD pad (no via-in-pad)
  const halo = new Int16Array(N).fill(FREE); // cells just outside pads: discourage other nets from hugging them
  for (const p of board.pads) {
    const sh = padShape(p);
    if (p.type === 'npth') {
      for (const L of [0, 1]) stamp(base, L, { t: 'circle', x: p.x, y: p.y, r: (p.drill ?? p.w) / 2 }, BLOCK);
      continue;
    }
    const net = p.net >= 0 ? p.net : BLOCK;
    if (p.type === 'smd') {
      const [x0, y0, x1, y1] = shapeBox(sh);
      const e = s.viaDiameter / 2 + 0.05;
      for (let j = Math.max(0, Math.floor((y0 - e) / g)); j <= Math.min(ny - 1, Math.ceil((y1 + e) / g)); j++)
        for (let i = Math.max(0, Math.floor((x0 - e) / g)); i <= Math.min(nx - 1, Math.ceil((x1 + e) / g)); i++)
          if (shapeDist(sh, i * g, j * g) < e) noVia[j * nx + i] = 1;
    }
    {
      const [x0, y0, x1, y1] = shapeBox(sh);
      const e = reach[0] + 0.5;
      for (let j = Math.max(0, Math.floor((y0 - e) / g)); j <= Math.min(ny - 1, Math.ceil((y1 + e) / g)); j++)
        for (let i = Math.max(0, Math.floor((x0 - e) / g)); i <= Math.min(nx - 1, Math.ceil((x1 + e) / g)); i++) {
          const c = j * nx + i;
          if (shapeDist(sh, i * g, j * g) < e) halo[c] = halo[c] === FREE || halo[c] === net ? net : BLOCK;
        }
    }
    if (p.top) stamp(base, 0, sh, net);
    if (p.bottom) stamp(base, 1, sh, net);
    if (p.type === 'tht' && p.net >= 0) {
      const [x0, y0, x1, y1] = shapeBox(sh);
      for (let j = Math.max(0, Math.floor(y0 / g)); j <= Math.min(ny - 1, Math.ceil(y1 / g)); j++)
        for (let i = Math.max(0, Math.floor(x0 / g)); i <= Math.min(nx - 1, Math.ceil(x1 / g)); i++)
          if (shapeDist(sh, i * g, j * g) <= -Math.min(p.w, p.h) * 0.15) thtNet[j * nx + i] = p.net;
    }
  }

  // ---------- nets -> nodes ----------
  const bridged = new Map<string, string[]>();
  for (const c of board.comps) if (c.fp.bridgedPins) bridged.set(c.ref, c.fp.bridgedPins);
  const netNodes: Node[][] = board.nets.map(() => []);
  {
    const groups = new Map<string, Node>();
    for (const p of board.pads) {
      if (p.net < 0) continue;
      const isBridged = bridged.get(p.ref)?.includes(p.pin);
      const key = isBridged ? `${p.ref}.${p.pin}` : `#${p.id}`;
      let n = groups.get(key);
      if (!n) { n = { pads: [] }; groups.set(key, n); netNodes[p.net].push(n); }
      n.pads.push(p);
    }
  }
  const pourNet = s.groundPour ? board.nets.findIndex((n, i) => n.isGround && netNodes[i].length > 0) : -1;

  // ---------- search state ----------
  const S = 2 * N;
  const gCost = new Float64Array(S);
  const seen = new Int32Array(S);
  const parent = new Int32Array(S);
  const tree = new Int32Array(S);
  let sid = 0;
  let treeId = 0;
  const heap = new Heap();
  const viaCost = Math.max(10, 1.8 / g);
  const pref = [[1, 1.3], [1.3, 1]]; // [layer][horizontal?0:1] multipliers
  const DIRS: [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 1, 1], [0, -1, 1], [1, 1, 2], [1, -1, 2], [-1, 1, 2], [-1, -1, 2]];

  function sourceCells(maps: Int16Array[], node: Node, net: number, kind: number): number[] {
    const out: number[] = [];
    for (const p of node.pads) {
      const sh = padShape(p);
      const [x0, y0, x1, y1] = shapeBox(sh);
      const layers = [p.top ? 0 : -1, p.bottom ? 1 : -1].filter((l) => l >= 0);
      let any = false;
      for (const L of layers) {
        const m = maps[kind * 2 + L];
        for (let j = Math.max(0, Math.ceil(y0 / g)); j <= Math.min(ny - 1, Math.floor(y1 / g)); j++)
          for (let i = Math.max(0, Math.ceil(x0 / g)); i <= Math.min(nx - 1, Math.floor(x1 / g)); i++) {
            const c = j * nx + i;
            if ((m[c] === net || m[c] === FREE) && shapeDist(sh, i * g, j * g) <= 1e-6) { out.push(L * N + c); any = true; }
          }
      }
      if (!any && kind === 0) {
        // fall back to nearest legal cell around pad centre (signal width only; power nets neck down instead)
        let best = -1, bd = Infinity;
        const r = Math.ceil((Math.max(p.w, p.h) / 2 + 0.3) / g);
        const ci = Math.round(p.x / g), cj = Math.round(p.y / g);
        for (const L of layers) {
          const m = maps[kind * 2 + L];
          for (let j = cj - r; j <= cj + r; j++) for (let i = ci - r; i <= ci + r; i++) {
            if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
            const c = j * nx + i;
            if (m[c] !== net && m[c] !== FREE) continue;
            const d = Math.hypot(i * g - p.x, j * g - p.y);
            if (d < bd) { bd = d; best = L * N + c; }
          }
        }
        if (best >= 0 && bd < Math.max(p.w, p.h) / 2 + 0.05) out.push(best);
      }
    }
    return out;
  }

  // ---------- negotiated-congestion state ----------
  // occ[idx][c]: number of nets whose committed copper keeps cell c (map idx = kind*2+layer) out of bounds.
  const occ = Array.from({ length: 6 }, () => new Uint8Array(N));
  const hist = Array.from({ length: 6 }, () => new Float32Array(N));
  const mark = Array.from({ length: 6 }, () => new Int32Array(N));
  let markId = 1;
  interface Conn { path: number[]; kind: number; pad: WorldPad; node?: Node }
  const netConns: Conn[][] = board.nets.map(() => []);
  const netCover: number[][] = board.nets.map(() => []);

  /** A* from src states to any state with tree[s]==treeId, or (pour) bottom cells labelled main.
   *  With pf>=0, other nets' copper (occ) is passable at a growing penalty (PathFinder). */
  function search(maps: Int16Array[], src: number[], net: number, kind: number, box: [number, number, number, number] | null,
    pourLabel: Int32Array | null, mainLabel: number, pf = -1, softPour = false): number[] | null {
    sid++;
    heap.clear();
    const soft = pf >= 0;
    const tm = maps[kind * 2], bm = maps[kind * 2 + 1];
    const vt = maps[4], vb = maps[5];
    const h = (c: number) => {
      if (!box) return 0;
      const i = c % nx, j = (c - i) / nx;
      const dx = Math.max(box[0] - i, 0, i - box[2]);
      const dy = Math.max(box[1] - j, 0, j - box[3]);
      return Math.max(dx, dy) + 0.4142 * Math.min(dx, dy);
    };
    const others = (idx: number, c: number) => occ[idx][c] - (mark[idx][c] === markId ? 1 : 0);
    for (const st of src) {
      seen[st] = sid; gCost[st] = 0; parent[st] = -1;
      heap.push(h(st % N), st);
    }
    let expansions = 0;
    const limit = S * 2;
    while (heap.n) {
      const st = heap.pop();
      const L = st >= N ? 1 : 0;
      const c = st - L * N;
      const gc = gCost[st];
      if (heap.lastKey > (gc + h(c)) * (1 + 1e-12) + 1e-9) continue; // stale heap entry
      if (tree[st] === treeId || (pourLabel && L === 1 && pourLabel[c] === mainLabel)
        || (softPour && L === 1 && (maps[1][c] === FREE || maps[1][c] === net) && others(1, c) === 0 && others(kind * 2 + 1, c) === 0)) {
        const path: number[] = [];
        for (let q = st; q !== -1; q = parent[q]) path.push(q);
        return path.reverse();
      }
      if (++expansions > limit) break;
      const i = c % nx, j = (c - i) / nx;
      const m = L ? bm : tm;
      const idx = kind * 2 + L;
      for (const [di, dj, kd] of DIRS) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
        const nc = jj * nx + ii;
        const v = m[nc];
        if (v !== FREE && v !== net) continue;
        let cost: number;
        if (kd === 2) {
          const a = m[j * nx + ii], b = m[jj * nx + i];
          if ((a !== FREE && a !== net) || (b !== FREE && b !== net)) continue;
          cost = 1.4142 * 1.12;
        } else cost = pref[L][kd];
        const hv = halo[nc];
        if (hv !== FREE && hv !== net) cost += 0.3;
        if (soft) {
          const o = others(idx, nc);
          cost *= (1 + hist[idx][nc]) * (1 + pf * o);
        }
        const ns = L * N + nc;
        const ng = gc + cost;
        if (seen[ns] === sid && gCost[ns] <= ng) continue;
        seen[ns] = sid; gCost[ns] = ng; parent[ns] = st;
        heap.push(ng + h(nc), ns);
      }
      // layer change
      const os = (1 - L) * N + c;
      const ov = (L ? tm : bm)[c];
      if (ov === FREE || ov === net) {
        const free = thtNet[c] === net;
        const vv = vt[c], vw = vb[c];
        if (free || (!noVia[c] && (vv === FREE || vv === net) && (vw === FREE || vw === net))) {
          let cost = free ? 0.01 : viaCost;
          if (soft && !free) {
            const o = others(4, c) + others(5, c) + others(kind * 2 + 1 - L, c);
            cost *= (1 + hist[4][c]) * (1 + pf * o);
          }
          const ng = gc + cost;
          if (!(seen[os] === sid && gCost[os] <= ng)) {
            seen[os] = sid; gCost[os] = ng; parent[os] = st;
            heap.push(ng + h(c), os);
          }
        }
      }
    }
    return null;
  }

  /** Greedy string-pulling restricted to 0/45/90 degree segments, checked against the obstacle map. */
  function straighten(pts: [number, number][], m: Int16Array, net: number, keep?: Set<number>): [number, number][] {
    if (pts.length < 3) return pts;
    const ok = (a: [number, number], b: [number, number]) => {
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const adx = Math.abs(dx), ady = Math.abs(dy);
      if (adx > 1e-6 && ady > 1e-6 && Math.abs(adx - ady) > 1e-6) return false;
      const n = Math.max(1, Math.round(Math.max(adx, ady) / g));
      for (let k = 0; k <= n; k++) {
        const x = a[0] + (dx * k) / n, y = a[1] + (dy * k) / n;
        const c = Math.round(y / g) * nx + Math.round(x / g);
        if (m[c] !== FREE && m[c] !== net) return false;
      }
      return true;
    };
    const out: [number, number][] = [pts[0]];
    let i = 0;
    const kept = (k: number) => !!keep && keep.has(Math.round(pts[k][1] / g) * nx + Math.round(pts[k][0] / g));
    while (i < pts.length - 1) {
      let j = Math.min(pts.length - 1, i + 400);
      for (let k = i + 1; k < j; k++) if (kept(k)) { j = k; break; } // never skip a junction
      while (j > i + 1 && !ok(pts[i], pts[j])) j--;
      out.push(pts[j]);
      i = j;
    }
    return out;
  }

  /** Path -> tracks/vias. If `strict` is given, runs are straightened against it. */
  function geometry(conn: Conn, net: number, strict: Int16Array[] | null, keep?: Set<number>): { tracks: Track[]; vias: Via[] } {
    const { path, kind, pad } = conn;
    const width = kind === 1 ? s.powerTrackWidth : s.trackWidth;
    const tracks: Track[] = [];
    const vias: Via[] = [];
    let run: [number, number][] = [];
    let runL = path[0] >= N ? 1 : 0;
    const flush = () => {
      if (run.length >= 2) {
        const pts = simplify(strict ? straighten(run, strict[kind * 2 + runL], net, keep) : run);
        tracks.push({ net, layer: runL as 0 | 1, width, pts });
      }
    };
    for (const st of path) {
      const L = st >= N ? 1 : 0;
      const c = st - L * N;
      const pt: [number, number] = [cx(c), cy(c)];
      if (L !== runL) {
        flush();
        if (thtNet[c] !== net) vias.push({ net, x: pt[0], y: pt[1], d: s.viaDiameter, drill: s.viaDrill });
        run = [];
        runL = L;
      }
      run.push(pt);
    }
    flush();
    const p0 = path[0];
    const L0 = p0 >= N ? 1 : 0;
    const c0 = p0 - L0 * N;
    if (shapeDist(padShape(pad), cx(c0), cy(c0)) > 1e-6) tracks.push({ net, layer: L0 as 0 | 1, width: Math.min(width, pad.w, pad.h), pts: [[pad.x, pad.y], [cx(c0), cy(c0)]] });
    return { tracks, vias };
  }

  const trackShapes = (t: Track): Shape[] => {
    const out: Shape[] = [];
    for (let k = 0; k + 1 < t.pts.length; k++) out.push({ t: 'seg', ax: t.pts[k][0], ay: t.pts[k][1], bx: t.pts[k + 1][0], by: t.pts[k + 1][1], r: t.width / 2 });
    return out;
  };

  /** Add a net's copper to the soft occupancy (deduplicated per net via mark/markId). */
  function cover(net: number, layer: number, shape: Shape) {
    const [bx0, by0, bx1, by1] = shapeBox(shape);
    for (let k = 0; k < 3; k++) {
      const idx = k * 2 + layer;
      const e = reach[k];
      const i0 = Math.max(0, Math.floor((bx0 - e) / g)), i1 = Math.min(nx - 1, Math.ceil((bx1 + e) / g));
      const j0 = Math.max(0, Math.floor((by0 - e) / g)), j1 = Math.min(ny - 1, Math.ceil((by1 + e) / g));
      const mk = mark[idx], oc = occ[idx];
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const c = j * nx + i;
        if (mk[c] === markId) continue;
        if (shapeDist(shape, i * g, j * g) < e - 1e-9) { mk[c] = markId; oc[c]++; netCover[net].push(idx * N + c); }
      }
    }
  }
  function ripUp(net: number) {
    for (const e of netCover[net]) { const idx = (e / N) | 0; occ[idx][e - idx * N]--; }
    netCover[net] = [];
    netConns[net] = [];
  }
  function markOwn(net: number) {
    markId++;
    for (const e of netCover[net]) { const idx = (e / N) | 0; mark[idx][e - idx * N] = markId; }
  }

  function markNode(maps: Int16Array[], node: Node, net: number) {
    for (const k of [0, 1]) for (const st of sourceCells(maps, node, net, k)) tree[st] = treeId;
  }
  function markPath(path: number[], net: number) {
    for (const st of path) {
      tree[st] = treeId;
      const c = st % N;
      if (thtNet[c] === net) { tree[c] = treeId; tree[N + c] = treeId; }
    }
  }

  /** The pad of a node closest to a path's first cell (stub origin). */
  function startPad(node: Node, st: number): WorldPad {
    const c = st % N;
    let best = node.pads[0], bd = Infinity;
    for (const p of node.pads) { const d = shapeDist(padShape(p), cx(c), cy(c)); if (d < bd) { bd = d; best = p; } }
    return best;
  }

  function nodeBox(nodes: Node[]): [number, number, number, number] {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of nodes) for (const p of n.pads) {
      x0 = Math.min(x0, p.x - p.w / 2); y0 = Math.min(y0, p.y - p.h / 2);
      x1 = Math.max(x1, p.x + p.w / 2); y1 = Math.max(y1, p.y + p.h / 2);
    }
    return [Math.floor(x0 / g), Math.floor(y0 / g), Math.ceil(x1 / g), Math.ceil(y1 / g)];
  }
  function nodeDist(a: Node, b: Node) {
    let d = Infinity;
    for (const p of a.pads) for (const q of b.pads) d = Math.min(d, Math.hypot(p.x - q.x, p.y - q.y));
    return d;
  }

  /** Route all connections of one net. pf>=0: soft (negotiated) mode against `base`; pf<0: strict against `maps`. */
  function routeNet(net: number, maps: Int16Array[], pf: number, onConn: (c: Conn) => void): { a: [number, number]; b: [number, number] }[] {
    const nodes = netNodes[net];
    const kind = netKind[net];
    const fails: { a: [number, number]; b: [number, number] }[] = [];
    treeId++;
    if (net === pourNet) {
      // each GND node just needs to reach (future) pour copper on the bottom layer
      for (const node of nodes) {
        let found: Conn | null = null;
        for (const k of kind === 1 ? [1, 0] : [0]) {
          const src = sourceCells(maps, node, net, k);
          if (!src.length) continue;
          const path = search(maps, src, net, k, null, null, -1, pf, true);
          if (path) { found = { path, kind: k, pad: startPad(node, path[0]), node }; break; }
        }
        if (found) onConn(found);
        else fails.push({ a: [node.pads[0].x, node.pads[0].y], b: [node.pads[0].x, node.pads[0].y] });
      }
      return fails;
    }
    const inTree: Node[] = [nodes[0]];
    const left = new Set(nodes.slice(1));
    markNode(maps, nodes[0], net);
    while (left.size) {
      let pick: Node | null = null, pd = Infinity, from: Node = nodes[0];
      for (const n of left) for (const t of inTree) {
        const d = nodeDist(n, t);
        if (d < pd) { pd = d; pick = n; from = t; }
      }
      const node = pick!;
      left.delete(node);
      let found: Conn | null = null;
      for (const k of kind === 1 ? [1, 0] : [0]) {
        const src = sourceCells(maps, node, net, k);
        if (!src.length) continue;
        const path = search(maps, src, net, k, nodeBox(inTree), null, -1, pf);
        if (path) { found = { path, kind: k, pad: startPad(node, path[0]) }; break; }
      }
      if (found) { onConn(found); markPath(found.path, net); }
      else fails.push({ a: [node.pads[0].x, node.pads[0].y], b: [from.pads[0].x, from.pads[0].y] });
      markNode(maps, node, net);
      inTree.push(node);
    }
    return fails;
  }

  function pourLabels(maps: Int16Array[], net: number): { label: Int32Array; main: number } {
    const m = maps[1]; // signal-width map on bottom layer
    const label = new Int32Array(N).fill(-1);
    let best = -1, bestSize = 0, next = 0;
    const stack: number[] = [];
    for (let c0 = 0; c0 < N; c0++) {
      if (label[c0] !== -1 || (m[c0] !== FREE && m[c0] !== net)) continue;
      const id = next++;
      let size = 0;
      label[c0] = id; stack.push(c0);
      while (stack.length) {
        const c = stack.pop()!;
        size++;
        const i = c % nx;
        const nb = [i > 0 ? c - 1 : -1, i < nx - 1 ? c + 1 : -1, c - nx, c + nx];
        for (const q of nb) {
          if (q < 0 || q >= N || label[q] !== -1) continue;
          if (m[q] !== FREE && m[q] !== net) continue;
          label[q] = id; stack.push(q);
        }
      }
      if (size > bestSize) { bestSize = size; best = id; }
    }
    return { label, main: best };
  }

  // ---------- 1. negotiated congestion routing of signal nets ----------
  const hpwl = (net: number) => { const b = nodeBox(netNodes[net]); return (b[2] - b[0]) + (b[3] - b[1]); };
  const signal = board.nets.map((_, i) => i).filter((i) => i !== pourNet && netNodes[i].length >= 2).sort((a, b) => hpwl(a) - hpwl(b));
  if (pourNet >= 0) signal.push(pourNet);
  const hardFail = new Map<number, { a: [number, number]; b: [number, number] }[]>();
  const t0 = Date.now();
  let pf = 0.5;
  let toRoute = signal;
  const conflictsOf = (net: number): number[] => {
    // returns conflicting (idx*N+c) cells on this net's centrelines / vias
    markOwn(net);
    const out: number[] = [];
    for (const conn of netConns[net]) {
      let prevL = conn.path[0] >= N ? 1 : 0;
      for (const st of conn.path) {
        const L = st >= N ? 1 : 0;
        const c = st - L * N;
        const idx = conn.kind * 2 + L;
        if (occ[idx][c] - (mark[idx][c] === markId ? 1 : 0) > 0) out.push(idx * N + c);
        if (L !== prevL && thtNet[c] !== net) {
          for (const vi of [4, 5]) if (occ[vi][c] - (mark[vi][c] === markId ? 1 : 0) > 0) out.push(vi * N + c);
        }
        prevL = L;
      }
    }
    return out;
  };
  const maxIter = 30;
  let iter = 0;
  for (; iter < maxIter; iter++) {
    for (let n = 0; n < toRoute.length; n++) {
      const net = toRoute[n];
      progress?.(Math.min(0.9, (iter + n / toRoute.length) / 12), `Negotiating ${board.nets[net].name} (iteration ${iter + 1})`);
      ripUp(net);
      markId++;
      const fails = routeNet(net, base, pf, (conn) => {
        netConns[net].push(conn);
        const gm = geometry(conn, net, null);
        for (const t of gm.tracks) for (const sh of trackShapes(t)) cover(net, t.layer, sh);
        for (const v of gm.vias) for (const L of [0, 1]) cover(net, L, { t: 'circle', x: v.x, y: v.y, r: v.d / 2 });
      });
      if (fails.length) hardFail.set(net, fails); else hardFail.delete(net);
    }
    const conflicted: number[] = [];
    for (const net of signal) {
      const cc = conflictsOf(net);
      if (cc.length) { conflicted.push(net); for (const e of cc) { const idx = (e / N) | 0; hist[idx][e - idx * N] += 0.4; } }
    }
    log.push(`Iteration ${iter + 1}: ${conflicted.length} net(s) overlapping`);
    if (!conflicted.length) break;
    toRoute = conflicted;
    pf *= 1.6;
    if (Date.now() - t0 > 45_000) { log.push('Negotiation time budget reached'); break; }
  }

  // ---------- 2. legalisation: commit to strict maps ----------
  const strict = base.map((m) => m.slice());
  const tracks: Track[] = [];
  const vias: Via[] = [];
  const unrouted: RouteResult['unrouted'] = [];
  const bad = new Set(signal.filter((n) => conflictsOf(n).length > 0));
  // junction cells per net: where a later connection of the same net attaches to an earlier one
  const anchors = new Map<number, Set<number>>();
  for (const net of signal) {
    const a = new Set<number>();
    for (const conn of netConns[net]) a.add(conn.path[conn.path.length - 1] % N);
    anchors.set(net, a);
  }
  const commit = (net: number, conn: Conn, straight = true) => {
    const gm = geometry(conn, net, straight ? strict : null, anchors.get(net));
    for (const t of gm.tracks) { tracks.push(t); for (const sh of trackShapes(t)) stamp(strict, t.layer, sh, net); }
    for (const v of gm.vias) { vias.push(v); for (const L of [0, 1]) stamp(strict, L, { t: 'circle', x: v.x, y: v.y, r: v.d / 2 }, net); }
  };
  // stamp raw (unstraightened) copper of good nets first so straightening respects everyone
  for (const net of signal) {
    if (bad.has(net)) continue;
    for (const conn of netConns[net]) {
      const gm = geometry(conn, net, null);
      for (const t of gm.tracks) for (const sh of trackShapes(t)) stamp(strict, t.layer, sh, net);
      for (const v of gm.vias) for (const L of [0, 1]) stamp(strict, L, { t: 'circle', x: v.x, y: v.y, r: v.d / 2 }, net);
    }
  }
  for (const net of signal) if (!bad.has(net)) for (const conn of netConns[net]) commit(net, conn);
  // re-route still-conflicting nets strictly (shortest first)
  for (const net of [...bad].filter((n) => n !== pourNet).sort((a, b) => hpwl(a) - hpwl(b))) {
    const fails = routeNet(net, strict, -1, (conn) => commit(net, conn, false));
    for (const f of fails) unrouted.push({ net, ...f });
  }
  for (const [net, fails] of hardFail) if (!bad.has(net) && net !== pourNet) for (const f of fails) unrouted.push({ net, ...f });
  if (bad.size) log.push(`Strict re-route of ${bad.size} net(s)`);

  // ---------- 3. ground: connect every GND pad to the bottom pour ----------
  if (pourNet >= 0) {
    progress?.(0.95, `Connecting ${board.nets[pourNet].name} to ground pour`);
    const { label, main } = pourLabels(strict, pourNet);
    const kind = netKind[pourNet];
    const committed = bad.has(pourNet) ? [] : netConns[pourNet];
    for (const node of netNodes[pourNet]) {
      let ok = false;
      for (const p of node.pads) {
        if (!p.bottom) continue;
        const c = Math.round(p.y / g) * nx + Math.round(p.x / g);
        if (label[c] === main) ok = true;
      }
      for (const conn of committed) {
        if (conn.node !== node) continue;
        const last = conn.path[conn.path.length - 1];
        if (last >= N && label[last - N] === main) ok = true;
      }
      if (ok) continue;
      treeId++;
      let conn: Conn | null = null;
      for (const k of kind === 1 ? [1, 0] : [0]) {
        const src = sourceCells(strict, node, pourNet, k);
        if (!src.length) continue;
        const path = search(strict, src, pourNet, k, null, label, main);
        if (path) { conn = { path, kind: k, pad: startPad(node, path[0]) }; break; }
      }
      if (conn) commit(pourNet, conn, false);
      else unrouted.push({ net: pourNet, a: [node.pads[0].x, node.pads[0].y], b: [node.pads[0].x, node.pads[0].y] });
    }
  }
  log.push(`Result: ${tracks.length} tracks, ${vias.length} vias, ${unrouted.length} unrouted, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return { tracks, vias, unrouted, pourNet, log };
}

function simplify(pts: [number, number][]): [number, number][] {
  if (pts.length <= 2) return pts;
  const out: [number, number][] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1], b = pts[i], c = pts[i + 1];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) > 1e-9) out.push(b);
  }
  out.push(pts[pts.length - 1]);
  return out.map(([x, y]) => [Math.round(x * 10000) / 10000, Math.round(y * 10000) / 10000]);
}
