// Full design -> board pipeline: placement, routing (with automatic board/layer growth), DRC.
import { buildBoard } from './layout';
import { LAYER_COUNTS, normalizeLayers } from './stackup';
import { route, type Progress } from './router';
import type { Board, Design, Settings } from './types';

/**
 * Place and route. When the layer count is automatic (settings.layers = 0) the pipeline starts at the layer
 * count the design asks for (design.board.layers, default 2) and adds layers (4, 6, 8, 10) before it grows the board.
 */
export function runPipeline(design: Design, settings: Settings, progress?: Progress, startScale = 1): Board {
  const auto = !(design.board.width > 0 && design.board.height > 0);
  const autoLayers = !settings.layers;
  const first = normalizeLayers(settings.layers || design.board.layers || 2);
  const counts = autoLayers ? LAYER_COUNTS.filter((n) => n >= first) : [first];
  const scales = auto ? [startScale, startScale * 1.2, startScale * 1.45] : [1];
  const t0 = Date.now();
  let best: Board | null = null;
  outer: for (let i = 0; i < scales.length; i++) {
    for (const layers of counts) {
      progress?.(0, `${i === 0 ? 'Placing' : `Re-placing (attempt ${i + 1})`} on ${layers} layers`);
      const board = buildBoard(design, settings, scales[i], layers);
      const r = route(board, (f, m) => progress?.(f, m));
      board.tracks = r.tracks;
      board.vias = r.vias;
      board.unrouted = r.unrouted;
      board.pourNet = r.pourNet;
      board.routeLog = r.log;
      if (!best || board.unrouted.length < best.unrouted.length) best = board;
      if (board.unrouted.length === 0) break outer;
      if (Date.now() - t0 > 75_000) break outer; // keep the UI responsive on hopeless designs
    }
  }
  return best!;
}
