import { describe, it, expect } from 'vitest';
import { selfReview, runDrcRuns, REVIEW_PASSES, DRC_RUNS } from '../src/verify';
import { offlineDesign } from '../src/templates';
import { DEFAULT_SETTINGS } from '../src/types';
import { runErc } from '../src/erc';

function sse(text: string): Response {
  const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  const body = [
    ev('message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'x', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }),
    ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    ...(text.match(/.{1,500}/gs) ?? []).map((t) => ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } })),
    ev('content_block_stop', { type: 'content_block_stop', index: 0 }),
    ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }),
    ev('message_stop', { type: 'message_stop' }),
  ].join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('verification', () => {
  it('runs exactly 3 review passes and 5 DRC runs (offline rules)', async () => {
    const d = offlineDesign('ESP32 dev board').design;
    const r = await selfReview(d, { model: 'x' });
    expect(r.passes.length).toBe(REVIEW_PASSES);
    const v = runDrcRuns(d, DEFAULT_SETTINGS);
    expect(v.runs.length).toBe(DRC_RUNS);
    expect(v.runs.every((x) => x.errors === 0)).toBe(true);
  }, 120_000);

  it('offline rules repair a missing decoupling capacitor during review', async () => {
    const d = offlineDesign('555 blinker').design;
    d.components = d.components.filter((c) => c.value !== '100nF');
    d.nets.forEach((n) => (n.pins = n.pins.filter((p) => !/^C3\./.test(p))));
    const r = await selfReview(d, { model: 'x' });
    expect(r.passes[0].fixes.length).toBeGreaterThan(0);
    expect(runErc(r.design).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('AI review: accepts an improvement, rejects a regression, calls Claude 3 times', async () => {
    const good = offlineDesign('555 blinker').design;
    const broken = JSON.parse(JSON.stringify(good));
    broken.components = broken.components.filter((c: { ref: string }) => !c.ref.startsWith('R')); // removes LED resistor -> ERC error
    broken.nets.forEach((n: { pins: string[] }) => (n.pins = n.pins.filter((p) => !/^R\d/.test(p))));
    let calls = 0;
    const fetchMock = (async () => {
      calls++;
      if (calls === 1) { const fixed = JSON.parse(JSON.stringify(good)); fixed.notes = ['Review 1: restored the LED resistor']; return sse(JSON.stringify(fixed)); }
      return sse(JSON.stringify(broken)); // later passes try to "fix" by breaking it -> must be rejected
    }) as unknown as typeof fetch;
    const r = await selfReview(broken, { apiKey: 'k', model: 'claude-opus-5-5', fetch: fetchMock });
    expect(calls).toBe(3);
    expect(r.passes[0].fixes.join()).toMatch(/restored the LED resistor/);
    expect(r.passes[1].rejected).toMatch(/rejected/);
    expect(runErc(r.design).filter((i) => i.severity === 'error')).toEqual([]);
  }, 60_000);
});
