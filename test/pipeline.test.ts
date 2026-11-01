import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { runPipeline } from '../src/pipeline';
import { runDrc } from '../src/drc';
import { gerberFiles, makeBom, makePnp } from '../src/export';
import { offlineDesign, EXAMPLES } from '../src/templates';
import { DEFAULT_SETTINGS } from '../src/types';
import { boardSvg } from './debugsvg';

describe('offline examples route cleanly and export', () => {
  for (const ex of EXAMPLES) {
    it(ex.label, () => {
      const { design } = offlineDesign(ex.prompt);
      const t0 = Date.now();
      const board = runPipeline(design, DEFAULT_SETTINGS);
      const r = { log: board.routeLog, unrouted: board.unrouted };
      const t1 = t0, t2 = Date.now();
      const drc = runDrc(board);
      const bad = drc.filter((d) => d.kind !== 'warning');
      console.log(`${ex.label}: ${board.width}x${board.height}mm, ${board.comps.length} parts, place ${t1 - t0}ms, route ${t2 - t1}ms; ${r.log.join(' | ')}; DRC ${bad.length}`);
      for (const d of drc.filter((d) => d.kind !== 'warning').slice(0, 8)) console.log('   ', d.kind, d.msg);
      for (const w of board.warnings) console.log('    warn', w);
      const dir = `test/out/${ex.label.replace(/\W+/g, '_')}`;
      mkdirSync(dir, { recursive: true });
      for (const f of gerberFiles(board, 'jlcpcb')) writeFileSync(`${dir}/${f.name}`, f.content);
      writeFileSync(`${dir}/debug.svg`, boardSvg(board));
      writeFileSync(`${dir}/bom.csv`, makeBom(board, 'jlcpcb').content);
      writeFileSync(`${dir}/cpl.csv`, makePnp(board, 'jlcpcb').content);
      expect(board.warnings.filter((w) => !/only one pin/.test(w))).toEqual([]);
      expect(r.unrouted.length).toBe(0);
      expect(bad.length).toBe(0);
    }, 120_000);
  }
});
