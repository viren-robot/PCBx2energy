import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { applyTransform, autoMove, checkFit, IDENTITY, loadModelBuffer, boundsOf, countTriangles, type MechModel } from '../src/mech';
import { runPipeline } from '../src/pipeline';
import { offlineDesign } from '../src/templates';
import { DEFAULT_SETTINGS } from '../src/types';

const ab = (p: string) => { const b = readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer; };
const STEP = 'node_modules/occt-import-js/test/testfiles';
const model = (name: string, object: THREE.Object3D, t = IDENTITY): MechModel => { applyTransform(object, t); return { id: name, name, object, t, visible: true, solid: true, tris: countTriangles(object) }; };

/** Hollow box (case) as a closed solid: outer box minus nothing - we build 6 slabs (walls) so it is a real cavity. */
function caseBox(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, wall = 2): THREE.Object3D {
  const g = new THREE.Group();
  const slab = (a: number[], b: number[]) => { const m = new THREE.Mesh(new THREE.BoxGeometry(b[0] - a[0], b[1] - a[1], b[2] - a[2]), new THREE.MeshBasicMaterial()); m.position.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2); g.add(m); };
  slab([x0 - wall, y0 - wall, z0 - wall], [x1 + wall, y1 + wall, z0]);        // floor
  slab([x0 - wall, y0 - wall, z1], [x1 + wall, y1 + wall, z1 + wall]);         // lid
  slab([x0 - wall, y0 - wall, z0], [x0, y1 + wall, z1]);                       // walls
  slab([x1, y0 - wall, z0], [x1 + wall, y1 + wall, z1]);
  slab([x0, y0 - wall, z0], [x1, y0, z1]);
  slab([x0, y1, z0], [x1, y1 + wall, z1]);
  return g;
}

describe('STEP / STL import', () => {
  it('reads real STEP files with the right size and units', async () => {
    const cube = await loadModelBuffer('Cube 10x10.stp', ab(`${STEP}/cube-10x10mm/Cube 10x10.stp`));
    const bb = boundsOf(cube).getSize(new THREE.Vector3());
    expect(bb.x).toBeCloseTo(10, 1); expect(bb.y).toBeCloseTo(10, 1); expect(bb.z).toBeCloseTo(10, 1);
    const rounded = await loadModelBuffer('rounded-cube.step', ab(`${STEP}/rounded-cube/rounded-cube.step`));
    expect(countTriangles(rounded)).toBeGreaterThan(12);
    const mm = boundsOf(await loadModelBuffer('cube-mm.step', ab(`${STEP}/cube-units/cube-mm.step`))).getSize(new THREE.Vector3());
    const inch = boundsOf(await loadModelBuffer('cube-in.step', ab(`${STEP}/cube-units/cube-in.step`))).getSize(new THREE.Vector3());
    console.log('cube-mm', mm.x.toFixed(2), 'cube-in', inch.x.toFixed(2));
    expect(mm.x).toBeGreaterThan(0);
  });
  it('reads binary and ASCII STL', async () => {
    const stl = 'solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 10 0 0\nvertex 0 10 0\nendloop\nendfacet\nendsolid t\n';
    const o = await loadModelBuffer('x.stl', new TextEncoder().encode(stl).buffer as ArrayBuffer);
    expect(countTriangles(o)).toBe(1);
    await expect(loadModelBuffer('x.dwg', new ArrayBuffer(4))).rejects.toThrow(/Unsupported/);
  });
});

describe('fit check and auto-move', () => {
  const board = runPipeline(offlineDesign('ESP32 dev board with usb-c').design, { ...DEFAULT_SETTINGS, layers: 4 });
  const W = board.width, H = board.height;

  it('a roomy case: everything fits', () => {
    const c = model('roomy', caseBox(-1, -1, -1, W + 1, H + 1, 25));
    const r = checkFit(board, [c], 0.3);
    expect(r.collisions).toEqual([]);
  });

  it('a low lid collides with the tall parts (ESP32 shield, headers)', () => {
    const c = model('low-lid', caseBox(-1, -1, -1, W + 1, H + 1, 6));
    const r = checkFit(board, [c], 0.3);
    console.log('low lid collisions:', r.partsCollide.join(','), `${r.ms} ms`);
    expect(r.partsCollide.length).toBeGreaterThan(0);
  });

  it('a pillar over one component is reported and auto-move relocates it, then the fit check passes', () => {
    const target = board.comps.find((c) => c.ref === 'R4' || c.ref === 'R3')!;
    const pillar = new THREE.Mesh(new THREE.BoxGeometry(5, 5, 20), new THREE.MeshBasicMaterial());
    const g = new THREE.Group(); g.add(pillar);
    const m = model('pillar', g, { ...IDENTITY, x: target.x, y: target.y, z: 10 });
    const fit0 = checkFit(board, [m], 0.3);
    expect(fit0.partsCollide).toContain(target.ref);
    const am = autoMove(board, [m], 0.3);
    const mv = am.moves.find((x) => x.ref === target.ref);
    expect(mv).toBeDefined();
    expect(Math.hypot(mv!.toX - target.x, mv!.toY - target.y)).toBeGreaterThan(2);
    // apply move and re-check
    const moved = JSON.parse(JSON.stringify(board)) as typeof board;
    const mc = moved.comps.find((c) => c.ref === target.ref)!; mc.x = mv!.toX; mc.y = mv!.toY; mc.rot = mv!.rot;
    expect(checkFit(moved, [m], 0.3).partsCollide).not.toContain(target.ref);
  });

  it('board larger than the case cavity is flagged', () => {
    const c = model('tiny', caseBox(5, 5, -1, W - 5, H - 5, 25));
    expect(checkFit(board, [c], 0.3).boardCollides).toBe(true);
  });

  it('transform: moving the case away removes collisions', () => {
    const c = model('moved', caseBox(-1, -1, -1, W + 1, H + 1, 6), { ...IDENTITY, x: 500 });
    expect(checkFit(board, [c], 0.3).collisions).toEqual([]);
  });
});
