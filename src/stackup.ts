// Layer stack-ups for 2/4/6/8/10-layer boards. S = signal (routable), G = ground plane, P = power plane.
import type { NetInfo } from './types';

export type Role = 'S' | 'G' | 'P';
export const LAYER_COUNTS = [2, 4, 6, 8, 10] as const;

const STACKS: Record<number, Role[]> = {
  2: ['S', 'S'],
  4: ['S', 'G', 'P', 'S'],
  6: ['S', 'G', 'S', 'S', 'P', 'S'],
  8: ['S', 'G', 'S', 'P', 'G', 'S', 'G', 'S'],
  10: ['S', 'G', 'S', 'P', 'G', 'S', 'G', 'S', 'G', 'S'],
};

export interface Stackup { stack: Role[]; planes: { layer: number; net: number }[]; routable: number[] }

export const normalizeLayers = (n: number | undefined | null): number => (n && STACKS[n] ? n : 2);

/** Assign ground / main-power nets to the plane layers of an N-layer stack. */
export function buildStackup(layers: number, nets: NetInfo[], padCount: number[]): Stackup {
  const base = STACKS[normalizeLayers(layers)].slice();
  const gnd = nets.findIndex((n, i) => n.isGround && (padCount[i] ?? 0) > 0);
  let pwr = -1;
  nets.forEach((n, i) => { if (n.isPower && (padCount[i] ?? 0) >= 2 && (pwr < 0 || padCount[i] > padCount[pwr])) pwr = i; });
  const planes: Stackup['planes'] = [];
  const stack = base.map((r, l) => {
    if (r === 'G') { if (gnd < 0) return 'S'; planes.push({ layer: l, net: gnd }); }
    if (r === 'P') { if (pwr < 0) return 'S'; planes.push({ layer: l, net: pwr }); }
    return r;
  }) as Role[];
  return { stack, planes, routable: stack.map((r, l) => (r === 'S' ? l : -1)).filter((l) => l >= 0) };
}

export const layerName = (l: number, n: number) => (l === 0 ? 'F.Cu' : l === n - 1 ? 'B.Cu' : `In${l}.Cu`);
export const LAYER_COLORS = ['#c83434', '#3a68d8', '#d9b320', '#2fb36d', '#c05ae0', '#e0701c', '#2aa7d8', '#8aa0b0', '#e05a8a', '#9bd13d'];
/** Colour of physical layer l in an n-layer board (outer layers keep red/blue). */
export const layerColor = (l: number, n: number) => (l === 0 ? LAYER_COLORS[0] : l === n - 1 ? LAYER_COLORS[1] : LAYER_COLORS[2 + ((l - 1) % 8)]);
