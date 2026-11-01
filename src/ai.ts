// Claude-powered text-to-circuit: turns a natural-language request into a structured Design.
// Runs in the browser with the user's own API key (stored only in localStorage).
import Anthropic from '@anthropic-ai/sdk';
import { FOOTPRINT_IDS, footprintCatalog } from './footprints';
import type { Design } from './types';

export const MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (best)' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (faster)' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (cheapest)' },
];

const DESIGN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'description', 'board', 'components', 'nets', 'notes'],
  properties: {
    name: { type: 'string', description: 'Short board name (max ~30 chars), printed on silkscreen.' },
    description: { type: 'string' },
    board: {
      type: 'object',
      additionalProperties: false,
      required: ['width', 'height', 'cornerRadius'],
      properties: {
        width: { type: 'number', description: 'Board width in mm, or 0 to auto-size.' },
        height: { type: 'number', description: 'Board height in mm, or 0 to auto-size.' },
        cornerRadius: { type: 'number', description: 'Corner radius in mm (typ. 1).' },
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
- Set board width/height to 0 (auto) unless the user specifies a size. If the user gives a size, honour it.
- Add 4x MountingHole_3.2mm_M3 only if asked for mounting holes or the board is larger than ~50x50mm.
- Keep it practical: max ~60 components.
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

export async function generateDesign(o: AiOptions): Promise<Design> {
  const client = new Anthropic({ apiKey: o.apiKey, dangerouslyAllowBrowser: true, maxRetries: 2, ...(o.fetch ? { fetch: o.fetch } : {}) });
  const userText = o.current
    ? `Current design (JSON):\n${JSON.stringify(o.current)}\n\nModify it as follows: ${o.prompt}`
    : `Design a PCB for: ${o.prompt}`;
  const useFallbacks = o.model !== 'claude-haiku-5-5';
  const params = {
    model: o.model,
    max_tokens: 32000,
    system: systemPrompt(),
    messages: [{ role: 'user' as const, content: userText }],
    output_config: { effort: 'high' as const, format: { type: 'json_schema' as const, schema: DESIGN_SCHEMA as unknown as Record<string, unknown> } },
    ...(useFallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
  };
  o.onProgress?.('Sending request to Claude…');
  let chars = 0;
  const run = async (p: typeof params) => {
    const stream = client.beta.messages.stream(p, { signal: o.signal });
    stream.on('text', (delta) => {
      chars += delta.length;
      o.onProgress?.(`Claude is designing the circuit… ${chars.toLocaleString()} chars`);
    });
    return stream.finalMessage();
  };
  let msg;
  try {
    msg = await run(params);
  } catch (e) {
    // If the account/platform rejects the fallback beta, retry once without it.
    if (e instanceof Anthropic.BadRequestError && /fallback/i.test(e.message) && useFallbacks) {
      const { betas: _b, fallbacks: _f, ...rest } = params as typeof params & { betas?: unknown; fallbacks?: unknown };
      void _b; void _f;
      msg = await run(rest as typeof params);
    } else throw friendlyError(e);
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
  if (!Array.isArray(design.components) || !Array.isArray(design.nets)) throw new Error('Claude returned an incomplete design.');
  design.board ??= { width: 0, height: 0, cornerRadius: 1 };
  design.notes ??= [];
  return design;
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
