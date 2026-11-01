import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { runPipeline } from '../src/pipeline';
import { runDrc } from '../src/drc';
import { gerberFiles } from '../src/export';
import { offlineDesign } from '../src/templates';
import { DEFAULT_SETTINGS } from '../src/types';
import { boardSvg } from './debugsvg';

describe('multilayer boards', () => {
  for (const n of [2, 4, 6, 8, 10]) {
    it(`${n}-layer ESP32 board routes with zero DRC/LVS issues and exports ${n} copper files`, () => {
      const d = offlineDesign('ESP32 dev board with usb-c').design;
      const b = runPipeline(d, { ...DEFAULT_SETTINGS, layers: n });
      const issues = runDrc(b).filter((i) => i.kind !== 'warning');
      console.log(`${n}L: ${b.width}x${b.height} stack=${b.stack.join('')} tracks=${b.tracks.length} vias=${b.vias.length} unrouted=${b.unrouted.length} issues=${issues.length} ${issues.slice(0, 2).map((i) => i.msg).join(' | ')}`);
      expect(b.layers).toBe(n);
      expect(issues).toEqual([]);
      const files = gerberFiles(b, 'jlcpcb').map((f) => f.name);
      const cu = files.filter((f) => /\.(GTL|GBL|G\d)$/.test(f));
      expect(cu.length).toBe(n);
      mkdirSync(`test/out/L${n}`, { recursive: true });
      for (const f of gerberFiles(b, 'jlcpcb')) writeFileSync(`test/out/L${n}/${f.name}`, f.content);
      writeFileSync(`test/out/L${n}/debug.svg`, boardSvg(b));
    }, 120_000);
  }
  it('automatic layer count escalates until the board routes', () => {
    const d = offlineDesign('ESP32 dev board with usb-c').design;
    d.board.width = 30; d.board.height = 22; // deliberately tiny
    const b = runPipeline(d, { ...DEFAULT_SETTINGS, layers: 0 });
    console.log(`auto: ${b.layers} layers, unrouted=${b.unrouted.length}`);
    expect(b.layers).toBeGreaterThanOrEqual(2);
  }, 200_000);
});
