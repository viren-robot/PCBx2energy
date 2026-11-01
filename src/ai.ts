// Claude-powered text-to-circuit: turns a natural-language request into a structured Design.
// Runs in the browser with the user's own API key (stored only in localStorage).
import Anthropic from '@anthropic-ai/sdk';
import { FOOTPRINT_IDS, footprintCatalog } from './footprints';
import type { Design } from './types';

export const MODELS = [
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1 (most capable)' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (faster)' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (cheapest)' },
];

const DESIGN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'description', 'board', 'components', 'nets', 'notes', 'labels', 'style'],
  properties: {
    name: { type: 'string', description: 'Short board name (max ~30 chars), printed on silkscreen.' },
    description: { type: 'string' },
    board: {
      type: 'object',
      additionalProperties: false,
      required: ['width', 'height', 'cornerRadius', 'layers'],
      properties: {
        width: { type: 'number', description: 'Board width in mm, or 0 to auto-size.' },
        height: { type: 'number', description: 'Board height in mm, or 0 to auto-size.' },
        cornerRadius: { type: 'number', description: 'Corner radius in mm (typ. 1).' },
        layers: { type: 'integer', enum: [0, 2, 4, 6, 8, 10], description: 'Copper layer count. 2 for simple boards; 4 for MCU/USB/Wi-Fi boards with many nets (inner ground + power planes); 6-10 only for very dense or high-speed designs. 0 lets the router add layers automatically.' },
      },
    },
    components: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ref', 'footprint', 'value', 'description', 'manufacturer', 'mpn', 'lcsc'],
        properties: {
          ref: { type: 'string', description: 'Reference designator: R1, C3, U1, D2, J1, SW1, Q1, Y1, L1, F1, H1...' },
          footprint: { type: 'string', enum: FOOTPRINT_IDS },
          value: { type: 'string', description: 'e.g. 10k, 100nF, AMS1117-3.3, red' },
          description: { type: 'string' },
          manufacturer: { type: 'string', description: 'Empty string if generic.' },
          mpn: { type: 'string', description: 'Manufacturer part number, empty if generic passive.' },
          lcsc: { type: 'string', description: 'LCSC/JLCPCB part number like C25804 if you are confident, else empty.' },
        },
      },
    },
    nets: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'pins'],
        properties: {
          name: { type: 'string', description: 'Net name: GND, VBUS, 3V3, VCC, SDA, LED1...' },
          pins: { type: 'array', items: { type: 'string', description: 'REF.PIN, e.g. R1.1, U1.8, J1.VBUS, D1.A' } },
        },
      },
    },
    notes: { type: 'array', items: { type: 'string' }, description: 'Design notes / assumptions for the user.' },
    labels: {
      type: 'array',
      description: 'Silkscreen + schematic labels. Label connector/header pins with their function (3V3, GND, TX, RX, SDA...), buttons (RST, BOOT), status LEDs (PWR, STAT), and key ICs.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ref', 'text', 'pin'],
        properties: {
          ref: { type: 'string' },
          text: { type: 'string', description: 'Max 10 characters, upper case.' },
          pin: { type: 'string', description: 'Pin of ref the label belongs to, or empty string for a label next to the whole part.' },
        },
      },
    },
    style: {
      type: 'object',
      additionalProperties: false,
      required: ['maskColor', 'silkColor', 'finish'],
      description: 'Board appearance. Use empty strings unless the user asked for a colour/finish.',
      properties: {
        maskColor: { type: 'string', description: 'Solder mask colour as #rrggbb, or empty string.' },
        silkColor: { type: 'string', description: 'Silkscreen colour as #rrggbb, or empty string.' },
        finish: { type: 'string', enum: ['HASL', 'ENIG', ''] },
      },
    },
  },
} as const;

function systemPrompt(): string {
  return `You are an expert electronics engineer who designs small 2-layer PCBs that are fabricated and assembled by JLCPCB, PCBWay or OSH Park.
Convert the user's request into a complete, electrically correct circuit using ONLY the footprints listed below. An automatic placer, 2-layer autorouter (with a GND pour on the bottom layer) and Gerber exporter run on your output.

Rules:
- Every component must be connected; every net needs >= 2 pins. Pins are written REF.PIN where PIN is a pin number or a documented pin name/alias for that footprint.
- Name the ground net exactly "GND". Use clear power net names (VBUS, 5V, 3V3, VBAT, VIN).
- Include what a real board needs: decoupling caps (100nF per IC power pin + bulk), pull-ups/pull-downs, LED current-limit resistors, CC 5.1k resistors for USB-C sinks, regulator in/out caps, crystal load caps, reset/boot circuitry, programming header.
- Prefer SMD 0603 passives, JLCPCB basic parts. Fill lcsc only if you are confident of the part number; otherwise leave it empty. Fill manufacturer + mpn for ICs, connectors and semiconductors.
- Do not invent pins. For ICs use datasheet pin numbers matching the package.
- Choose board.layers deliberately (2, 4, 6, 8 or 10) and say why in notes. Ground and the main power rail become inner planes on 4+ layer boards. OSH Park only builds 2 and 4 layers.
- Set board width/height to 0 (auto) unless the user specifies a size. If the user gives a size, honour it.
- Add 4x MountingHole_3.2mm_M3 only if asked for mounting holes or the board is larger than ~50x50mm.
- Keep it practical: max ~60 components.
- Always add labels: every header/connector pin that carries a signal or power, buttons, status LEDs and the main ICs.
- Board colour: if the user asks for a colour ("black PCB", "purple board with gold finish", "white silkscreen"), set style.maskColor / silkColor (#rrggbb) / finish; otherwise leave them as empty strings. Mask colours should be real fab colours (green #1f7a3a, black #141414, white #f2f2ee, blue #1d4f9c, red #b3202a, purple #5b2a86, yellow #d9b320).
- When asked to modify an existing design, return the FULL updated design (not a diff), keeping unchanged parts and references stable.

Available footprints:
${footprintCatalog()}`;
}

export interface AiOptions {
  apiKey: string;
  model: string;
  prompt: string;
  current?: Design | null;
  onProgress?: (msg: string) => void;
  signal?: AbortSignal;
  /** Custom fetch (tests / proxies). */
  fetch?: typeof fetch;
}

interface CallOpts { apiKey: string; model: string; system: string; userText: string; onProgress?: (msg: string) => void; signal?: AbortSignal; fetch?: typeof fetch; label: string }

const FIRST_BYTE_MS = 90_000;
const STALL_MS = 60_000;
const TOTAL_MS = 8 * 60_000;

async function requestDesign(o: CallOpts): Promise<Design> {
  const client = new Anthropic({ apiKey: o.apiKey, dangerouslyAllowBrowser: true, maxRetries: 2, ...(o.fetch ? { fetch: o.fetch } : {}) });
  const useFallbacks = o.model !== 'claude-haiku-5-5';
  const params = {
    model: o.model,
    max_tokens: 32000,
    system: o.system,
    messages: [{ role: 'user' as const, content: o.userText }],
    output_config: { effort: 'high' as const, format: { type: 'json_schema' as const, schema: DESIGN_SCHEMA as unknown as Record<string, unknown> } },
    ...(useFallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
  };
  o.onProgress?.(`${o.label}: sending request to Claude…`);
  let chars = 0;
  // Timeouts: give up if nothing arrives for FIRST_BYTE_MS, if the stream stalls for STALL_MS, or after TOTAL_MS overall.
  const ctl = new AbortController();
  const onUserAbort = () => ctl.abort();
  if (o.signal?.aborted) ctl.abort(); else o.signal?.addEventListener('abort', onUserAbort, { once: true });
  let timedOut = '';
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const arm = (ms: number, why: string) => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { timedOut = why; ctl.abort(); }, ms);
  };
  arm(FIRST_BYTE_MS, `Claude did not start replying within ${FIRST_BYTE_MS / 1000} seconds`);
  const totalTimer = setTimeout(() => { timedOut = `The design took longer than ${TOTAL_MS / 60000} minutes`; ctl.abort(); }, TOTAL_MS);
  const run = async (p: typeof params) => {
    const stream = client.beta.messages.stream(p, { signal: ctl.signal });
    stream.on('text', (delta) => {
      chars += delta.length;
      arm(STALL_MS, `Claude stopped responding for ${STALL_MS / 1000} seconds`);
      o.onProgress?.(`${o.label}: Claude is working… ${chars.toLocaleString()} chars`);
    });
    return stream.finalMessage();
  };
  let msg;
  try {
    try {
      msg = await run(params);
    } catch (e) {
      // If the account/platform rejects the fallback beta, retry once without it.
      if (!timedOut && e instanceof Anthropic.BadRequestError && /fallback/i.test(e.message) && useFallbacks) {
        const { betas: _b, fallbacks: _f, ...rest } = params as typeof params & { betas?: unknown; fallbacks?: unknown };
        void _b; void _f;
        msg = await run(rest as typeof params);
      } else throw e;
    }
  } catch (e) {
    if (timedOut) throw new Error(`Timed out: ${timedOut}. Check your internet connection and API key, pick a faster model in Settings, or try a simpler description, then press Create again.`);
    throw friendlyError(e);
  } finally {
    clearTimeout(idleTimer);
    clearTimeout(totalTimer);
    o.signal?.removeEventListener('abort', onUserAbort);
  }
  if (msg.stop_reason === 'refusal') throw new Error('Claude declined this request. Try rephrasing it.');
  if (msg.stop_reason === 'max_tokens') throw new Error('The design was too large for one response. Try a simpler board or fewer parts.');
  const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  let design: Design;
  try {
    design = JSON.parse(text) as Design;
  } catch {
    throw new Error('Claude returned invalid JSON. Please try again.');
  }
  return normalizeDesign(design);
}

export function normalizeDesign(design: Design): Design {
  if (!Array.isArray(design.components) || !Array.isArray(design.nets)) throw new Error('Claude returned an incomplete design.');
  design.board ??= { width: 0, height: 0, cornerRadius: 1 };
  design.board.layers = [2, 4, 6, 8, 10].includes(design.board.layers ?? 0) ? design.board.layers : undefined;
  design.notes ??= [];
  design.labels = (design.labels ?? []).filter((l) => l && l.ref && l.text).map((l) => ({ ref: l.ref, text: l.text.toUpperCase().slice(0, 10), pin: l.pin || undefined }));
  const st = design.style ?? {};
  design.style = {
    maskColor: /^#[0-9a-f]{6}$/i.test(st.maskColor ?? '') ? st.maskColor : undefined,
    silkColor: /^#[0-9a-f]{6}$/i.test(st.silkColor ?? '') ? st.silkColor : undefined,
    finish: st.finish === 'ENIG' || st.finish === 'HASL' ? st.finish : undefined,
  };
  return design;
}

export async function generateDesign(o: AiOptions): Promise<Design> {
  const userText = o.current
    ? `Current design (JSON):\n${JSON.stringify(o.current)}\n\nModify it as follows: ${o.prompt}`
    : `Design a PCB for: ${o.prompt}`;
  return requestDesign({ ...o, system: systemPrompt(), userText, label: 'Design' });
}

export interface ReviewOptions {
  apiKey: string;
  model: string;
  design: Design;
  issues: string[];
  pass: number;
  total: number;
  onProgress?: (msg: string) => void;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

/** One self-review pass: Claude re-checks its own circuit against the automated findings and returns a corrected design. */
export async function reviewDesign(o: ReviewOptions): Promise<Design> {
  const userText = `REVIEW PASS ${o.pass} OF ${o.total}.
Current design (JSON):
${JSON.stringify(o.design)}

Automated electrical checks found ${o.issues.length ? 'these problems:\n- ' + o.issues.join('\n- ') : 'no problems'}.

Re-check your work like a careful reviewer: verify every IC pin number against its datasheet and the footprint pin list, power/ground on every IC, decoupling, pull-ups/pull-downs, LED resistors, USB-C CC resistors, reset/boot circuitry, polarity of diodes/LEDs/electrolytics, duplicated or missing nets, and that labels match what the pins really do.
Fix every real error. Keep references, values and labels that are already correct unchanged. Return the FULL corrected design (add a short note to "notes" for each fix you made, prefixed with "Review ${o.pass}:").`;
  return requestDesign({ apiKey: o.apiKey, model: o.model, system: systemPrompt(), userText, onProgress: o.onProgress, signal: o.signal, fetch: o.fetch, label: `AI review ${o.pass}/${o.total}` });
}

function friendlyError(e: unknown): Error {
  if (e instanceof Anthropic.APIUserAbortError) return new Error('Cancelled.');
  if (e instanceof Anthropic.AuthenticationError) return new Error('Invalid API key (401). Check the key in Settings.');
  if (e instanceof Anthropic.PermissionDeniedError) return new Error('This API key cannot use the selected model (403).');
  if (e instanceof Anthropic.NotFoundError) return new Error('Model not found (404). Pick another model in Settings.');
  if (e instanceof Anthropic.RateLimitError) return new Error('Rate limited (429). Wait a moment and retry.');
  if (e instanceof Anthropic.APIConnectionError) return new Error('Could not reach api.anthropic.com. Check your network connection.');
  if (e instanceof Anthropic.APIError) return new Error(`Claude API error ${e.status ?? ''}: ${e.message}`);
  return e instanceof Error ? e : new Error(String(e));
}

/** Check an API key (and that it can use `model`) with a free metadata call before it is saved. */
export async function validateApiKey(apiKey: string, model: string, opts: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!/^sk-ant-/.test(apiKey)) return { ok: false, error: 'That does not look like an Anthropic key. It should start with "sk-ant-".' };
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 0, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 15_000);
  try {
    await client.models.retrieve(model, {}, { signal: ctl.signal });
    return { ok: true };
  } catch (e) {
    if (ctl.signal.aborted) return { ok: false, error: 'Could not check the key (timed out after 15 seconds). Check your connection and try again.' };
    if (e instanceof Anthropic.AuthenticationError) return { ok: false, error: 'Invalid API key (401). Check that you copied the whole key.' };
    if (e instanceof Anthropic.PermissionDeniedError) return { ok: false, error: 'This key is not allowed to use that model (403). Pick another model.' };
    if (e instanceof Anthropic.NotFoundError) return { ok: false, error: 'The key works, but this account cannot use the selected model (404). Pick another model.' };
    if (e instanceof Anthropic.RateLimitError) return { ok: true }; // rate limited means the key was accepted
    if (e instanceof Anthropic.APIConnectionError) return { ok: false, error: 'Could not reach api.anthropic.com. Check your network connection.' };
    return { ok: false, error: `Could not verify the key: ${(e as Error).message}` };
  } finally { clearTimeout(t); }
}
