import { describe, it, expect } from 'vitest';
import { generateDesign } from '../src/ai';
import { offlineDesign } from '../src/templates';
import { runPipeline } from '../src/pipeline';
import { DEFAULT_SETTINGS } from '../src/types';

function sse(text: string, stop = 'end_turn'): Response {
  const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  const chunks = [
    ev('message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }),
    ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    ...(text.match(/.{1,400}/gs) ?? []).map((t) => ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } })),
    ev('content_block_stop', { type: 'content_block_stop', index: 0 }),
    ev('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 100 } }),
    ev('message_stop', { type: 'message_stop' }),
  ];
  return new Response(chunks.join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('Claude design generation (mocked API)', () => {
  const sample = offlineDesign('555 blinker').design;

  it('sends a structured-output request and parses the streamed design', async () => {
    const calls: { url: string; headers: Headers; body: any }[] = [];
    const fetchMock = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
      return sse(JSON.stringify(sample));
    }) as unknown as typeof fetch;
    const progress: string[] = [];
    const d = await generateDesign({ apiKey: 'sk-ant-test', model: 'claude-opus-5-5', prompt: 'blinky', fetch: fetchMock, onProgress: (m) => progress.push(m) });
    expect(d.components.length).toBe(sample.components.length);
    const c = calls[0];
    expect(c.url).toContain('/v1/messages');
    expect(c.body.model).toBe('claude-opus-5-5');
    expect(c.body.stream).toBe(true);
    expect(c.body.output_config.format.type).toBe('json_schema');
    expect(c.body.output_config.format.schema.properties.components.items.properties.footprint.enum).toContain('SOIC-8');
    expect(c.body.fallbacks).toBe('default');
    expect(c.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    expect(c.headers.get('anthropic-dangerous-direct-browser-access')).toBe('true');
    expect(c.headers.get('authorization')).toBe('Bearer sk-ant-test');
    expect(progress.some((p) => /designing/.test(p))).toBe(true);
    // the AI output goes through the real pipeline
    const board = runPipeline(d, DEFAULT_SETTINGS);
    expect(board.unrouted.length).toBe(0);
  });

  it('includes the current design when refining and retries without fallbacks on a 400', async () => {
    const bodies: any[] = [];
    const fetchMock = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      if (body.fallbacks) return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'fallbacks: not enabled for this organization' } }), { status: 400, headers: { 'content-type': 'application/json' } });
      return sse(JSON.stringify(sample));
    }) as unknown as typeof fetch;
    const d = await generateDesign({ apiKey: 'k', model: 'claude-sonnet-5-5', prompt: 'make the LED green', current: sample, fetch: fetchMock });
    expect(d.name).toBe(sample.name);
    expect(bodies.length).toBe(2);
    expect(bodies[0].messages[0].content).toContain('Current design (JSON)');
    expect(bodies[1].fallbacks).toBeUndefined();
  });

  it('reports refusals and auth errors clearly', async () => {
    const refuse = (async () => sse('', 'refusal')) as unknown as typeof fetch;
    await expect(generateDesign({ apiKey: 'k', model: 'claude-haiku-5-5', prompt: 'x', fetch: refuse })).rejects.toThrow(/declined/);
    const unauth = (async () => new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), { status: 401, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    await expect(generateDesign({ apiKey: 'bad', model: 'claude-haiku-5-5', prompt: 'x', fetch: unauth })).rejects.toThrow(/Invalid API key/);
  });
});
