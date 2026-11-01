// Natural-language board appearance ("make the PCB matte black with gold finish").
import type { DesignStyle } from './types';

const COLORS: [RegExp, string][] = [
  [/\b(matte\s*)?black\b/, '#141414'],
  [/\bwhite\b/, '#f2f2ee'],
  [/\b(dark\s*)?green\b/, '#1f7a3a'],
  [/\b(light|lime|neon)\s*green\b/, '#3ddc68'],
  [/\bpurple|violet\b/, '#5b2a86'],
  [/\bred\b/, '#b3202a'],
  [/\bblue\b/, '#1d4f9c'],
  [/\b(sky|light|cyan|teal)\s*blue\b/, '#2aa7d8'],
  [/\byellow\b/, '#d9b320'],
  [/\borange\b/, '#e0701c'],
  [/\bpink\b/, '#e0559a'],
  [/\b(gr[ae]y|silver)\b/, '#8a8f98'],
  [/\bgold\b/, '#c8a23a'],
  [/\bbrown\b/, '#6b4226'],
];
const HEX = /#([0-9a-f]{6}|[0-9a-f]{3})\b/i;

function firstColor(t: string): string | undefined {
  const h = t.match(HEX);
  if (h) return h[0].length === 4 ? `#${[...h[1]].map((c) => c + c).join('')}` : h[0].toLowerCase();
  let best: { i: number; c: string } | undefined;
  for (const [re, c] of COLORS) {
    const m = re.exec(t);
    if (m && (!best || m.index < best.i)) best = { i: m.index, c };
  }
  return best?.c;
}

/** Extract appearance changes from a prompt. Returns {} when it contains none. */
export function parseStyle(prompt: string): DesignStyle {
  const t = prompt.toLowerCase();
  const out: DesignStyle = {};
  // silkscreen colour: "<color> silk(screen)" or "silk(screen) in <color>"
  const silk = t.match(/([#\w]+(?:\s+[\w]+)?)\s+(?:silk\s*screen|silkscreen|silk|text|legend)\b/) ?? t.match(/(?:silk\s*screen|silkscreen|silk|legend)\s+(?:in|to|as|colou?r)?\s*([#\w]+(?:\s+[\w]+)?)/);
  if (silk) { const c = firstColor(silk[1]); if (c) out.silkColor = c; }
  // board / mask colour
  const stripped = t.replace(/([#\w]+(?:\s+[\w]+)?)\s+(?:silk\s*screen|silkscreen|silk|text|legend)\b/g, ' ').replace(/(?:silk\s*screen|silkscreen|silk|legend)\s+(?:in|to|as|colou?r)?\s*[#\w]+(?:\s+\w+)?/g, ' ');
  const mentionsBoard = /\b(pcb|board|solder\s*mask|mask|colou?r)\b/.test(stripped);
  if (mentionsBoard) {
    const c = firstColor(stripped.replace(/\bgold\b/g, ' ')) ;
    if (c) out.maskColor = c;
  }
  if (/\b(enig|gold finish|gold plated|gold pads|immersion gold)\b/.test(t)) out.finish = 'ENIG';
  else if (/\b(hasl|silver finish|tin finish|lead.?free)\b/.test(t)) out.finish = 'HASL';
  return out;
}

/** True if the prompt is only a cosmetic request (no circuit change needed). */
export function isStyleOnly(prompt: string): boolean {
  const t = prompt.toLowerCase().trim();
  if (!/^(make|change|set|paint|turn|use|switch|colou?r|recolou?r|give|apply)\b/.test(t)) return false;
  const s = parseStyle(prompt);
  if (!s.maskColor && !s.silkColor && !s.finish) return false;
  return !/\b(add|remove|replace|connect|route|resistor|capacitor|led|usb|esp32|header|regulator|sensor|button|switch|hole)\b/.test(t.replace(/\b(switch)\b(?=\s+to\b)/, ''));
}
