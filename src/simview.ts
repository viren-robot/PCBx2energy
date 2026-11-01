// 2-D simulation overlay: temperature field, trace stress, component status icons.
import { heatCanvas, heatRGB, heatRange } from './heat';
import { roundedRectPath } from './draw';
import { courtyardRect } from './layout';
import { STATUS_COLOR, STATUS_ICON, type SimResult } from './sim';
import type { Board } from './types';

export type SimOverlay = 'temp' | 'volt';

export class SimView {
  private ctx: CanvasRenderingContext2D;
  board: Board | null = null;
  result: SimResult | null = null;
  ambient = 25;
  overlay: SimOverlay = 'temp';
  selected: string | null = null;
  onHover?: (t: string) => void;
  onPick?: (ref: string | null) => void;
  private scale = 10; private ox = 0; private oy = 0; private dpr = 1;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement!);
    canvas.addEventListener('pointermove', (e) => this.hover(e));
    canvas.addEventListener('click', (e) => {
      const p = this.at(e);
      const c = p && this.board?.comps.find((q) => { const r = courtyardRect(q.fp, q.x, q.y, q.rot); return p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1; });
      this.selected = c?.ref ?? null; this.onPick?.(this.selected); this.draw();
    });
  }
  set(board: Board | null, result: SimResult | null, ambient: number) { this.board = board; this.result = result; this.ambient = ambient; this.resize(); }
  resize() {
    const p = this.canvas.parentElement!;
    if (p.clientWidth < 80 || p.clientHeight < 80) return;
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = p.clientWidth * this.dpr; this.canvas.height = p.clientHeight * this.dpr;
    this.canvas.style.width = `${p.clientWidth}px`; this.canvas.style.height = `${p.clientHeight}px`;
    if (this.board) {
      const pad = 36 * this.dpr;
      this.scale = Math.max(1, Math.min((this.canvas.width - 2 * pad) / this.board.width, (this.canvas.height - 2 * pad - 30 * this.dpr) / this.board.height));
      this.ox = (this.canvas.width - this.board.width * this.scale) / 2;
      this.oy = (this.canvas.height - 30 * this.dpr - this.board.height * this.scale) / 2;
    }
    this.draw();
  }
  private at(e: MouseEvent) {
    if (!this.board) return null;
    const r = this.canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * this.dpr - this.ox) / this.scale, y: this.board.height - ((e.clientY - r.top) * this.dpr - this.oy) / this.scale };
  }
  private hover(e: PointerEvent) {
    const p = this.at(e), b = this.board, r = this.result;
    if (!p || !b || !r?.ok) return;
    const h = r.heat;
    const i = Math.floor(p.x / h.cell), j = Math.floor(p.y / h.cell);
    let t = `(${p.x.toFixed(1)}, ${p.y.toFixed(1)}) mm`;
    if (i >= 0 && j >= 0 && i < h.nx && j < h.ny) t += ` · board ${h.T[j * h.nx + i].toFixed(1)} °C`;
    const c = r.comps.find((q) => { const cr = courtyardRect(b.comps.find((x) => x.ref === q.ref)!.fp, q.x, q.y, b.comps.find((x) => x.ref === q.ref)!.rot); return p.x >= cr.x0 && p.x <= cr.x1 && p.y >= cr.y0 && p.y <= cr.y1; });
    if (c) t += ` · ${c.ref} ${c.value}: ${c.tempC.toFixed(0)} °C, ${(c.p * 1000).toFixed(0)} mW, ${(c.i * 1000).toFixed(1)} mA ${STATUS_ICON[c.status]}`;
    this.onHover?.(t);
  }
  draw() {
    const ctx = this.ctx, b = this.board, r = this.result;
    const css = getComputedStyle(document.documentElement);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = css.getPropertyValue('--canvas-bg').trim() || '#0d1117';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (!b) return;
    ctx.setTransform(this.scale, 0, 0, -this.scale, this.ox, this.oy + b.height * this.scale);
    ctx.save();
    ctx.beginPath(); roundedRectPath(ctx, 0, 0, b.width, b.height, b.cornerRadius); ctx.clip();
    ctx.fillStyle = '#20262e'; ctx.fillRect(0, 0, b.width, b.height);
    if (r?.ok && this.overlay === 'temp') {
      const cv = heatCanvas(r.heat, this.ambient, 235);
      ctx.save(); ctx.scale(1, -1); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(cv, 0, -b.height, r.heat.nx * r.heat.cell, b.height); ctx.restore();
    }
    // traces
    ctx.lineCap = 'round';
    const vmax = r?.ok ? Math.max(1, ...Object.values(r.netV)) : 1;
    for (const t of b.tracks) {
      let col = 'rgba(255,255,255,0.35)';
      if (r?.ok) {
        const tr = r.tracks.find((q) => q.net === b.nets[t.net]?.name && q.layer === t.layer);
        if (this.overlay === 'volt') { const v = r.netV[b.nets[t.net]?.name ?? ''] ?? 0; const [R, G, B] = heatRGB(v / vmax); col = `rgb(${R | 0},${G | 0},${B | 0})`; }
        else if (tr && tr.status !== 'ok' && tr.status !== 'off') col = STATUS_COLOR[tr.status];
      }
      ctx.strokeStyle = col; ctx.lineWidth = t.width * 0.9;
      ctx.beginPath(); t.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke();
    }
    ctx.restore();
    // components
    ctx.setTransform(this.scale, 0, 0, -this.scale, this.ox, this.oy + b.height * this.scale);
    for (const c of b.comps) {
      if (c.fp.body.kind === 'hole') continue;
      const cr = courtyardRect(c.fp, c.x, c.y, c.rot);
      const cres = r?.comps.find((q) => q.ref === c.ref);
      const st = cres?.status ?? 'off';
      ctx.strokeStyle = STATUS_COLOR[st]; ctx.lineWidth = (c.ref === this.selected ? 3 : 1.5) / this.scale;
      ctx.fillStyle = st === 'failed' || st === 'burst' ? 'rgba(218,54,51,0.35)' : 'rgba(0,0,0,0.18)';
      ctx.fillRect(cr.x0, cr.y0, cr.x1 - cr.x0, cr.y1 - cr.y0); ctx.strokeRect(cr.x0, cr.y0, cr.x1 - cr.x0, cr.y1 - cr.y0);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const c of b.comps) {
      const cres = r?.comps.find((q) => q.ref === c.ref);
      if (!cres || cres.status === 'off') continue;
      const px = this.ox + c.x * this.scale, py = this.oy + (b.height - c.y) * this.scale;
      ctx.font = `${Math.max(11, 13 * this.dpr)}px system-ui, sans-serif`;
      ctx.fillStyle = '#fff'; ctx.strokeStyle = 'rgba(0,0,0,0.75)'; ctx.lineWidth = 3 * this.dpr;
      const label = `${cres.ref} ${cres.tempC.toFixed(0)}°`;
      ctx.strokeText(label, px, py + 10 * this.dpr); ctx.fillText(label, px, py + 10 * this.dpr);
      if (cres.status !== 'ok') { ctx.font = `${16 * this.dpr}px system-ui, sans-serif`; ctx.fillStyle = STATUS_COLOR[cres.status]; ctx.strokeText(STATUS_ICON[cres.status], px, py - 8 * this.dpr); ctx.fillText(STATUS_ICON[cres.status], px, py - 8 * this.dpr); }
    }
    // outline + legend
    ctx.setTransform(this.scale, 0, 0, -this.scale, this.ox, this.oy + b.height * this.scale);
    ctx.beginPath(); roundedRectPath(ctx, 0, 0, b.width, b.height, b.cornerRadius); ctx.strokeStyle = '#e3b341'; ctx.lineWidth = 1.5 / this.scale; ctx.stroke();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (r?.ok) {
      const [lo, hi] = this.overlay === 'temp' ? heatRange(r.heat, this.ambient) : [0, Math.max(1, ...Object.values(r.netV))];
      const lw = Math.min(360 * this.dpr, this.canvas.width - 60 * this.dpr), lx = (this.canvas.width - lw) / 2, ly = this.canvas.height - 24 * this.dpr;
      const grad = ctx.createLinearGradient(lx, 0, lx + lw, 0);
      for (let i = 0; i <= 10; i++) { const [R, G, B] = heatRGB(i / 10); grad.addColorStop(i / 10, `rgb(${R | 0},${G | 0},${B | 0})`); }
      ctx.fillStyle = grad; ctx.fillRect(lx, ly, lw, 10 * this.dpr);
      ctx.fillStyle = css.getPropertyValue('--text').trim() || '#fff'; ctx.font = `${12 * this.dpr}px system-ui, sans-serif`; ctx.textBaseline = 'top';
      ctx.textAlign = 'left'; ctx.fillText(`${lo.toFixed(0)}${this.overlay === 'temp' ? ' °C' : ' V'}`, lx, ly + 12 * this.dpr);
      ctx.textAlign = 'right'; ctx.fillText(`${hi.toFixed(0)}${this.overlay === 'temp' ? ' °C' : ' V'}`, lx + lw, ly + 12 * this.dpr);
    }
  }
}
