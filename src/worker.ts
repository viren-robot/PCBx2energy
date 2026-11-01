// Web Worker: runs placement, routing and the 5x DRC verification off the UI thread.
import { runPipeline } from './pipeline';
import { runDrcRuns } from './verify';
import type { Design, Settings } from './types';

type Msg = { id: number; kind?: 'layout' | 'verify'; design: Design; settings: Settings };
const post = (m: unknown) => (self as unknown as Worker).postMessage(m);

self.onmessage = (e: MessageEvent<Msg>) => {
  const { id, design, settings, kind } = e.data;
  try {
    let last = 0;
    const progress = (fraction: number, msg: string) => {
      const now = Date.now();
      if (now - last > 80) { last = now; post({ id, type: 'progress', fraction, msg }); }
    };
    if (kind === 'verify') {
      const r = runDrcRuns(design, settings, undefined, progress, (run) => post({ id, type: 'run', run }));
      post({ id, type: 'done', board: r.board, runs: r.runs });
    } else {
      post({ id, type: 'done', board: runPipeline(design, settings, progress) });
    }
  } catch (err) {
    post({ id, type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
