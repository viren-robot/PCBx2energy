import type { Board } from '../src/types';
export function boardSvg(b: Board): string {
  const s = 20;
  const Y = (y: number) => (b.height - y) * s;
  const out: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" width="${b.width * s}" height="${b.height * s}" style="background:#123">`];
  out.push(`<rect x="0" y="0" width="${b.width * s}" height="${b.height * s}" fill="none" stroke="yellow"/>`);
  for (const t of b.tracks) out.push(`<polyline points="${t.pts.map(([x, y]) => `${x * s},${Y(y)}`).join(' ')}" fill="none" stroke="${t.layer ? '#36f' : '#e33'}" stroke-opacity="0.8" stroke-width="${t.width * s}" stroke-linecap="round"/>`);
  for (const p of b.pads) out.push(`<rect x="${(p.x - p.w / 2) * s}" y="${Y(p.y + p.h / 2)}" width="${p.w * s}" height="${p.h * s}" fill="${p.type === 'npth' ? '#000' : p.type === 'tht' ? '#ca3' : '#c84'}" fill-opacity="0.85"><title>${p.ref}.${p.pin} ${b.nets[p.net]?.name}</title></rect>`);
  for (const v of b.vias) out.push(`<circle cx="${v.x * s}" cy="${Y(v.y)}" r="${(v.d / 2) * s}" fill="#ddd"/>`);
  for (const u of b.unrouted) out.push(`<line x1="${u.a[0] * s}" y1="${Y(u.a[1])}" x2="${u.b[0] * s}" y2="${Y(u.b[1])}" stroke="#0f0" stroke-width="2"/><circle cx="${u.a[0] * s}" cy="${Y(u.a[1])}" r="6" fill="none" stroke="#0f0" stroke-width="2"/>`);
  for (const c of b.comps) out.push(`<text x="${c.x * s}" y="${Y(c.y)}" fill="#fff" font-size="14" text-anchor="middle">${c.ref}</text>`);
  out.push('</svg>');
  return out.join('\n');
}
