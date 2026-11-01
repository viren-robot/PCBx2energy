// Mechanical fit: import STEP / STL / OBJ enclosures, holders and brackets, test whether the populated PCB fits,
// and find new positions for components that collide.
// Coordinates: board frame (origin bottom-left corner, z = 0 at the board's underside, +z up).
import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { courtyardRect } from './layout';
import type { Board, PlacedComponent } from './types';

export interface MechTransform { x: number; y: number; z: number; rx: number; ry: number; rz: number; scale: number }
export const IDENTITY: MechTransform = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, scale: 1 };

export interface MechModel { id: string; name: string; object: THREE.Object3D; t: MechTransform; visible: boolean; solid: boolean; tris: number }

type OcctModule = { ReadStepFile: (b: Uint8Array, p: unknown) => { success: boolean; meshes: { attributes: { position: { array: number[] }; normal?: { array: number[] } }; index: { array: number[] }; color?: number[] }[] } };
let occtPromise: Promise<OcctModule> | null = null;
async function getOcct(): Promise<OcctModule> {
  if (!occtPromise) {
    occtPromise = (async () => {
      const mod = (await import('occt-import-js')) as unknown as { default: (o?: unknown) => Promise<OcctModule> };
      let locate: ((f: string) => string) | undefined;
      if (typeof window !== 'undefined') {
        const url = (await import('occt-import-js/dist/occt-import-js.wasm?url')).default as string;
        locate = () => url;
      }
      return mod.default(locate ? { locateFile: locate } : undefined);
    })();
  }
  return occtPromise;
}

const MAT = () => new THREE.MeshStandardMaterial({ color: 0x9aa7b4, metalness: 0.2, roughness: 0.55, transparent: true, opacity: 0.4, side: THREE.DoubleSide });

function addEdges(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.geometry) {
      const e = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry, 35), new THREE.LineBasicMaterial({ color: 0x6aa9ff, transparent: true, opacity: 0.6 }));
      m.add(e);
    }
  });
}

export function countTriangles(o: THREE.Object3D): number {
  let n = 0;
  o.traverse((c) => { const g = (c as THREE.Mesh).geometry as THREE.BufferGeometry | undefined; if ((c as THREE.Mesh).isMesh && g) n += (g.index ? g.index.count : g.attributes.position.count) / 3; });
  return n;
}

/** Parse a CAD/mesh file into a Three object in millimetres. */
export async function loadModelBuffer(name: string, data: ArrayBuffer): Promise<THREE.Object3D> {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  const group = new THREE.Group();
  if (ext === 'stl') {
    const geo = new STLLoader().parse(data);
    geo.computeVertexNormals();
    group.add(new THREE.Mesh(geo, MAT()));
  } else if (ext === 'obj') {
    const obj = new OBJLoader().parse(new TextDecoder().decode(data));
    obj.traverse((c) => { if ((c as THREE.Mesh).isMesh) (c as THREE.Mesh).material = MAT(); });
    group.add(obj);
  } else if (ext === 'step' || ext === 'stp') {
    const occt = await getOcct();
    const res = occt.ReadStepFile(new Uint8Array(data), null);
    if (!res.success || !res.meshes.length) throw new Error('Could not read this STEP file (no solid geometry found).');
    for (const m of res.meshes) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(m.attributes.position.array, 3));
      if (m.attributes.normal) geo.setAttribute('normal', new THREE.Float32BufferAttribute(m.attributes.normal.array, 3)); else geo.computeVertexNormals();
      geo.setIndex(m.index.array);
      const mat = MAT();
      if (m.color) mat.color.setRGB(m.color[0], m.color[1], m.color[2]);
      group.add(new THREE.Mesh(geo, mat));
    }
  } else throw new Error(`Unsupported file type ".${ext}". Use STEP (.step/.stp), STL or OBJ.`);
  if (!countTriangles(group)) throw new Error('The file contains no triangles.');
  addEdges(group);
  return group;
}

export function applyTransform(o: THREE.Object3D, t: MechTransform) {
  o.position.set(t.x, t.y, t.z);
  o.rotation.set((t.rx * Math.PI) / 180, (t.ry * Math.PI) / 180, (t.rz * Math.PI) / 180, 'XYZ');
  o.scale.setScalar(t.scale || 1);
  o.updateMatrixWorld(true);
}

export function boundsOf(o: THREE.Object3D): THREE.Box3 { o.updateMatrixWorld(true); return new THREE.Box3().setFromObject(o); }

// ---------------- collision ----------------
export interface Collision { ref: string; kind: 'part' | 'board'; message: string; x: number; y: number }
export interface FitResult { collisions: Collision[]; checkedParts: number; partsCollide: string[]; boardCollides: boolean; ms: number }

/** Solid test + surface crossing test against a set of closed meshes. */
class Solid {
  private ray = new THREE.Raycaster();
  private meshes: THREE.Mesh[] = [];
  private box = new THREE.Box3();
  constructor(models: MechModel[]) {
    for (const m of models) { if (!m.visible || !m.solid) continue; m.object.updateMatrixWorld(true); m.object.traverse((c) => { if ((c as THREE.Mesh).isMesh) { const mm = c as THREE.Mesh; for (const x of Array.isArray(mm.material) ? mm.material : [mm.material]) x.side = THREE.DoubleSide; this.meshes.push(mm); } }); }
    for (const m of this.meshes) this.box.union(new THREE.Box3().setFromObject(m));
  }
  get empty() { return !this.meshes.length; }
  private count(p: THREE.Vector3, d: THREE.Vector3): number {
    this.ray.set(p, d);
    const hits = this.ray.intersectObjects(this.meshes, false);
    // merge hits closer than 1e-4 (edges shared by two triangles)
    let n = 0, last = -1;
    for (const h of hits) { if (last < 0 || h.distance - last > 1e-4) n++; last = h.distance; }
    return n;
  }
  /** Inside a closed solid? Majority vote of three axis rays (robust against grazing edges). */
  inside(p: THREE.Vector3): boolean {
    if (!this.box.containsPoint(p)) return false;
    let votes = 0;
    for (const d of [new THREE.Vector3(1, 0.0137, 0.0071), new THREE.Vector3(0.0093, 1, 0.0151), new THREE.Vector3(0.0121, 0.0083, 1)]) if (this.count(p, d.normalize()) % 2 === 1) votes++;
    return votes >= 2;
  }
  /** Does the segment a-b cross any surface? */
  crosses(a: THREE.Vector3, b: THREE.Vector3): boolean {
    const d = b.clone().sub(a), len = d.length();
    if (len < 1e-6) return false;
    this.ray.set(a, d.normalize());
    this.ray.far = len;
    const hit = this.ray.intersectObjects(this.meshes, false).length > 0;
    this.ray.far = Infinity;
    return hit;
  }
}

function partBox(c: PlacedComponent, board: Board, margin: number, x = c.x, y = c.y, rot = c.rot) {
  const swap = rot % 180 !== 0;
  const w = (swap ? c.fp.body.h : c.fp.body.w) / 2 + margin, h = (swap ? c.fp.body.w : c.fp.body.h) / 2 + margin;
  const t = board.settings.thickness;
  const hdr = c.fp.body.kind === 'header' ? 8.5 : c.fp.body.z;
  const below = c.fp.mount === 'tht' ? 2.2 : 0;
  return { x0: x - w, x1: x + w, y0: y - h, y1: y + h, z0: t - below - margin, z1: t + hdr + margin };
}

function boxCollides(solid: Solid, b: { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number }): boolean {
  const xs = [b.x0, b.x1], ys = [b.y0, b.y1], zs = [b.z0, b.z1];
  const corners: THREE.Vector3[] = [];
  for (const x of xs) for (const y of ys) for (const z of zs) corners.push(new THREE.Vector3(x, y, z));
  // 12 edges: a wall crossing the box
  const E: [number, number][] = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  for (const [i, j] of E) if (solid.crosses(corners[i], corners[j])) return true;
  // interior samples (case wall swallowing the part, or part inside a solid block)
  const nx = Math.min(4, Math.max(1, Math.ceil((b.x1 - b.x0) / 3))), ny = Math.min(4, Math.max(1, Math.ceil((b.y1 - b.y0) / 3))), nz = Math.min(3, Math.max(1, Math.ceil((b.z1 - b.z0) / 3)));
  for (let i = 0; i <= nx; i++) for (let j = 0; j <= ny; j++) for (let k = 0; k <= nz; k++) {
    const p = new THREE.Vector3(b.x0 + ((b.x1 - b.x0) * i) / nx, b.y0 + ((b.y1 - b.y0) * j) / ny, b.z0 + ((b.z1 - b.z0) * k) / nz);
    if (solid.inside(p)) return true;
  }
  return false;
}

/** Check every component (and the PCB outline) against the imported solids. */
export function checkFit(board: Board, models: MechModel[], margin = 0.3): FitResult {
  const t0 = Date.now();
  const solid = new Solid(models);
  const out: Collision[] = [];
  if (solid.empty) return { collisions: [], checkedParts: 0, partsCollide: [], boardCollides: false, ms: 0 };
  for (const c of board.comps) {
    if (c.fp.body.kind === 'hole') continue;
    if (boxCollides(solid, partBox(c, board, margin))) out.push({ ref: c.ref, kind: 'part', message: `${c.ref} (${c.comp.value}) collides with the mechanical model`, x: c.x, y: c.y });
  }
  // PCB itself: outline as a thin slab; test perimeter segments and the centre
  const t = board.settings.thickness, W = board.width, H = board.height;
  const pts = [new THREE.Vector3(0, 0, t / 2), new THREE.Vector3(W, 0, t / 2), new THREE.Vector3(W, H, t / 2), new THREE.Vector3(0, H, t / 2)];
  let boardHit = false;
  for (let i = 0; i < 4 && !boardHit; i++) boardHit = solid.crosses(pts[i], pts[(i + 1) % 4]) || solid.inside(pts[i]);
  // a wall between the board centre and a corner means that corner lies outside the cavity (board too big / case misplaced)
  const centre = new THREE.Vector3(W / 2, H / 2, t / 2);
  for (let i = 0; i < 4 && !boardHit; i++) boardHit = solid.crosses(centre, pts[i]);
  if (!boardHit) boardHit = solid.inside(new THREE.Vector3(W / 2, H / 2, t / 2));
  if (boardHit) out.push({ ref: 'PCB', kind: 'board', message: 'The PCB outline touches the mechanical model - move/rotate the model or resize the board', x: W / 2, y: H / 2 });
  return { collisions: out, checkedParts: board.comps.filter((c) => c.fp.body.kind !== 'hole').length, partsCollide: out.filter((c) => c.kind === 'part').map((c) => c.ref), boardCollides: boardHit, ms: Date.now() - t0 };
}

export interface Move { ref: string; fromX: number; fromY: number; toX: number; toY: number; rot: number }
export interface AutoMoveResult { moves: Move[]; stuck: string[] }

/** For each colliding component find the nearest collision-free, overlap-free spot on the board. */
export function autoMove(board: Board, models: MechModel[], margin = 0.3, collide?: string[]): AutoMoveResult {
  const solid = new Solid(models);
  const fit = collide ?? checkFit(board, models, margin).partsCollide;
  const moves: Move[] = [], stuck: string[] = [];
  const placed = board.comps.map((c) => ({ ref: c.ref, x: c.x, y: c.y, rot: c.rot, c }));
  const rectOf = (c: PlacedComponent, x: number, y: number, rot: number) => courtyardRect(c.fp, x, y, rot, 0.25);
  const free = (c: PlacedComponent, x: number, y: number, rot: number) => {
    const r = rectOf(c, x, y, rot);
    if (r.x0 < 0.6 || r.y0 < 0.6 || r.x1 > board.width - 0.6 || r.y1 > board.height - 0.6) return false;
    for (const o of placed) {
      if (o.ref === c.ref) continue;
      const q = rectOf(o.c, o.x, o.y, o.rot);
      if (r.x0 < q.x1 && q.x0 < r.x1 && r.y0 < q.y1 && q.y0 < r.y1) return false;
    }
    for (const k of board.keepouts) if (r.x0 < k.x1 && k.x0 < r.x1 && r.y0 < k.y1 && k.y0 < r.y1) return false;
    return true;
  };
  for (const ref of fit) {
    const c = board.comps.find((q) => q.ref === ref);
    if (!c) continue;
    if (c.fp.edge) { stuck.push(ref); continue; } // edge connectors line up with case cut-outs: leave to the user
    let best: { x: number; y: number; rot: number; d: number } | null = null;
    const maxR = Math.max(board.width, board.height);
    for (let r = 1; r <= maxR && !best; r += 1) {
      const n = Math.max(8, Math.round(2 * Math.PI * r));
      for (let k = 0; k < n; k++) {
        const x = Math.round((c.x + r * Math.cos((2 * Math.PI * k) / n)) * 2) / 2, y = Math.round((c.y + r * Math.sin((2 * Math.PI * k) / n)) * 2) / 2;
        for (const rot of c.fp.pinCount <= 1 ? [c.rot] : [c.rot, (c.rot + 90) % 360, (c.rot + 180) % 360, (c.rot + 270) % 360]) {
          if (!free(c, x, y, rot)) continue;
          if (boxCollides(solid, partBox(c, board, margin, x, y, rot))) continue;
          const d = Math.hypot(x - c.x, y - c.y) + (rot === c.rot ? 0 : 0.3);
          if (!best || d < best.d) best = { x, y, rot, d };
        }
      }
    }
    if (!best) { stuck.push(ref); continue; }
    const p = placed.find((q) => q.ref === ref)!;
    moves.push({ ref, fromX: c.x, fromY: c.y, toX: best.x, toY: best.y, rot: best.rot });
    p.x = best.x; p.y = best.y; p.rot = best.rot;
  }
  return { moves, stuck };
}
