// Pre-submission verification: N AI self-review passes (3) followed by N full DRC runs (5).
import { normalizeDesign, reviewDesign } from './ai';
import { runDrc, type DrcIssue } from './drc';
import { autoFixErc, runErc } from './erc';
import { runPipeline } from './pipeline';
import type { Progress } from './router';
import type { Board, Design, Settings } from './types';

export const REVIEW_PASSES = 3;
export const DRC_RUNS = 5;

export interface ReviewPass { pass: number; source: 'ai' | 'rules'; errorsBefore: number; warningsBefore: number; errorsAfter: number; fixes: string[]; rejected?: string }
export interface DrcRun { run: number; errors: number; boardSize: string; ms: number; messages: string[] }
export interface VerifyReport { reviews: ReviewPass[]; drc: DrcRun[]; ok: boolean; finishedAt: number }

const count = (d: Design) => runErc(d).filter((i) => i.severity === 'error').length;

export interface ReviewCtx { apiKey?: string; model: string; onProgress?: (m: string) => void; signal?: AbortSignal; fetch?: typeof fetch; onPass?: (p: ReviewPass) => void }

/** 3 passes. With an API key Claude re-checks its own circuit each time; a pass is rejected if it makes the ERC worse. */
export async function selfReview(design: Design, ctx: ReviewCtx): Promise<{ design: Design; passes: ReviewPass[] }> {
  let cur = design;
  const passes: ReviewPass[] = [];
  for (let pass = 1; pass <= REVIEW_PASSES; pass++) {
    const issues = runErc(cur);
    const errorsBefore = issues.filter((i) => i.severity === 'error').length;
    const rec: ReviewPass = { pass, source: ctx.apiKey ? 'ai' : 'rules', errorsBefore, warningsBefore: issues.length - errorsBefore, errorsAfter: errorsBefore, fixes: [] };
    if (ctx.apiKey) {
      try {
        const next = await reviewDesign({ apiKey: ctx.apiKey, model: ctx.model, design: cur, issues: issues.map((i) => `${i.severity.toUpperCase()}: ${i.msg}`), pass, total: REVIEW_PASSES, onProgress: ctx.onProgress, signal: ctx.signal, fetch: ctx.fetch });
        const nd = normalizeDesign(next);
        const after = count(nd);
        if (after <= errorsBefore && nd.components.length >= cur.components.length * 0.6) {
          const before = new Set((cur.notes ?? []));
          rec.fixes.push(...(nd.notes ?? []).filter((n) => !before.has(n) && /^Review \d/.test(n)));
          // keep the user's explicit styling/placement if the AI dropped them
          nd.style = { ...cur.style, ...nd.style };
          cur = nd;
        } else rec.rejected = `AI edit rejected (ERC errors ${errorsBefore} → ${after})`;
      } catch (e) {
        if ((e as Error).message === 'Cancelled.') throw e;
        rec.rejected = `AI review failed: ${(e as Error).message}`;
      }
    }
    const fixed = autoFixErc(cur);
    if (fixed.fixes.length) { cur = fixed.design; rec.fixes.push(...fixed.fixes); }
    rec.errorsAfter = count(cur);
    passes.push(rec);
    ctx.onPass?.(rec);
  }
  return { design: cur, passes };
}

/** Run the whole place+route+DRC+LVS flow `runs` times, growing auto-sized boards when a run is not clean. Keeps the best board. */
export function runDrcRuns(design: Design, settings: Settings, runs = DRC_RUNS, progress?: Progress, onRun?: (r: DrcRun) => void): { board: Board; runs: DrcRun[]; issues: DrcIssue[] } {
  let scale = 1;
  let best: { board: Board; issues: DrcIssue[] } | null = null;
  const log: DrcRun[] = [];
  for (let run = 1; run <= runs; run++) {
    const t0 = Date.now();
    const board = runPipeline(design, settings, (f, m) => progress?.((run - 1 + f) / runs, `DRC run ${run}/${runs}: ${m}`), scale);
    const issues = runDrc(board).filter((i) => i.kind !== 'warning');
    const rec: DrcRun = { run, errors: issues.length, boardSize: `${board.width.toFixed(0)}×${board.height.toFixed(0)} mm`, ms: Date.now() - t0, messages: issues.slice(0, 6).map((i) => i.msg) };
    log.push(rec);
    onRun?.(rec);
    if (!best || issues.length < best.issues.length) best = { board, issues };
    if (issues.length && !(design.board.width > 0 && design.board.height > 0)) scale *= 1.12;
  }
  return { board: best!.board, runs: log, issues: best!.issues };
}
