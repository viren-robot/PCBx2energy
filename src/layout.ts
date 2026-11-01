// Turns a logical Design into a placed physical Board (no routing yet).
import { getFootprint, registerCustomFootprints, resolvePin } from './footprints';
import { buildStackup, normalizeLayers } from './stackup';
import type { Board, Design, DesignComponent, FootprintDef, NetInfo, PlacedComponent, Settings, WorldPad } from './types';

const GROUND_RE = /^(GND|AGND|DGND|PGND|VSS|0V|GROUND)$/i;
const POWER_RE = /^(VCC|VDD|VIN|VBUS|VBAT|VSYS|VOUT|V\+|\+?\d+V\d*|\+?\d+V|3V3|5V|12V|VMOT|VM|PWR|VCC_.*|V_.*)$/i;

export interface Rect { x0: number; y0: number; x1: number; y1: number }

/** Grid used by the router. Chosen before placement so fine-pitch parts can be snapped onto it. */
export function chooseGrid(design: Design, settings: Settings, w: number, h: number): number {
  if (settings.gridOverride) return settings.gridOverride;
  const fine = design.components.some((c) => /LQFP-48|TSSOP/.test(c.footprint));
  let g = 0.1;
  if (!fine) {
    while ((w / g) * (h / g) > 900_000) g += 0.025;
  }
  return Math.round(g * 1000) / 1000;
}

export function rotPt(x: number, y: number, rot: number): [number, number] {
  switch (((rot % 360) + 360) % 360) {
    case 90: return [-y, x];
    case 180: return [-x, -y];
    case 270: return [y, -x];
    default: return [x, y];
  }
}

export function courtyardRect(fp: FootprintDef, x: number, y: number, rot: number, grow = 0): Rect {
  const cx = fp.courtyard.cx ?? 0;
  const cy = fp.courtyard.cy ?? 0;
  const [ox, oy] = rotPt(cx, cy, rot);
  const swap = rot % 180 !== 0;
  const w = (swap ? fp.courtyard.h : fp.courtyard.w) / 2 + grow;
  const h = (swap ? fp.courtyard.w : fp.courtyard.h) / 2 + grow;
  return { x0: x + ox - w, y0: y + oy - h, x1: x + ox + w, y1: y + oy + h };
}

const overlaps = (a: Rect, b: Rect) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

interface Prepared {
  comps: { comp: DesignComponent; fp: FootprintDef }[];
  nets: NetInfo[];
  pinNet: Map<string, number>; // "REF.pinId" -> net index
  warnings: string[];
}

export function prepare(design: Design): Prepared {
  const warnings: string[] = registerCustomFootprints(design.customFootprints);
  const comps: Prepared['comps'] = [];
  const refs = new Set<string>();
  for (const c of design.components) {
    let ref = c.ref.trim();
    if (!ref || refs.has(ref)) {
      let i = 1;
      const base = ref.replace(/\d+$/, '') || 'X';
      while (refs.has(`${base}${i}`)) i++;
      warnings.push(`Duplicate/empty reference "${c.ref}" renamed to ${base}${i}.`);
      ref = `${base}${i}`;
    }
    refs.add(ref);
    const fp = getFootprint(c.footprint);
    if (!fp) {
      warnings.push(`${ref}: unknown footprint "${c.footprint}" - component skipped.`);
      continue;
    }
    comps.push({ comp: { ...c, ref, footprint: fp.id }, fp });
  }
  const byRef = new Map(comps.map((c) => [c.comp.ref, c]));

  // Union-find over nets so a pin listed in two nets merges them.
  const netNames: string[] = [];
  const parent: number[] = [];
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const pinOwner = new Map<string, number>();
  for (const n of design.nets) {
    const idx = netNames.length;
    netNames.push(n.name.trim() || `N${idx}`);
    parent.push(idx);
    for (const p of n.pins) {
      const m = p.trim().match(/^([^.\s]+)\.(.+)$/);
      if (!m) { warnings.push(`Net ${n.name}: bad pin reference "${p}" (expected REF.PIN).`); continue; }
      const c = byRef.get(m[1]);
      if (!c) { warnings.push(`Net ${n.name}: unknown component "${m[1]}".`); continue; }
      const pid = resolvePin(c.fp, m[2]);
      if (!pid) { warnings.push(`Net ${n.name}: ${m[1]} (${c.fp.id}) has no pin "${m[2]}".`); continue; }
      const key = `${m[1]}.${pid}`;
      const prev = pinOwner.get(key);
      if (prev !== undefined && find(prev) !== find(idx)) {
        warnings.push(`Pin ${key} appears in nets ${netNames[find(prev)]} and ${netNames[idx]} - nets merged.`);
        parent[find(idx)] = find(prev);
      }
      pinOwner.set(key, idx);
    }
  }
  const rootToIdx = new Map<number, number>();
  const nets: NetInfo[] = [];
  const pinNet = new Map<string, number>();
  for (const [key, ni] of pinOwner) {
    const r = find(ni);
    if (!rootToIdx.has(r)) {
      const name = netNames[r];
      rootToIdx.set(r, nets.length);
      const isGround = GROUND_RE.test(name);
      const isPower = !isGround && POWER_RE.test(name);
      nets.push({ name, width: 0, isGround, isPower });
    }
    pinNet.set(key, rootToIdx.get(r)!);
  }
  // Dedupe net names.
  const seen = new Map<string, number>();
  for (const n of nets) {
    const k = n.name.toUpperCase();
    const c = seen.get(k) ?? 0;
    if (c) n.name = `${n.name}_${c}`;
    seen.set(k, c + 1);
  }
  return { comps, nets, pinNet, warnings };
}

export function worldPads(comps: PlacedComponent[], pinNet: Map<string, number>): WorldPad[] {
  const pads: WorldPad[] = [];
  for (const pc of comps) {
    for (const p of pc.fp.pads) {
      const [dx, dy] = rotPt(p.x, p.y, pc.rot);
      const swap = pc.rot % 180 !== 0;
      pads.push({
        id: pads.length,
        ref: pc.ref,
        pin: p.pin,
        net: p.type === 'npth' ? -1 : pinNet.get(`${pc.ref}.${p.pin}`) ?? -1,
        x: pc.x + dx,
        y: pc.y + dy,
        w: swap ? p.h : p.w,
        h: swap ? p.w : p.h,
        shape: p.shape,
        type: p.type,
        drill: p.drill,
        slot: p.slot ? (swap ? { w: p.slot.h, h: p.slot.w } : { ...p.slot }) : undefined,
        top: p.type !== 'npth',
        bottom: p.type === 'tht',
      });
    }
  }
  return pads;
}

// ---------------- Placement ----------------

interface PItem {
  ref: string;
  fp: FootprintDef;
  comp: DesignComponent;
  x: number;
  y: number;
  rot: number;
  placed: boolean;
  fixed: boolean;
  nets: number[]; // per pad net (or -1)
}

function snapToGrid(it: PItem, g: number) {
  // Snap so that pad 1 lands exactly on a router grid point (keeps fine-pitch pads routable).
  const p = it.fp.pads.find((q) => q.type !== 'npth') ?? it.fp.pads[0];
  const [dx, dy] = rotPt(p.x, p.y, it.rot);
  it.x = Math.round((it.x + dx) / g) * g - dx;
  it.y = Math.round((it.y + dy) / g) * g - dy;
}

export function buildBoard(design: Design, settings: Settings, sizeScale = 1, layerOverride?: number): Board {
  const prep = prepare(design);
  const warnings = [...prep.warnings];
  for (const n of prep.nets) n.width = n.isGround || n.isPower ? settings.powerTrackWidth : settings.trackWidth;

  const autoSize = !(design.board.width > 0 && design.board.height > 0);
  let W = design.board.width;
  let H = design.board.height;
  if (autoSize) {
    let area = 0;
    let maxDim = 0;
    for (const { fp } of prep.comps) {
      area += (fp.courtyard.w + 1.2) * (fp.courtyard.h + 1.2);
      maxDim = Math.max(maxDim, fp.courtyard.w, fp.courtyard.h);
    }
    const target = Math.max(area * 1.8 * sizeScale * sizeScale, 400);
    W = Math.max(Math.sqrt(target * 1.3), maxDim + 6, 20);
    H = Math.max(target / W, maxDim + 6, 15);
  }
  const cornerRadius = Math.max(0, Math.min(design.board.cornerRadius ?? 1, Math.min(W, H) / 4));

  let result: PItem[] | null = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    W = Math.ceil(W);
    H = Math.ceil(H);
    const g = chooseGrid(design, settings, W, H);
    const r = place(prep, W, H, g, warnings, !autoSize || attempt === 7);
    if (r) { result = r; break; }
    W *= 1.15;
    H *= 1.15;
  }
  const items = result!;
  const comps: PlacedComponent[] = items.map((it) => ({
    ref: it.ref, fp: it.fp, comp: it.comp, x: round4(it.x), y: round4(it.y), rot: it.rot, fixed: it.fixed,
  }));
  const pads = worldPads(comps, prep.pinNet);
  const keepouts = comps.flatMap((c) =>
    (c.fp.keepouts ?? []).map((k) => {
      const [ax, ay] = rotPt(k.x0, k.y0, c.rot);
      const [bx, by] = rotPt(k.x1, k.y1, c.rot);
      return {
        x0: Math.max(0, c.x + Math.min(ax, bx)), y0: Math.max(0, c.y + Math.min(ay, by)),
        x1: Math.min(W, c.x + Math.max(ax, bx)), y1: Math.min(H, c.y + Math.max(ay, by)),
      };
    }),
  );
  // Nets with a single pad are pointless; warn.
  const count = new Map<number, number>();
  for (const p of pads) if (p.net >= 0) count.set(p.net, (count.get(p.net) ?? 0) + 1);
  prep.nets.forEach((n, i) => { if ((count.get(i) ?? 0) < 2) warnings.push(`Net ${n.name} has only one pin.`); });

  const layers = normalizeLayers(layerOverride ?? (settings.layers || design.board.layers || 2));
  const su = buildStackup(layers, prep.nets, prep.nets.map((_, i) => count.get(i) ?? 0));
  return {
    design, settings, layers, stack: su.stack, planes: su.planes, width: W, height: H, cornerRadius, comps, pads, nets: prep.nets, keepouts,
    tracks: [], vias: [], unrouted: [], pourNet: -1, warnings, routeLog: [],
  };
}

const round4 = (v: number) => Math.round(v * 10000) / 10000;

function place(prep: Prepared, W: number, H: number, g: number, warnings: string[], force: boolean): PItem[] | null {
  const items: PItem[] = prep.comps.map(({ comp, fp }) => ({
    ref: comp.ref, fp, comp, x: W / 2, y: H / 2, rot: 0, placed: false, fixed: false,
    nets: fp.pads.map((p) => prep.pinNet.get(`${comp.ref}.${p.pin}`) ?? -1),
  }));
  const margin = 0.6;
  const gap = 0.7;
  const placedRects: { r: Rect; it: PItem }[] = [];
  const inBoard = (r: Rect, edgeOk = false) => {
    const m = edgeOk ? -0.01 : margin;
    return r.x0 >= m && r.y0 >= m && r.x1 <= W - m && r.y1 <= H - m;
  };
  const free = (r: Rect, self?: PItem) => !placedRects.some((p) => p.it !== self && overlaps(r, p.r));
  const commit = (it: PItem) => {
    it.placed = true;
    placedRects.push({ r: courtyardRect(it.fp, it.x, it.y, it.rot, gap / 2), it });
  };

  // 1. Fixed placements requested by the design.
  for (const it of items) {
    if (it.comp.x != null && it.comp.y != null && Number.isFinite(it.comp.x) && Number.isFinite(it.comp.y)) {
      it.x = it.comp.x; it.y = it.comp.y;
      it.rot = (((Math.round((it.comp.rotation ?? 0) / 90) * 90) % 360) + 360) % 360;
      it.fixed = true;
      snapToGrid(it, g);
      commit(it);
    }
  }
  // 2. Mounting holes into corners.
  const holes = items.filter((i) => !i.placed && i.fp.body.kind === 'hole');
  const corners: [number, number][] = [[3.5, 3.5], [W - 3.5, 3.5], [W - 3.5, H - 3.5], [3.5, H - 3.5]];
  holes.slice(0, 4).forEach((it, k) => { [it.x, it.y] = corners[k]; commit(it); });

  // Net -> placed pad positions, for wirelength estimates.
  const padPos = (it: PItem, x = it.x, y = it.y, rot = it.rot) =>
    it.fp.pads.map((p) => { const [dx, dy] = rotPt(p.x, p.y, rot); return [x + dx, y + dy] as [number, number]; });
  const netBoxes = () => {
    const m = new Map<number, Rect>();
    for (const it of items) {
      if (!it.placed) continue;
      padPos(it).forEach(([px, py], i) => {
        const n = it.nets[i];
        if (n < 0) return;
        const b = m.get(n);
        if (!b) m.set(n, { x0: px, y0: py, x1: px, y1: py });
        else { b.x0 = Math.min(b.x0, px); b.y0 = Math.min(b.y0, py); b.x1 = Math.max(b.x1, px); b.y1 = Math.max(b.y1, py); }
      });
    }
    return m;
  };
  const isBigNet = (n: number) => prep.nets[n]?.isGround || prep.nets[n]?.isPower;
  const costAt = (it: PItem, x: number, y: number, rot: number, boxes: Map<number, Rect>) => {
    let cost = 0;
    padPos(it, x, y, rot).forEach(([px, py], i) => {
      const n = it.nets[i];
      if (n < 0) return;
      const b = boxes.get(n);
      if (!b) return;
      const dx = Math.max(0, b.x0 - px, px - b.x1);
      const dy = Math.max(0, b.y0 - py, py - b.y1);
      cost += (dx + dy) * (isBigNet(n) ? 0.35 : 1);
    });
    return cost;
  };

  // 3. Edge connectors.
  const edgeItems = items.filter((i) => !i.placed && i.fp.edge);
  const rotFor = (side: 'top' | 'bottom', edge: string) => {
    const t = side === 'bottom' ? { bottom: 0, right: 90, top: 180, left: 270 } : { top: 0, left: 90, bottom: 180, right: 270 };
    return (t as Record<string, number>)[edge];
  };
  const edgeUse: Record<string, number> = { bottom: 0, top: 0, left: 0, right: 0 };
  edgeItems.sort((a, b) => (a.fp.id.startsWith('USB') ? -1 : 0) - (b.fp.id.startsWith('USB') ? -1 : 0) || b.fp.courtyard.w - a.fp.courtyard.w);
  for (const it of edgeItems) {
    // Preferred edges: USB on bottom, modules with antennas on top, others on left/right/top.
    const pref: string[] = it.fp.id.startsWith('USB') ? ['bottom', 'left', 'right', 'top']
      : it.fp.body.kind === 'module' ? ['top', 'left', 'right', 'bottom']
        : ['left', 'right', 'top', 'bottom'];
    pref.sort((a, b) => edgeUse[a] - edgeUse[b] || pref.indexOf(a) - pref.indexOf(b));
    let done = false;
    for (const edge of pref) {
      const rot = rotFor(it.fp.edge!, edge);
      const cr = courtyardRect(it.fp, 0, 0, rot);
      const cw = cr.x1 - cr.x0, ch = cr.y1 - cr.y0;
      const along = edge === 'bottom' || edge === 'top' ? W : H;
      const len = edge === 'bottom' || edge === 'top' ? cw : ch;
      const cands: number[] = [];
      for (let t = len / 2 + margin + 2; t <= along - len / 2 - margin - 2; t += 0.5) cands.push(t);
      cands.sort((a, b) => Math.abs(a - along / 2) - Math.abs(b - along / 2));
      for (const t of cands) {
        let x: number, y: number;
        if (edge === 'bottom') { x = t - (cr.x0 + cr.x1) / 2; y = -cr.y0; }
        else if (edge === 'top') { x = t - (cr.x0 + cr.x1) / 2; y = H - cr.y1; }
        else if (edge === 'left') { x = -cr.x0; y = t - (cr.y0 + cr.y1) / 2; }
        else { x = W - cr.x1; y = t - (cr.y0 + cr.y1) / 2; }
        it.x = x; it.y = y; it.rot = rot;
        snapToGrid(it, g);
        // Snapping may push the courtyard slightly past the edge; nudge back inside.
        const r0 = courtyardRect(it.fp, it.x, it.y, it.rot);
        if (r0.x0 < 0) it.x += g * Math.ceil(-r0.x0 / g);
        if (r0.y0 < 0) it.y += g * Math.ceil(-r0.y0 / g);
        if (r0.x1 > W) it.x -= g * Math.ceil((r0.x1 - W) / g);
        if (r0.y1 > H) it.y -= g * Math.ceil((r0.y1 - H) / g);
        const r = courtyardRect(it.fp, it.x, it.y, it.rot, gap / 2);
        if (inBoard(courtyardRect(it.fp, it.x, it.y, it.rot), true) && free(r)) {
          commit(it); edgeUse[edge]++; done = true; break;
        }
      }
      if (done) break;
    }
    // if not done, the part falls through to general placement below
  }

  // 4. Everything else, most-connected first, greedily near its connections.
  const rest = items.filter((i) => !i.placed);
  const degree = (it: PItem) => new Set(it.nets.filter((n) => n >= 0)).size;
  rest.sort((a, b) => b.fp.pinCount - a.fp.pinCount || degree(b) - degree(a));
  const unplaced = new Set(rest);
  const placeOne = (it: PItem): boolean => {
    const boxes = netBoxes();
    // target = centroid of connected nets' boxes, else board centre
    let tx = 0, ty = 0, tw = 0;
    for (const n of new Set(it.nets)) {
      const b = n >= 0 ? boxes.get(n) : undefined;
      if (!b) continue;
      const wgt = isBigNet(n) ? 0.3 : 1;
      tx += ((b.x0 + b.x1) / 2) * wgt; ty += ((b.y0 + b.y1) / 2) * wgt; tw += wgt;
    }
    if (tw === 0) { tx = W / 2; ty = H / 2; } else { tx /= tw; ty /= tw; }
    const rots = it.fp.pinCount <= 1 ? [0] : [0, 90, 180, 270];
    let best: { x: number; y: number; rot: number; c: number } | null = null;
    const step = 0.5;
    const maxR = Math.max(W, H);
    let found = 0;
    for (let rad = 0; rad <= maxR && found < 80; rad += step) {
      const ring: [number, number][] = [];
      if (rad === 0) ring.push([tx, ty]);
      else {
        const n = Math.max(8, Math.round((2 * Math.PI * rad) / step));
        for (let k = 0; k < n; k++) ring.push([tx + rad * Math.cos((2 * Math.PI * k) / n), ty + rad * Math.sin((2 * Math.PI * k) / n)]);
      }
      for (const [x, y] of ring) {
        for (const rot of rots) {
          it.x = x; it.y = y; it.rot = rot;
          snapToGrid(it, g);
          const cr = courtyardRect(it.fp, it.x, it.y, rot);
          if (!inBoard(cr)) continue;
          if (!free(courtyardRect(it.fp, it.x, it.y, rot, gap / 2), it)) continue;
          const c = costAt(it, it.x, it.y, rot, boxes) + rad * 0.05 + (rot ? 0.01 : 0);
          found++;
          if (!best || c < best.c) best = { x: it.x, y: it.y, rot, c };
        }
      }
    }
    if (!best) return false;
    it.x = best.x; it.y = best.y; it.rot = best.rot;
    return true;
  };
  while (unplaced.size) {
    // pick unplaced item with the most connections into already placed parts
    const placedNets = new Set<number>();
    for (const it of items) if (it.placed) it.nets.forEach((n) => n >= 0 && placedNets.add(n));
    let pick: PItem | null = null;
    let bestScore = -1;
    for (const it of unplaced) {
      const s = it.nets.filter((n) => n >= 0 && placedNets.has(n) && !isBigNet(n)).length * 10 + it.nets.filter((n) => placedNets.has(n)).length + it.fp.pinCount * 0.01;
      if (s > bestScore) { bestScore = s; pick = it; }
    }
    const it = pick!;
    unplaced.delete(it);
    if (!placeOne(it)) {
      if (!force) return null;
      warnings.push(`${it.ref}: no free space on the board - placed overlapping. Increase board size.`);
      it.x = W / 2; it.y = H / 2;
    }
    commit(it);
  }

  // 5. Refinement: rip each movable part out and re-insert at its best spot.
  for (let pass = 0; pass < 2; pass++) {
    for (const it of rest) {
      const idx = placedRects.findIndex((p) => p.it === it);
      if (idx < 0) continue;
      const [old] = placedRects.splice(idx, 1);
      it.placed = false;
      const ox = it.x, oy = it.y, orot = it.rot;
      const before = costAt(it, ox, oy, orot, netBoxes());
      if (!placeOne(it) || costAt(it, it.x, it.y, it.rot, netBoxes()) >= before - 0.05) {
        it.x = ox; it.y = oy; it.rot = orot;
        it.placed = true;
        placedRects.push(old);
      } else commit(it);
    }
  }
  return items;
}
