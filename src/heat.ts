// Heat colour map + canvas helpers shared by the simulation tab and the 3D view.
import type { HeatField } from './sim';

const STOPS: [number, number, number, number][] = [
  [0.0, 20, 40, 160], [0.25, 20, 170, 220], [0.5, 60, 200, 90], [0.72, 245, 220, 50], [0.88, 240, 110, 30], [1.0, 255, 255, 255],
];
export function heatRGB(t01: number): [number, number, number] {
  const t = Math.max(0, Math.min(1, t01));
  for (let i = 1; i < STOPS.length; i++) {
    if (t <= STOPS[i][0]) {
      const a = STOPS[i - 1], b = STOPS[i], f = (t - a[0]) / (b[0] - a[0]);
      return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f];
    }
  }
  return [255, 255, 255];
}
/** Colour scale range: ambient .. at least ambient + 20 °C so idle boards do not look "hot". */
export function heatRange(h: HeatField, ambient: number): [number, number] {
  return [ambient, Math.max(ambient + 20, h.max)];
}
/** One pixel per heat cell, y flipped so row 0 is the TOP of the board (canvas convention). */
export function heatCanvas(h: HeatField, ambient: number, alpha = 255): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = h.nx; cv.height = h.ny;
  const ctx = cv.getContext('2d')!;
  const img = ctx.createImageData(h.nx, h.ny);
  const [lo, hi] = heatRange(h, ambient);
  for (let j = 0; j < h.ny; j++) for (let i = 0; i < h.nx; i++) {
    const [r, g, b] = heatRGB((h.T[j * h.nx + i] - lo) / (hi - lo));
    const k = ((h.ny - 1 - j) * h.nx + i) * 4;
    img.data[k] = r; img.data[k + 1] = g; img.data[k + 2] = b; img.data[k + 3] = alpha;
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}
