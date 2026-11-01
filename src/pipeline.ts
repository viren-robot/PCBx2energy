// Full design -> board pipeline: placement, routing (with automatic board growth), DRC.
import { buildBoard } from './layout';
import { route, type Progress } from './router';
import type { Board, Design, Settings } from './types';

export function runPipeline(design: Design, settings: Settings, progress?: Progress): Board {
  const auto = !(design.board.width > 0 && design.board.height > 0);
  let best: Board | null = null;
  const scales = auto ? [1, 1.2, 1.45] : [1];
  for (let i = 0; i < scales.length; i++) {
    progress?.(0, i === 0 ? 'Placing components' : `Re-placing on a larger board (attempt ${i + 1})`);
    const board = buildBoard(design, settings, scales[i]);
    const r = route(board, (f, m) => progress?.(f, m));
    board.tracks = r.tracks;
    board.vias = r.vias;
    board.unrouted = r.unrouted;
    board.pourNet = r.pourNet;
    board.routeLog = r.log;
    if (!best || board.unrouted.length < best.unrouted.length) best = board;
    if (board.unrouted.length === 0) break;
  }
  return best!;
}
