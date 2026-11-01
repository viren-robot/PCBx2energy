// 3D board viewer: extruded substrate with real holes, generated mask/copper/silk textures,
// and procedural 3D models for every footprint body kind.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { drawCopperLayer, holePath, padPath, roundedRectPath } from './draw';
import type { Silk } from './silk';
import type { Board, PlacedComponent } from './types';

const METAL = 0xc8c8c8;
const GOLD = 0xd4a64a;

function mix(hex: string, other: string, t: number): string {
  const a = parseInt(hex.slice(1), 16), b = parseInt(other.slice(1), 16);
  const ch = (s: number) => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t);
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0')}`;
}

export function boardTexture(board: Board, silk: Silk | null, side: 0 | 1, maskColor: string, finish: 'HASL' | 'ENIG'): HTMLCanvasElement {
  const ppm = Math.min(28, 4096 / Math.max(board.width, board.height));
  const cv = document.createElement('canvas');
  cv.width = Math.ceil(board.width * ppm);
  cv.height = Math.ceil(board.height * ppm);
  const ctx = cv.getContext('2d')!;
  if (side === 0) ctx.setTransform(ppm, 0, 0, -ppm, 0, board.height * ppm);
  else ctx.setTransform(ppm, 0, 0, ppm, 0, 0);
  ctx.save();
  ctx.beginPath();
  roundedRectPath(ctx, 0, 0, board.width, board.height, board.cornerRadius);
  ctx.clip();
  ctx.fillStyle = maskColor;
  ctx.fillRect(0, 0, board.width, board.height);
  // copper under the mask shows as a lighter tint
  drawCopperLayer(ctx, board, side, mix(maskColor, '#ffffff', 0.22), { pour: true });
  ctx.globalAlpha = 0.85;
  // exposed pads
  const fin = finish === 'ENIG' ? '#d9b25c' : '#d4d4d4';
  ctx.fillStyle = fin;
  ctx.beginPath();
  for (const p of board.pads) if (p.type !== 'npth' && (side === 0 ? p.top : p.bottom)) padPath(ctx, p);
  ctx.globalAlpha = 1;
  ctx.fill();
  // silkscreen
  if (side === 0 && silk) {
    ctx.strokeStyle = '#f4f4ee';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const l of silk.lines) {
      ctx.lineWidth = l.w;
      ctx.beginPath();
      l.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
    }
  }
  // holes are transparent (the substrate mesh has real holes underneath)
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  for (const p of board.pads) if (p.type !== 'smd') holePath(ctx, p);
  for (const v of board.vias) { ctx.moveTo(v.x + v.drill / 2, v.y); ctx.arc(v.x, v.y, v.drill / 2, 0, Math.PI * 2); }
  ctx.fill();
  ctx.restore();
  return cv;
}

function labelTexture(text: string, w: number, h: number, bg = '#1a1a1a', fg = '#cfcfcf'): THREE.CanvasTexture {
  const ppm = 40;
  const cv = document.createElement('canvas');
  cv.width = Math.max(16, Math.round(w * ppm));
  cv.height = Math.max(16, Math.round(h * ppm));
  const c = cv.getContext('2d')!;
  c.fillStyle = bg;
  c.fillRect(0, 0, cv.width, cv.height);
  c.fillStyle = fg;
  let fs = Math.min(cv.height * 0.32, (cv.width * 1.6) / Math.max(4, text.length));
  c.font = `600 ${fs}px system-ui, sans-serif`;
  while (c.measureText(text).width > cv.width * 0.9 && fs > 6) { fs -= 1; c.font = `600 ${fs}px system-ui, sans-serif`; }
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(text, cv.width / 2, cv.height / 2);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

const mats = new Map<string, THREE.Material>();
function mat(color: number, metal = 0, rough = 0.6, opts: Partial<THREE.MeshStandardMaterialParameters> = {}): THREE.Material {
  const k = `${color}|${metal}|${rough}|${JSON.stringify(opts)}`;
  let m = mats.get(k);
  if (!m) { m = new THREE.MeshStandardMaterial({ color, metalness: metal, roughness: rough, ...opts }); mats.set(k, m); }
  return m;
}

function box(w: number, h: number, d: number, m: THREE.Material | THREE.Material[], x = 0, y = 0, z = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y, z + d / 2);
  return mesh;
}
function cyl(r: number, hgt: number, m: THREE.Material, x = 0, y = 0, z = 0, seg = 24): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, hgt, seg), m);
  mesh.rotation.x = Math.PI / 2;
  mesh.position.set(x, y, z + hgt / 2);
  return mesh;
}

const LED_COLORS: Record<string, number> = { red: 0xff2a2a, green: 0x2aff5a, blue: 0x3a7bff, yellow: 0xffd52a, white: 0xf5f5ff, orange: 0xff8a1a };

function componentModel(pc: PlacedComponent, thickness: number): THREE.Group {
  const g = new THREE.Group();
  const { fp, comp } = pc;
  const b = fp.body;
  const W = b.w, H = b.h, Z = b.z;
  const pads = fp.pads;
  const black = mat(0x1c1c1e, 0, 0.75);
  const metal = mat(METAL, 0.9, 0.35);
  const gold = mat(GOLD, 1, 0.3);
  const pinsSMD = (height = 0.18) => {
    for (const p of pads) {
      if (p.type !== 'smd') continue;
      // lead from body edge to pad, along dominant axis
      const horiz = Math.abs(p.x) / (W / 2 || 1) > Math.abs(p.y) / (H / 2 || 1);
      if (horiz) {
        const x0 = Math.sign(p.x) * (W / 2), x1 = p.x + Math.sign(p.x) * p.w * 0.3;
        const len = Math.abs(x1 - x0);
        g.add(box(len, Math.min(p.h, p.w) * 0.7, height, metal, (x0 + x1) / 2, p.y, 0.02));
      } else {
        const y0 = Math.sign(p.y) * (H / 2), y1 = p.y + Math.sign(p.y) * p.h * 0.3;
        const len = Math.abs(y1 - y0);
        g.add(box(Math.min(p.h, p.w) * 0.7, len, height, metal, p.x, (y0 + y1) / 2, 0.02));
      }
    }
  };
  const labelled = (bodyColor: number, text: string, z0 = 0) => {
    const tex = labelTexture(text, W, H, `#${bodyColor.toString(16).padStart(6, '0')}`);
    const body = mat(bodyColor, 0, 0.75);
    const top = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7 });
    g.add(box(W, H, Z, [body, body, body, body, top, body], 0, 0, z0));
    // pin-1 dot
    const p1 = pads.find((p) => p.pin === '1');
    if (p1) {
      const dx = Math.sign(p1.x) * W * 0.32 || -W * 0.32, dy = Math.sign(p1.y) * H * 0.32 || H * 0.32;
      g.add(cyl(Math.min(W, H) * 0.06, 0.02, mat(0x555555, 0, 0.5), dx, dy, z0 + Z));
    }
  };

  switch (b.kind) {
    case 'chip': {
      const capW = W * 0.2;
      g.add(box(W - 2 * capW, H, Z, mat(b.color ?? 0x222222, 0, 0.6), 0, 0, 0.02));
      g.add(box(capW, H, Z, metal, -(W - capW) / 2, 0, 0.02));
      g.add(box(capW, H, Z, metal, (W - capW) / 2, 0, 0.02));
      break;
    }
    case 'led': {
      const col = LED_COLORS[comp.value.toLowerCase()] ?? LED_COLORS[(comp.description.match(/red|green|blue|yellow|white|orange/i) ?? ['red'])[0].toLowerCase()] ?? 0xff2a2a;
      g.add(box(W, H, Z * 0.45, mat(0xf2efe6, 0, 0.5), 0, 0, 0.02));
      g.add(box(W * 0.8, H * 0.8, Z * 0.55, mat(col, 0, 0.15, { transparent: true, opacity: 0.85, emissive: col, emissiveIntensity: 0.25 }), 0, 0, Z * 0.45));
      g.add(box(W * 0.1, H, Z * 0.46, mat(0x2a7a2a, 0, 0.5), -W * 0.42, 0, 0.02)); // cathode mark
      break;
    }
    case 'diode':
      g.add(box(W * 0.75, H, Z, black, 0, 0, 0.02));
      g.add(box(W * 0.08, H * 1.001, Z * 1.01, mat(0x9a9a9a, 0, 0.5), -W * 0.25, 0, 0.02));
      for (const p of pads) g.add(box(p.w * 0.6, p.h * 0.6, 0.15, metal, p.x, p.y, 0));
      break;
    case 'sot':
    case 'ic':
    case 'qfp':
      labelled(0x1e1e20, comp.value, b.kind === 'qfp' ? 0.1 : 0.12);
      pinsSMD(b.kind === 'sot' ? 0.25 : 0.2);
      break;
    case 'dip':
      labelled(0x1e1e20, comp.value, 0.5);
      for (const p of pads) g.add(box(0.5, 0.25, Z * 0.6, metal, p.x, p.y, -thickness - 1));
      break;
    case 'header':
      for (const p of pads) {
        g.add(box(2.5, 2.5, 2.5, black, p.x, p.y, 0));
        g.add(box(0.64, 0.64, 11.5, gold, p.x, p.y, -3));
      }
      break;
    case 'jst': {
      g.add(box(W, H, Z, mat(0xece6d2, 0, 0.6), 0, 0.8, 0));
      g.add(box(W - 1.2, H - 1.6, Z, mat(0xd7d0b8, 0, 0.7), 0, 0.5, 0.8)); // cavity
      for (const p of pads) g.add(box(0.64, 0.64, Z + 2.5, gold, p.x, p.y, -3));
      break;
    }
    case 'terminal': {
      g.add(box(W, H, Z, mat(b.color ?? 0x2e8b57, 0, 0.55), 0, 0.5, 0));
      for (const p of pads) {
        g.add(cyl(1.3, 0.3, mat(0x9c9c9c, 0.8, 0.4), p.x, p.y - 1, Z));
        g.add(box(2.6, 0.5, 0.31, mat(0x333333, 0, 0.6), p.x, p.y - 1, Z));
        g.add(box(3.4, 0.4, 3.0, mat(0x111111, 0, 0.8), p.x, 0.5 + H / 2 - 0.15, Z * 0.35)); // wire entry
      }
      break;
    }
    case 'usbc': {
      g.add(box(W, H, Z, metal, 0, 0, 0.05));
      const m = new THREE.Mesh(new THREE.BoxGeometry(W * 0.8, 0.1, Z * 0.45), mat(0x0b0b0b, 0, 0.9));
      m.position.set(0, -H / 2 - 0.04, Z / 2 + 0.05);
      g.add(m);
      for (const p of pads) if (p.type === 'smd') g.add(box(p.w * 0.7, p.h * 0.7, 0.12, metal, p.x, p.y, 0));
      break;
    }
    case 'module': {
      g.add(box(W, H, 0.8, mat(0x1d2b4a, 0, 0.6), 0, 0, 0.02));
      const shieldH = 18;
      const sy = -H / 2 + shieldH / 2 + 0.6;
      const tex = labelTexture(comp.value, W - 2, shieldH, '#bdbdbd', '#3a3a3a');
      const shield = new THREE.MeshStandardMaterial({ color: 0xcfcfcf, metalness: 0.85, roughness: 0.35 });
      const top = new THREE.MeshStandardMaterial({ map: tex, metalness: 0.6, roughness: 0.4 });
      g.add(box(W - 1.6, shieldH, Z - 0.8, [shield, shield, shield, shield, top, shield], 0, sy, 0.82));
      // antenna trace (zigzag) on the module PCB
      const ant = mat(GOLD, 0.8, 0.4);
      for (let i = 0; i < 6; i++) g.add(box(0.4, 4.2, 0.03, ant, -6 + i * 2.2, H / 2 - 3.3, 0.82));
      for (const p of pads) if (p.type === 'smd' && p.w < 3) g.add(box(p.w * 0.8, p.h * 0.8, 0.1, gold, p.x, p.y, 0));
      break;
    }
    case 'tactile': {
      g.add(box(W, H, Z * 0.65, black, 0, 0, 0.05));
      g.add(box(W * 0.95, H * 0.95, 0.15, metal, 0, 0, Z * 0.65));
      g.add(cyl(Math.min(W, H) * 0.29, Z * 0.35, mat(0x222222, 0, 0.5), 0, 0, Z * 0.65));
      if (fp.mount === 'tht') for (const p of pads) g.add(box(0.7, 0.3, 4, metal, p.x, p.y, -thickness - 1.5));
      else for (const p of pads) g.add(box(p.w, p.h * 0.6, 0.15, metal, p.x, p.y, 0));
      break;
    }
    case 'crystal': {
      const shape = new THREE.Shape();
      const r = H / 2;
      shape.absarc(-W / 2 + r, 0, r, Math.PI / 2, (3 * Math.PI) / 2, false);
      shape.absarc(W / 2 - r, 0, r, -Math.PI / 2, Math.PI / 2, false);
      const geo = new THREE.ExtrudeGeometry(shape, { depth: Z, bevelEnabled: true, bevelSize: 0.2, bevelThickness: 0.2, bevelSegments: 2 });
      const m = new THREE.Mesh(geo, metal);
      m.position.z = 0.2;
      g.add(m);
      break;
    }
    case 'crystal_smd':
      g.add(box(W, H, Z * 0.4, mat(0xeae0c8, 0, 0.6), 0, 0, 0));
      g.add(box(W * 0.9, H * 0.85, Z * 0.6, metal, 0, 0, Z * 0.4));
      break;
    case 'cap_elec': {
      g.add(cyl(W / 2, Z, mat(0x1f3c88, 0.2, 0.45), 0, 0, 0.3, 32));
      g.add(cyl(W / 2 - 0.3, 0.05, mat(0xb8b8b8, 0.9, 0.3), 0, 0, Z + 0.3, 32));
      g.add(box(W * 0.25, 0.3, Z * 0.98, mat(0xdddddd, 0, 0.6), W * 0.38, 0, 0.3));
      break;
    }
    case 'cap_smd_elec':
      g.add(box(W, H, 1.0, black, 0, 0, 0));
      g.add(cyl(W / 2 - 0.2, Z - 1, mat(0xb8b8bc, 0.85, 0.35), 0, 0, 1.0, 32));
      g.add(box(W * 0.12, H * 0.6, 0.05, mat(0x111111, 0, 0.6), -W * 0.25, 0, Z));
      break;
    case 'to220':
      g.add(box(10, 4.5, 9, black, 0, 0, 3));
      g.add(box(10, 1.3, 6.5, metal, 0, 1.6, 12));
      for (const p of pads) g.add(box(0.8, 0.5, 6, metal, p.x, p.y, -thickness - 1));
      break;
    case 'hole':
      break;
  }
  g.position.set(pc.x, pc.y, thickness);
  g.rotation.z = (pc.rot * Math.PI) / 180;
  return g;
}

export class View3D {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private root = new THREE.Group();
  private comps = new THREE.Group();
  private raf = 0;
  private active = false;
  private boardSize = 50;

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    container.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(0x1a1e24);
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.5, 5000);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x404050, 1.4));
    const d1 = new THREE.DirectionalLight(0xffffff, 2.2);
    d1.position.set(60, -90, 140);
    this.scene.add(d1);
    const d2 = new THREE.DirectionalLight(0xbfd4ff, 0.9);
    d2.position.set(-80, 70, -60);
    this.scene.add(d2);
    this.root.add(this.comps);
    this.scene.add(this.root);
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  setActive(on: boolean) {
    this.active = on;
    if (on) { this.resize(); this.loop(); } else cancelAnimationFrame(this.raf);
  }

  private loop = () => {
    if (!this.active) return;
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.raf = requestAnimationFrame(this.loop);
  };

  resize() {
    const w = Math.max(10, this.container.clientWidth), h = Math.max(10, this.container.clientHeight);
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  showComponents(on: boolean) { this.comps.visible = on; }

  view(kind: 'iso' | 'top' | 'bottom') {
    const s = this.boardSize;
    if (kind === 'top') this.camera.position.set(0, -0.001, s * 2.1);
    else if (kind === 'bottom') this.camera.position.set(0, 0.001, -s * 2.1);
    else this.camera.position.set(s * 0.55, -s * 1.25, s * 1.05);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  setBoard(board: Board | null, silk: Silk | null) {
    // dispose previous
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mm = m.material as THREE.MeshStandardMaterial | THREE.MeshStandardMaterial[] | undefined;
      for (const x of Array.isArray(mm) ? mm : mm ? [mm] : []) { if (x.map) { x.map.dispose(); x.dispose(); } }
    });
    this.root.clear();
    this.comps = new THREE.Group();
    this.root.add(this.comps);
    if (!board) return;
    const t = board.settings.thickness;
    const W = board.width, H = board.height;
    this.boardSize = Math.max(W, H);
    // substrate with holes
    const shape = new THREE.Shape();
    const r = Math.min(board.cornerRadius, W / 2, H / 2);
    shape.moveTo(r, 0);
    shape.lineTo(W - r, 0); shape.absarc(W - r, r, r, -Math.PI / 2, 0, false);
    shape.lineTo(W, H - r); shape.absarc(W - r, H - r, r, 0, Math.PI / 2, false);
    shape.lineTo(r, H); shape.absarc(r, H - r, r, Math.PI / 2, Math.PI, false);
    shape.lineTo(0, r); shape.absarc(r, r, r, Math.PI, 1.5 * Math.PI, false);
    const addHole = (x: number, y: number, d: number) => { const p = new THREE.Path(); p.absarc(x, y, d / 2, 0, Math.PI * 2, true); shape.holes.push(p); };
    for (const p of board.pads) {
      if (p.type === 'smd') continue;
      if (p.slot) {
        const { w, h } = p.slot;
        const rr = Math.min(w, h) / 2;
        const path = new THREE.Path();
        if (w > h) { path.absarc(p.x - w / 2 + rr, p.y, rr, Math.PI / 2, 1.5 * Math.PI, false); path.absarc(p.x + w / 2 - rr, p.y, rr, -Math.PI / 2, Math.PI / 2, false); }
        else { path.absarc(p.x, p.y + h / 2 - rr, rr, 0, Math.PI, false); path.absarc(p.x, p.y - h / 2 + rr, rr, Math.PI, 2 * Math.PI, false); }
        shape.holes.push(path);
      } else if (p.drill) addHole(p.x, p.y, p.drill);
    }
    for (const v of board.vias) addHole(v.x, v.y, v.drill);
    const geo = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false, curveSegments: 10 });
    const mask = board.settings.maskColor;
    const substrate = new THREE.Mesh(geo, [
      new THREE.MeshStandardMaterial({ color: new THREE.Color(mask), roughness: 0.5 }),
      new THREE.MeshStandardMaterial({ color: 0xcdb876, roughness: 0.6, metalness: 0.2 }),
    ]);
    this.root.add(substrate);
    for (const side of [0, 1] as const) {
      const tex = new THREE.CanvasTexture(boardTexture(board, silk, side, mask, board.settings.finish));
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshStandardMaterial({ map: tex, transparent: true, alphaTest: 0.5, roughness: 0.42, metalness: 0.05 }));
      plane.position.set(W / 2, H / 2, side === 0 ? t + 0.004 : -0.004);
      if (side === 1) plane.rotation.x = Math.PI;
      this.root.add(plane);
    }
    for (const pc of board.comps) this.comps.add(componentModel(pc, t));
    this.root.position.set(-W / 2, -H / 2, -t / 2);
    this.view('iso');
  }

  snapshot(): string {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }
}

