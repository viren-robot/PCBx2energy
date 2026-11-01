// Web Worker: runs placement + routing off the UI thread.
import { runPipeline } from './pipeline';
import type { Design, Settings } from './types';

self.onmessage = (e: MessageEvent<{ id: number; design: Design; settings: Settings }>) => {
  const { id, design, settings } = e.data;
  try {
    let last = 0;
    const board = runPipeline(design, settings, (fraction, msg) => {
      const now = Date.now();
      if (now - last > 80) { last = now; (self as unknown as Worker).postMessage({ id, type: 'progress', fraction, msg }); }
    });
    (self as unknown as Worker).postMessage({ id, type: 'done', board });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
