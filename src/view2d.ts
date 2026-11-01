// Interactive 2D board viewer (KiCad-style layer colours) with pan/zoom, hover info and net highlight.
import { drawCopperLayer, holePath, roundedRectPath } from './draw';
import { courtyardRect } from './layout';
import type { Silk } from './silk';
import type { Board, WorldPad } from './types';

export interface Layers2D { top: boolean; bottom: boolean; silk: boolean; pour: boolean; ratsnest: boolean; courtyard: boolean; drc: boolean }

export class View2D {
  private ctx: CanvasRenderingContext2D;
  board: Board | null = null;
  silk: Silk | null = null;
  layers: Layers2D = { top: true, bottom: true, silk: true, pour: true, ratsnest: true, courtyard: false, drc: true };
  markers: { x: number; y: number }[] = [];
  private scale = 10;
  private ox = 0;
  private oy = 0;
  private drag: { x: number; y: number; ox: number; oy: number } | null = null;
  private highlight = -1;
  private hover: { x: number; y: number } | null = null;
  private dpr = 1;
  onHover?: (text: string) => void;
  flipped = false;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement!);
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      const mx = (e.clientX - r.left) * this.dpr, my = (e.clientY - r.top) * this.dpr;
      const f = Math.exp(-e.deltaY * 0.0015);
      const ns = Math.min(400, Math.max(1, this.scale * f));
      this.ox = mx - ((mx - this.ox) * ns) / this.scale;
      this.oy = my - ((my - this.oy) * ns) / this.scale;
      this.scale = ns;
      this.draw();
    }, { passive: false });
    canvas.addEventListener('pointerdown', (e) => {
      this.drag = { x: e.clientX, y: e.clientY, ox: this.ox, oy: this.oy };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      const r = canvas.getBoundingClientRect();
      if (this.drag) {
        this.ox = this.drag.ox + (e.clientX - this.drag.x) * this.dpr;
        this.oy = this.drag.oy + (e.clientY - this.drag.y) * this.dpr;
        this.draw();
      }
      this.hover = this.toBoard((e.clientX - r.left) * this.dpr, (e.clientY - r.top) * this.dpr);
      this.reportHover();
    });
    canvas.addEventListener('pointerup', (e) => {
      const moved = this.drag && Math.hypot(e.clientX - this.drag.x, e.clientY - this.drag.y) > 3;
      this.drag = null;
      if (!moved && this.board && this.hover) {
        const p = this.padAt(this.hover.x, this.hover.y);
        const t = p ? p.net : this.trackNetAt(this.hover.x, this.hover.y);
        this.highlight = t === this.highlight ? -1 : t;
        this.draw();
      }
    });
    canvas.addEventListener('dblclick', () => this.fit());
  }

  setBoard(board: Board | null, silk: Silk | null, keepView = false) {
    this.board = board;
    this.silk = silk;
    this.highlight = -1;
    if (!keepView) this.fit(); else this.draw();
  }

  resize() {
    const p = this.canvas.parentElement!;
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(10, p.clientWidth * this.dpr);
    this.canvas.height = Math.max(10, p.clientHeight * this.dpr);
    this.canvas.style.width = `${p.clientWidth}px`;
    this.canvas.style.height = `${p.clientHeight}px`;
    this.fit();
  }

  fit() {
    if (!this.board) { this.draw(); return; }
    const pad = 40 * this.dpr;
    this.scale = Math.min((this.canvas.width - 2 * pad) / this.board.width, (this.canvas.height - 2 * pad) / this.board.height);
    this.ox = (this.canvas.width - this.board.width * this.scale) / 2;
    this.oy = (this.canvas.height - this.board.height * this.scale) / 2;
    this.draw();
  }

  private toBoard(px: number, py: number) {
    if (!this.board) return { x: 0, y: 0 };
    let x = (px - this.ox) / this.scale;
    if (this.flipped) x = this.board.width - x;
    return { x, y: this.board.height - (py - this.oy) / this.scale };
  }

  private padAt(x: number, y: number): WorldPad | undefined {
    return this.board?.pads.find((p) => Math.abs(p.x - x) <= p.w / 2 && Math.abs(p.y - y) <= p.h / 2);
  }
  private trackNetAt(x: number, y: number): number {
    if (!this.board) return -1;
    for (const t of this.board.tracks) for (let i = 0; i + 1 < t.pts.length; i++) {
      const [ax, ay] = t.pts[i], [bx, by] = t.pts[i + 1];
      const vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy || 1;
      const u = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / l2));
      if (Math.hypot(x - ax - u * vx, y - ay - u * vy) <= t.width / 2 + 0.05) return t.net;
    }
    return -1;
  }

  private reportHover() {
    if (!this.board || !this.hover || !this.onHover) return;
    const { x, y } = this.hover;
    const p = this.padAt(x, y);
    let s = `X ${x.toFixed(2)}  Y ${y.toFixed(2)} mm`;
    if (p) s += ` · ${p.ref}.${p.pin} · ${this.board.nets[p.net]?.name ?? 'no net'}`;
    else {
      const n = this.trackNetAt(x, y);
      if (n >= 0) s += ` · track ${this.board.nets[n].name}`;
      else {
        const c = this.board.comps.find((c) => { const r = courtyardRect(c.fp, c.x, c.y, c.rot); return x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1; });
        if (c) s += ` · ${c.ref} ${c.comp.value} (${c.fp.id})`;
      }
    }
    this.onHover(s);
  }

  draw() {
    const ctx = this.ctx;
    const { width, height } = this.canvas;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, width, height);
    const b = this.board;
    if (!b) {
      ctx.fillStyle = '#6e7681';
      ctx.font = `${14 * this.dpr}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText('Describe a circuit on the left and press Generate', width / 2, height / 2);
      return;
    }
    // board coords -> screen: x' = ox + x*s, y' = oy + (H - y)*s
    if (this.flipped) ctx.setTransform(-this.scale, 0, 0, -this.scale, this.ox + b.width * this.scale, this.oy + b.height * this.scale);
    else ctx.setTransform(this.scale, 0, 0, -this.scale, this.ox, this.oy + b.height * this.scale);
    // substrate
    ctx.beginPath();
    roundedRectPath(ctx, 0, 0, b.width, b.height, b.cornerRadius);
    ctx.fillStyle = '#10261a';
    ctx.fill();
    const order: (0 | 1)[] = this.flipped ? [0, 1] : [1, 0];
    for (const L of order) {
      if (L === 1 && !this.layers.bottom) continue;
      if (L === 0 && !this.layers.top) continue;
      const front = this.flipped ? L === 1 : L === 0;
      drawCopperLayer(ctx, b, L, L === 0 ? '#c83434' : '#3a68d8', { pour: this.layers.pour, highlightNet: this.highlight, dim: !front && (this.layers.top && this.layers.bottom) });
    }
    // holes
    ctx.beginPath();
    for (const p of b.pads) if (p.type !== 'smd') holePath(ctx, p);
    for (const v of b.vias) { ctx.moveTo(v.x + v.drill / 2, v.y); ctx.arc(v.x, v.y, v.drill / 2, 0, Math.PI * 2); }
    ctx.fillStyle = '#0d1117';
    ctx.fill();
    // silkscreen (top)
    if (this.layers.silk && this.silk && !this.flipped) {
      ctx.strokeStyle = '#f2f2e6';
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const l of this.silk.lines) {
        ctx.lineWidth = l.w;
        ctx.beginPath();
        l.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.stroke();
      }
    }
    if (this.layers.courtyard) {
      ctx.strokeStyle = '#d0d000';
      ctx.lineWidth = 1 / this.scale;
      for (const c of b.comps) { const r = courtyardRect(c.fp, c.x, c.y, c.rot); ctx.strokeRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0); }
      ctx.strokeStyle = '#ff40ff';
      for (const k of b.keepouts) ctx.strokeRect(k.x0, k.y0, k.x1 - k.x0, k.y1 - k.y0);
    }
    // ratsnest for unrouted connections
    if (this.layers.ratsnest && b.unrouted.length) {
      ctx.strokeStyle = '#ffd33d';
      ctx.lineWidth = 2 / this.scale;
      ctx.setLineDash([6 / this.scale, 4 / this.scale]);
      ctx.beginPath();
      for (const u of b.unrouted) { ctx.moveTo(u.a[0], u.a[1]); ctx.lineTo(u.b[0], u.b[1]); }
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (this.layers.drc) {
      ctx.strokeStyle = '#ff7b00';
      ctx.lineWidth = 2 / this.scale;
      for (const m of this.markers) { ctx.beginPath(); ctx.arc(m.x, m.y, 8 / this.scale, 0, Math.PI * 2); ctx.stroke(); }
    }
    // outline
    ctx.beginPath();
    roundedRectPath(ctx, 0, 0, b.width, b.height, b.cornerRadius);
    ctx.strokeStyle = '#e3b341';
    ctx.lineWidth = 1.5 / this.scale;
    ctx.stroke();
    // highlight net pads label
    if (this.highlight >= 0) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = 'rgba(13,17,23,0.85)';
      ctx.fillRect(8 * this.dpr, 8 * this.dpr, 220 * this.dpr, 26 * this.dpr);
      ctx.fillStyle = '#fff';
      ctx.font = `${13 * this.dpr}px system-ui, sans-serif`;
      ctx.textAlign = 'left';
      ctx.fillText(`Net: ${b.nets[this.highlight]?.name}  (click to clear)`, 16 * this.dpr, 26 * this.dpr);
    }
  }

  /** PNG snapshot of the current view. */
  snapshot(): string { return this.canvas.toDataURL('image/png'); }
}

