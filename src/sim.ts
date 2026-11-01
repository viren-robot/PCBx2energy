// Power & thermal simulation.
//  1. DC operating point by nodal analysis (Newton for diodes/LEDs, fixed point for regulators, ICs, MOSFETs)
//  2. Per-component voltage / current / power -> temperature rise -> stress checks and failure modes
//  3. Trace current, IR drop and heating (IPC-2221)
//  4. 2-D steady-state heat diffusion over the board (copper planes spread heat, both faces convect)
// Engineering estimates, not a substitute for lab measurement: datasheet values are typical.
import { getFootprint, resolvePin } from './footprints';
import type { Board, PlacedComponent } from './types';

export interface SimSource { id: string; /** net name or REF.PIN */ target: string; volts: number; limitA: number; enabled: boolean }
export interface SimInput { sources: SimSource[]; ambientC: number; closedSwitches: string[]; cascade: boolean }
export type Status = 'off' | 'ok' | 'warm' | 'hot' | 'overstress' | 'failed' | 'burst';
export const STATUS_RANK: Record<Status, number> = { off: 0, ok: 1, warm: 2, hot: 3, overstress: 4, failed: 5, burst: 6 };

export interface CompResult {
  ref: string; value: string; fp: string; kind: string;
  vAcross: number; vSupply: number; i: number; p: number; tempC: number; maxTempC: number;
  status: Status; messages: string[]; x: number; y: number;
}
export interface TrackResult { net: string; layer: number; width: number; lengthMm: number; iA: number; dT: number; dropMv: number; status: Status; x: number; y: number }
export interface SourceResult { id: string; net: string; volts: number; vActual: number; iA: number; limitA: number; limited: boolean; pW: number; pin?: string; pinRatingA?: number }
export interface HeatField { nx: number; ny: number; cell: number; T: Float32Array; max: number; min: number }
export interface SimResult {
  ok: boolean; error?: string;
  netV: Record<string, number>;
  comps: CompResult[]; tracks: TrackResult[]; sources: SourceResult[];
  heat: HeatField; totalW: number; boardRiseC: number; maxBoardC: number;
  events: string[]; cascadeRounds: number;
}

const GMIN = 1e-9;
const RSRC = 0.05; // source output resistance incl. cable
const VT = 0.02585;

export function parseOhms(v: string): number {
  const m = v.trim().match(/^(\d+(?:\.\d+)?)\s*([kKmMrRΩ]?)/);
  if (!m) return NaN;
  const x = parseFloat(m[1]);
  const u = m[2];
  return u === 'k' || u === 'K' ? x * 1e3 : u === 'M' ? x * 1e6 : x;
}
// ---- part knowledge (typical datasheet values) ----
const R_RATING: Record<string, number> = { R_0402: 0.0625, R_0603: 0.1, R_0805: 0.125, R_1206: 0.25 };
const R_THETA: Record<string, number> = { R_0402: 800, R_0603: 500, R_0805: 400, R_1206: 250 };
const C_VMAX: Record<string, number> = { C_0402: 16, C_0603: 25, C_0805: 25, C_1206: 50 };
const LED_VF: Record<string, number> = { red: 2.0, green: 2.2, yellow: 2.1, blue: 3.0, white: 3.0, orange: 2.0 };

interface IcSpec { name: string; iA: number; vMin: number; vMax: number; vAbs: number; maxT: number; theta: number }
function icSpec(c: PlacedComponent): IcSpec {
  const t = `${c.comp.value} ${c.comp.mpn} ${c.fp.id}`.toUpperCase();
  const th = (def: number) => def;
  if (/ESP32/.test(t)) return { name: 'ESP32 module', iA: 0.16, vMin: 3.0, vMax: 3.6, vAbs: 3.6, maxT: 85, theta: th(35) };
  if (/ATMEGA|328/.test(t)) return { name: 'ATmega328P', iA: 0.012, vMin: 2.7, vMax: 5.5, vAbs: 6.0, maxT: 105, theta: th(60) };
  if (/STM32/.test(t)) return { name: 'STM32F1', iA: 0.04, vMin: 2.0, vMax: 3.6, vAbs: 4.0, maxT: 105, theta: th(65) };
  if (/NE555|555/.test(t)) return { name: 'NE555', iA: 0.01, vMin: 4.5, vMax: 16, vAbs: 18, maxT: 70, theta: th(150) };
  if (/CH340/.test(t)) return { name: 'CH340C', iA: 0.012, vMin: 3.3, vMax: 5.3, vAbs: 6.0, maxT: 85, theta: th(110) };
  return { name: 'unknown IC', iA: 0.01, vMin: 1.8, vMax: 5.5, vAbs: 6.0, maxT: 85, theta: th(110) };
}
interface RegSpec { kind: 'ams1117' | 'ldo' | 'lm78'; vout: number; dropout: number; iq: number; iMax: number; vinAbs: number; theta: number; maxT: number; pin: { in: string; out: string; gnd: string; en?: string } }
function regSpec(c: PlacedComponent): RegSpec | null {
  const t = `${c.comp.value} ${c.comp.mpn}`.toUpperCase();
  const num = (def: number) => { const m = t.match(/(\d\.\d)\b/); return m ? parseFloat(m[1]) : def; };
  if (/AMS1117|LM1117|LD1117|AP1117/.test(t)) return { kind: 'ams1117', vout: num(3.3), dropout: 1.1, iq: 0.005, iMax: 1.0, vinAbs: 15, theta: 60, maxT: 125, pin: { in: 'VIN', out: 'VOUT', gnd: 'GND' } };
  if (/AP2112|XC6206|ME6211|RT9013|HT7333|LP2985|MCP1700/.test(t)) return { kind: 'ldo', vout: num(3.3), dropout: 0.3, iq: 0.00006, iMax: 0.6, vinAbs: 6, theta: 200, maxT: 125, pin: { in: '1', out: '5', gnd: '2', en: '3' } };
  const m = t.match(/78(\d\d)|LM78(\d\d)/);
  if (m && /TO-220/.test(c.fp.id)) return { kind: 'lm78', vout: parseInt(m[1] ?? m[2], 10), dropout: 2.0, iq: 0.005, iMax: 1.5, vinAbs: 35, theta: 62, maxT: 125, pin: { in: '1', out: '3', gnd: '2' } };
  return null;
}

const diodeSpec = (c: PlacedComponent) => {
  const t = `${c.comp.value} ${c.comp.mpn}`.toUpperCase();
  const schottky = /SS\d|B5819|SK\d|SB\d|SCHOTTKY|1N581/.test(t);
  const sma = c.fp.id === 'D_SMA';
  return { vf: schottky ? 0.38 : 0.72, n: schottky ? 1.05 : 1.8, iRated: /5819/.test(t) ? 1 : sma ? 3 : 0.3, vrMax: schottky ? 40 : 75, theta: sma ? 60 : 300 };
};

function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-18) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      if (f === 0) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

type Dead = Map<string, 'open' | 'short'>;

interface Solved { V: number[]; src: SourceResult[]; ic: Map<string, number>; reg: Map<string, { iin: number; iout: number; vout: number; off: boolean }>; fet: Map<string, boolean>; iters: number; converged: boolean }

export function simulate(board: Board, input: SimInput): SimResult {
  const empty = (error: string): SimResult => ({ ok: false, error, netV: {}, comps: [], tracks: [], sources: [], heat: { nx: 1, ny: 1, cell: 1, T: new Float32Array(1), max: input.ambientC, min: input.ambientC }, totalW: 0, boardRiseC: 0, maxBoardC: input.ambientC, events: [], cascadeRounds: 0 });
  const nets = board.nets;
  const gnd = nets.findIndex((n) => n.isGround);
  if (gnd < 0) return empty('The design has no ground net (name it "GND").');
  const n = nets.length;
  const netByName = new Map(nets.map((x, i) => [x.name.toLowerCase(), i]));
  const padNet = (ref: string, pin: string): number => {
    const c = board.comps.find((q) => q.ref === ref);
    const id = c ? resolvePin(c.fp, pin) ?? pin : pin;
    const p = board.pads.find((q) => q.ref === ref && q.pin === id && q.net >= 0);
    return p ? p.net : -1;
  };
  // resolve sources
  const srcs = input.sources.filter((s) => s.enabled).map((s) => {
    const t = s.target.trim();
    let net = netByName.get(t.toLowerCase()) ?? -1;
    let pin: string | undefined;
    const m = t.match(/^([^.\s(]+)\.([^\s(]+)/);
    if (net < 0 && m) { net = padNet(m[1], m[2]); pin = `${m[1]}.${m[2]}`; }
    return { s, net, pin };
  });
  const bad = srcs.find((x) => x.net < 0);
  if (bad) return empty(`Power source target "${bad.s.target}" is not a net or pin of this design.`);
  if (!srcs.length) return empty('Add at least one enabled power source.');

  // ---- devices ----
  const comps = board.comps.filter((c) => c.fp.body.kind !== 'hole');
  const events: string[] = [];
  let dead: Dead = new Map();
  let solved: Solved | null = null;
  let rounds = 0;
  let results: CompResult[] = [];

  function solve(dead: Dead, limited = new Set<string>()): Solved {
    let V = new Array<number>(n).fill(0);
    const fet = new Map<string, boolean>();
    const regState = new Map<string, { iin: number; iout: number; vout: number; off: boolean }>();
    const icI = new Map<string, number>();
    let converged = false, it = 0;
    for (; it < 120; it++) {
      const G: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
      const b = new Array<number>(n).fill(0);
      const g2 = (a: number, c: number, g: number) => { if (a < 0 || c < 0) return; G[a][a] += g; G[c][c] += g; G[a][c] -= g; G[c][a] -= g; };
      const inj = (a: number, i: number) => { if (a >= 0) b[a] += i; };
      for (let i = 0; i < n; i++) G[i][i] += GMIN;

      for (const { s, net } of srcs) {
        if (limited.has(s.id)) { inj(net, s.limitA); G[net][net] += 1e-6; }
        else { G[net][net] += 1 / RSRC; b[net] += s.volts / RSRC; }
      }
      for (const c of comps) {
        const ref = c.ref, id = c.fp.id, mode = dead.get(ref);
        const pn = (pin: string) => padNet(ref, pin);
        if (/^R_/.test(id)) {
          const r = Math.max(0.001, parseOhms(c.comp.value) || 1e9);
          if (mode === 'open') continue;
          g2(pn('1'), pn('2'), 1 / r);
        } else if (/^L_/.test(id)) { if (mode !== 'open') g2(pn('1'), pn('2'), 1 / 0.08); }
        else if (/^F_/.test(id)) { if (mode !== 'open') g2(pn('1'), pn('2'), 1 / 0.1); }
        else if (/^SW_/.test(id)) g2(pn('1'), pn('2'), input.closedSwitches.includes(ref) ? 20 : GMIN);
        else if (/^C_/.test(id) && mode === 'short') g2(pn('1'), pn('2'), 1 / 0.05);
        else if (/^CP_/.test(id) && mode === 'short') g2(pn('1'), pn('2'), 1 / 0.2);
        else if (/^(LED_|D_)/.test(id)) {
          if (mode === 'open') continue;
          const a = pn('A'), k = pn('K');
          if (a < 0 || k < 0) continue;
          let vf: number, nn: number;
          if (/^LED_/.test(id)) { vf = LED_VF[c.comp.value.toLowerCase()] ?? LED_VF[(c.comp.description.match(/red|green|blue|yellow|white|orange/i) ?? ['red'])[0].toLowerCase()] ?? 2.0; nn = 2; }
          else { const d = diodeSpec(c); vf = d.vf; nn = d.n; }
          const is = 0.01 / Math.exp(vf / (nn * VT)); // Vf at 10 mA
          let vd = V[a] - V[k];
          vd = Math.min(vd, vf + 1.2);
          const e = Math.exp(Math.min(vd / (nn * VT), 60));
          let i = is * (e - 1), gd = (is * e) / (nn * VT);
          if (vd < -5) { i = -1e-6 - (-vd - 5) * 1e-3; gd = 1e-3; } // reverse breakdown region (flagged later)
          gd = Math.max(gd, GMIN);
          G[a][a] += gd; G[k][k] += gd; G[a][k] -= gd; G[k][a] -= gd;
          const ieq = i - gd * vd;
          b[a] -= ieq; b[k] += ieq;
        } else if (id === 'SOT-23' && /^Q/.test(ref)) {
          const gt = pn('G'), s = pn('S'), d = pn('D');
          const on = gt >= 0 && s >= 0 ? V[gt] - V[s] > 1.5 : false;
          fet.set(ref, on);
          g2(d, s, on ? 1 / 0.04 : GMIN);
        }
        const reg = regSpec(c);
        if (reg) {
          const vin = V[pn(reg.pin.in)] ?? 0;
          const en = reg.pin.en ? pn(reg.pin.en) : -1;
          const enOff = en >= 0 && V[en] < 1.0 && reg.kind === 'ldo';
          const target = enOff || mode === 'open' ? 0 : Math.max(0, Math.min(reg.vout, vin - reg.dropout));
          const out = pn(reg.pin.out), inn = pn(reg.pin.in);
          // a linear regulator can only source current: when something else pulls the output above its target it stops driving
          if (out >= 0 && V[out] <= target + 0.02) { G[out][out] += 1 / RSRC; b[out] += target / RSRC; }
          const iout = out >= 0 ? Math.max(0, (target - V[out]) / RSRC) : 0;
          const iin = enOff ? 1e-6 : iout + reg.iq;
          regState.set(ref, { iin, iout, vout: target, off: enOff });
          // pass current is a (fixed) sink; the small quiescent current is resistive so an unpowered input can't run away
          if (inn >= 0 && mode !== 'short') { b[inn] -= iout; G[inn][inn] += reg.iq / Math.max(reg.vout, 1); }
          if (mode === 'short' && out >= 0 && inn >= 0) g2(inn, out, 1 / 0.2);
        }
        if (['ic', 'qfp', 'qfn', 'module', 'dip'].includes(c.fp.body.kind) && !reg) {
          const spec = icSpec(c);
          const rail = railOf(c);
          if (rail >= 0 && mode !== 'open') {
            const v = Math.max(V[rail], 0);
            const dead_ = mode === 'short';
            const i = dead_ ? 0 : spec.iA * Math.min(1, (v / spec.vMin) ** 2);
            icI.set(ref, i);
            b[rail] -= i;
            if (dead_) G[rail][rail] += 1 / 0.5;
          }
        }
      }
      G[gnd] = new Array<number>(n).fill(0);
      for (let r = 0; r < n; r++) G[r][gnd] = 0;
      G[gnd][gnd] = 1; b[gnd] = 0;
      const x = solveLinear(G, b);
      if (!x) break;
      let md = 0;
      for (let i = 0; i < n; i++) {
        const step = Math.max(-2, Math.min(2, x[i] - V[i]));
        md = Math.max(md, Math.abs(x[i] - V[i]));
        V[i] += i === gnd ? 0 : step * (it > 30 ? 0.6 : 1);
      }
      if (md < 1e-7) { converged = true; break; }
    }
    // source currents
    const sres: SourceResult[] = srcs.map(({ s, net, pin }) => {
      const lim = limited.has(s.id);
      const iA = lim ? s.limitA : (s.volts - V[net]) / RSRC;
      return { id: s.id, net: nets[net].name, volts: s.volts, vActual: V[net], iA, limitA: s.limitA, limited: lim, pW: V[net] * iA, pin };
    });
    return { V, src: sres, ic: icI, reg: regState, fet, iters: it, converged };
  }
  function railOf(c: PlacedComponent): number {
    // main supply rail of an IC: power-named net with the most pins on this part (ties -> highest voltage later)
    const counts = new Map<number, number>();
    for (const p of board.pads) if (p.ref === c.ref && p.net >= 0 && nets[p.net].isPower) counts.set(p.net, (counts.get(p.net) ?? 0) + 1);
    let best = -1, bc = 0;
    for (const [k, v] of counts) if (v > bc) { bc = v; best = k; }
    return best;
  }

  // run with supply current-limiting
  const doSolve = (dead: Dead): Solved => {
    const lim = new Set<string>();
    let s = solve(dead, lim);
    for (let pass = 0; pass < 3; pass++) {
      let changed = false;
      for (const r of s.src) if (!lim.has(r.id) && r.iA > r.limitA + 1e-9 && r.limitA > 0) { lim.add(r.id); changed = true; }
      if (!changed) break;
      s = solve(dead, lim);
    }
    return s;
  };
  const runAll = () => { solved = doSolve(dead); results = evaluate(solved); };

  // ---- per-component evaluation (stress, power, failure modes) ----
  function evaluate(S: Solved): CompResult[] {
    const out: CompResult[] = [];
    const Vn = (net: number) => (net >= 0 ? S.V[net] : 0);
    const planes = board.planes.length;
    const spread = 1 - 0.1 * Math.min(planes, 3);
    for (const c of comps) {
      const id = c.fp.id, ref = c.ref;
      const pn = (pin: string) => padNet(ref, pin);
      const r: CompResult = { ref, value: c.comp.value, fp: id, kind: 'part', vAcross: 0, vSupply: 0, i: 0, p: 0, tempC: 0, maxTempC: 125, status: 'ok', messages: [], x: c.x, y: c.y };
      let theta = 150, maxP = Infinity;
      const mode = dead.get(ref);
      const bump = (st: Status, msg: string) => { if (STATUS_RANK[st] > STATUS_RANK[r.status]) r.status = st; r.messages.push(msg); };
      if (/^R_/.test(id)) {
        r.kind = 'resistor';
        const R = Math.max(0.001, parseOhms(c.comp.value) || 1e9);
        const v = Vn(pn('1')) - Vn(pn('2'));
        r.vAcross = v; r.i = mode === 'open' ? 0 : v / R; r.p = mode === 'open' ? 0 : v * v / R;
        theta = (R_THETA[id] ?? 500) * spread; maxP = R_RATING[id] ?? 0.1; r.maxTempC = 155;
        if (mode === 'open') bump('failed', 'Burnt open (failed in the previous round)');
      } else if (/^C_/.test(id)) {
        r.kind = 'ceramic capacitor';
        const v = Vn(pn('1')) - Vn(pn('2'));
        r.vAcross = v; r.maxTempC = 125;
        const vmax = (/100n|0\.1u|1u|10n/i.test(c.comp.value) ? 50 : C_VMAX[id] ?? 25);
        if (mode === 'short') { r.i = v / 0.05; r.p = v * r.i; bump('failed', 'Cracked and shorted (failed in the previous round)'); }
        if (Math.abs(v) > vmax * 1.5) bump('failed', `${v.toFixed(1)} V across a ${vmax} V capacitor - it cracks and fails short`);
        else if (Math.abs(v) > vmax) bump('overstress', `${v.toFixed(1)} V exceeds the ${vmax} V rating`);
        else if (Math.abs(v) > vmax * 0.8) bump('hot', `${((Math.abs(v) / vmax) * 100).toFixed(0)}% of rated voltage (ceramics lose capacitance under DC bias)`);
        theta = 300 * spread;
      } else if (/^CP_/.test(id)) {
        r.kind = 'electrolytic capacitor';
        const v = Vn(pn('1')) - Vn(pn('2'));
        r.vAcross = v; r.maxTempC = 105;
        const vmax = /47u|100u|220u/i.test(c.comp.value) ? 16 : 25;
        if (v < -1.0) bump('burst', `Reverse polarity: ${v.toFixed(1)} V across an electrolytic - it vents, swells and BURSTS`);
        if (v > vmax * 1.3) bump('burst', `${v.toFixed(1)} V on a ${vmax} V electrolytic - it vents and bursts`);
        else if (v > vmax) bump('overstress', `${v.toFixed(1)} V exceeds the ${vmax} V rating`);
        else if (v > vmax * 0.8) bump('hot', 'Above 80% of rated voltage - shortened life');
        theta = 120 * spread;
      } else if (/^L_/.test(id)) {
        r.kind = 'inductor';
        const v = Vn(pn('1')) - Vn(pn('2'));
        r.vAcross = v; r.i = v / 0.08; r.p = v * r.i; theta = 120 * spread; r.maxTempC = 125;
        const irat = id === 'L_1210' ? 2 : 0.5;
        if (Math.abs(r.i) > irat * 1.5) bump('failed', `${Math.abs(r.i).toFixed(2)} A in a ${irat} A inductor - saturates/overheats`);
        else if (Math.abs(r.i) > irat) bump('overstress', `${Math.abs(r.i).toFixed(2)} A exceeds the ${irat} A rating`);
      } else if (/^F_/.test(id)) {
        r.kind = 'fuse / PTC';
        const v = Vn(pn('1')) - Vn(pn('2'));
        r.vAcross = v; r.i = mode === 'open' ? 0 : v / 0.1; r.p = mode === 'open' ? 0 : v * r.i; theta = 80 * spread;
        if (mode === 'open') bump('failed', 'Fuse blew / PTC tripped (protective)');
        else if (Math.abs(r.i) > 1.0) bump('failed', `${Math.abs(r.i).toFixed(2)} A exceeds the 1 A trip current - it opens`);
      } else if (/^LED_/.test(id)) {
        r.kind = 'LED';
        const a = pn('A'), k = pn('K');
        const v = Vn(a) - Vn(k);
        const vf = LED_VF[c.comp.value.toLowerCase()] ?? 2.0;
        const nn = 2, is = 0.01 / Math.exp(vf / (nn * VT));
        r.vAcross = v;
        r.i = mode === 'open' ? 0 : v > -5 ? is * (Math.exp(Math.min(v / (nn * VT), 60)) - 1) : -1e-3;
        r.p = Math.max(0, v * r.i); theta = 300 * spread; r.maxTempC = 100;
        if (mode === 'open') bump('failed', 'LED burnt out (open)');
        else if (r.i > 0.040) bump('failed', `${(r.i * 1000).toFixed(0)} mA through an LED rated 20 mA - it burns out`);
        else if (r.i > 0.022) bump('overstress', `${(r.i * 1000).toFixed(0)} mA exceeds the 20 mA rating`);
        else if (r.i > 0.017) bump('hot', 'Near the 20 mA limit');
        if (v < -5) bump('failed', `Reverse voltage ${(-v).toFixed(1)} V exceeds the 5 V LED reverse limit`);
      } else if (/^D_/.test(id)) {
        r.kind = 'diode';
        const d = diodeSpec(c);
        const v = Vn(pn('A')) - Vn(pn('K'));
        r.vAcross = v;
        const is = 0.01 / Math.exp(d.vf / (d.n * VT));
        r.i = mode === 'open' ? 0 : v > -d.vrMax ? is * (Math.exp(Math.min(v / (d.n * VT), 60)) - 1) : -1;
        r.p = Math.max(0, v * r.i); theta = d.theta * spread; r.maxTempC = 150;
        if (r.i > d.iRated * 1.5) bump('failed', `${r.i.toFixed(2)} A exceeds the ${d.iRated} A rating`);
        else if (r.i > d.iRated) bump('overstress', `${r.i.toFixed(2)} A exceeds the ${d.iRated} A rating`);
        if (v < -d.vrMax) bump('failed', `Reverse ${(-v).toFixed(0)} V exceeds the ${d.vrMax} V breakdown`);
      } else if (/^SW_/.test(id)) {
        r.kind = 'switch';
        const v = Vn(pn('1')) - Vn(pn('2'));
        r.vAcross = v; r.i = input.closedSwitches.includes(ref) ? v / 0.05 : 0; r.p = v * r.i; theta = 100;
        if (Math.abs(r.i) > 0.05) bump('overstress', 'Tactile switches are rated for 50 mA');
      } else if (regSpec(c)) {
        const reg = regSpec(c)!;
        r.kind = 'voltage regulator';
        const st = S.reg.get(ref);
        const vin = Vn(pn(reg.pin.in)), vout = Vn(pn(reg.pin.out));
        r.vSupply = vin; r.vAcross = vin - vout; r.i = st?.iout ?? 0;
        r.p = Math.max(0, (vin - vout) * r.i + vin * reg.iq); theta = reg.theta * spread; r.maxTempC = reg.maxT;
        maxP = Infinity;
        if (vin > reg.vinAbs * 1.2) bump('burst', `${vin.toFixed(1)} V on the input (abs. max ${reg.vinAbs} V) - regulator destroyed, may vent`);
        else if (vin > reg.vinAbs) bump('failed', `${vin.toFixed(1)} V exceeds the ${reg.vinAbs} V absolute maximum`);
        if (st && !st.off && vin < reg.vout + reg.dropout - 0.01 && vin > 0.5) bump('overstress', `Dropout: ${vin.toFixed(2)} V in is below ${(reg.vout + reg.dropout).toFixed(2)} V needed - output sags to ${vout.toFixed(2)} V`);
        if (r.i > reg.iMax * 1.3) bump('failed', `${r.i.toFixed(2)} A load exceeds the ${reg.iMax} A limit - thermal shutdown / damage`);
        else if (r.i > reg.iMax) bump('overstress', `${r.i.toFixed(2)} A exceeds the ${reg.iMax} A rating`);
        if (vin < -0.5) bump('failed', 'Reverse input voltage');
      } else if (c.fp.id === 'SOT-23' && /^Q/.test(ref)) {
        r.kind = 'MOSFET';
        const on = S.fet.get(ref) ?? false;
        const vds = Vn(pn('D')) - Vn(pn('S')), vgs = Vn(pn('G')) - Vn(pn('S'));
        r.vAcross = vds; r.i = on ? vds / 0.04 : 0; r.p = on ? vds * r.i : 0; theta = 160 * spread; r.maxTempC = 150;
        if (Math.abs(vgs) > 12) bump('failed', `Vgs ${vgs.toFixed(1)} V exceeds ±12 V - gate oxide punctures`);
        if (vds > 30) bump('failed', `Vds ${vds.toFixed(1)} V exceeds the 30 V rating`);
        if (r.i > 5.7) bump('failed', `${r.i.toFixed(1)} A exceeds the 5.7 A rating`);
        else if (r.i > 3) bump('hot', `${r.i.toFixed(1)} A: needs copper area for cooling`);
      } else if (['ic', 'qfp', 'qfn', 'module', 'dip'].includes(c.fp.body.kind)) {
        const spec = icSpec(c);
        r.kind = spec.name;
        const rail = railOf(c);
        const v = rail >= 0 ? Vn(rail) : 0;
        r.vSupply = v; r.i = S.ic.get(ref) ?? 0; r.p = v * r.i; theta = spec.theta * spread; r.maxTempC = spec.maxT;
        if (mode === 'short') bump('failed', 'Destroyed (shorted supply)');
        if (v > spec.vAbs * 1.15) bump('burst', `${v.toFixed(1)} V on a ${spec.vAbs} V-max supply pin - the chip is destroyed and can crack/burn`);
        else if (v > spec.vAbs) bump('failed', `${v.toFixed(1)} V exceeds the ${spec.vAbs} V absolute maximum`);
        else if (v > spec.vMax) bump('overstress', `${v.toFixed(2)} V is above the ${spec.vMax} V recommended maximum`);
        if (rail >= 0 && v < spec.vMin && v > 0.2) bump('overstress', `Brown-out: ${v.toFixed(2)} V is below the ${spec.vMin} V minimum - it will reset / misbehave`);
        if (v < -0.5) bump('failed', 'Reverse supply voltage');
        if (spec.name === 'unknown IC') r.messages.push('Unknown IC: assumed 10 mA and 6 V abs. max');
      } else continue;

      // power rating
      if (Number.isFinite(maxP) && r.p > 0) {
        if (r.p > maxP * 2) bump('failed', `${(r.p * 1000).toFixed(0)} mW in a ${(maxP * 1000).toFixed(0)} mW part - it burns out`);
        else if (r.p > maxP) bump('overstress', `${(r.p * 1000).toFixed(0)} mW exceeds the ${(maxP * 1000).toFixed(0)} mW rating`);
        else if (r.p > maxP * 0.8) bump('hot', `${((r.p / maxP) * 100).toFixed(0)}% of power rating`);
      }
      (r as CompResult & { theta: number }).theta = theta;
      out.push(r);
    }
    return out;
  }

  // ---------- solve (with failure cascade) ----------
  runAll();
  const firstFail = new Set<string>();
  for (let round = 0; round < (input.cascade ? 3 : 0); round++) {
    const newDead: Dead = new Map(dead);
    for (const r of results) {
      if (STATUS_RANK[r.status] < STATUS_RANK.failed || dead.has(r.ref)) continue;
      const id = r.fp;
      const mode: 'open' | 'short' | null = /^(R_|LED_|F_|L_)/.test(id) ? 'open' : /^(C_|CP_)/.test(id) ? 'short' : /^(SOT-223|TO-)/.test(id) ? 'short' : null;
      if (mode) { newDead.set(r.ref, mode); events.push(`Round ${round + 1}: ${r.ref} (${r.kind}) fails ${mode === 'open' ? 'open' : 'short'} - ${r.messages[0] ?? ''}`); firstFail.add(r.ref); }
    }
    if (newDead.size === dead.size) break;
    const before = new Map(results.map((r) => [r.ref, r]));
    dead = newDead; rounds++;
    runAll();
    // keep the original cause text for parts that failed
    for (const r of results) { const b0 = before.get(r.ref); if (b0 && firstFail.has(r.ref) && STATUS_RANK[b0.status] > STATUS_RANK[r.status]) { r.status = b0.status; r.messages = [...b0.messages, ...r.messages.filter((m) => !b0.messages.includes(m))]; } }
  }
  const S = solved as unknown as Solved;
  const sres = S.src;
  for (const s of sres) if (s.limited) events.unshift(`Supply ${s.id} (${s.net}) hit its ${s.limitA} A current limit - voltage collapses to ${s.vActual.toFixed(2)} V`);

  // ---------- tracks: current, IR drop, heating (IPC-2221) ----------
  const netPinI = new Map<number, number>();
  for (const r of results) {
    const c = board.comps.find((q) => q.ref === r.ref)!;
    for (const p of board.pads) if (p.ref === r.ref && p.net >= 0) {
      const share = Math.abs(r.i) / Math.max(1, new Set(board.pads.filter((q) => q.ref === r.ref && q.net >= 0).map((q) => q.pin)).size / 2);
      netPinI.set(p.net, Math.max(netPinI.get(p.net) ?? 0, Math.abs(r.i), share));
    }
    void c;
  }
  for (const s of sres) netPinI.set(nets.findIndex((q) => q.name === s.net), Math.max(netPinI.get(nets.findIndex((q) => q.name === s.net)) ?? 0, Math.abs(s.iA)));
  const tRes: TrackResult[] = [];
  const RHO = 1.72e-8, T_CU = 35e-6;
  for (const t of board.tracks) {
    let len = 0;
    for (let i = 0; i + 1 < t.pts.length; i++) len += Math.hypot(t.pts[i + 1][0] - t.pts[i][0], t.pts[i + 1][1] - t.pts[i][1]);
    if (len < 0.2) continue;
    const I = netPinI.get(t.net) ?? 0;
    const inner = t.layer !== 0 && t.layer !== board.layers - 1;
    const areaMil2 = (t.width / 0.0254) * 1.378;
    const k = inner ? 0.024 : 0.048;
    const dT = I > 0 ? Math.pow(I / (k * Math.pow(areaMil2, 0.725)), 1 / 0.44) : 0;
    const R = (RHO * (len / 1000)) / ((t.width / 1000) * T_CU);
    const dropMv = I * R * 1000;
    const status: Status = dT > 100 ? 'failed' : dT > 45 ? 'overstress' : dT > 20 ? 'hot' : dT > 8 ? 'warm' : 'ok';
    const mid = t.pts[Math.floor(t.pts.length / 2)];
    tRes.push({ net: nets[t.net]?.name ?? '', layer: t.layer, width: t.width, lengthMm: len, iA: I, dT, dropMv, status, x: mid[0], y: mid[1] });
  }

  // ---------- board temperature field ----------
  const cell = 0.5;
  const nxh = Math.max(2, Math.ceil(board.width / cell)), nyh = Math.max(2, Math.ceil(board.height / cell));
  const q = new Float64Array(nxh * nyh); // W/m^2
  const cellArea = (cell / 1000) ** 2;
  let totalW = 0;
  for (const r of results) {
    const c = board.comps.find((x) => x.ref === r.ref)!;
    const P = Math.max(0, r.p);
    totalW += P;
    if (P <= 0) continue;
    const w = c.fp.body.w, h = c.fp.body.h, sw = c.rot % 180 ? h : w, sh = c.rot % 180 ? w : h;
    const i0 = Math.max(0, Math.floor((c.x - sw / 2) / cell)), i1 = Math.min(nxh - 1, Math.ceil((c.x + sw / 2) / cell));
    const j0 = Math.max(0, Math.floor((c.y - sh / 2) / cell)), j1 = Math.min(nyh - 1, Math.ceil((c.y + sh / 2) / cell));
    const cnt = Math.max(1, (i1 - i0 + 1) * (j1 - j0 + 1));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) q[j * nxh + i] += P / cnt / cellArea;
  }
  for (const t of tRes) {
    const P = t.iA * t.iA * ((RHO * (t.lengthMm / 1000)) / ((t.width / 1000) * T_CU));
    totalW += P;
    const i = Math.min(nxh - 1, Math.max(0, Math.floor(t.x / cell))), j = Math.min(nyh - 1, Math.max(0, Math.floor(t.y / cell)));
    q[j * nxh + i] += P / cellArea;
  }
  // effective in-plane conductance k*t [W/K]
  const nCuOuter = 2, nPlane = board.planes.length, nInner = Math.max(0, board.layers - 2 - nPlane);
  const ktCu = 385 * T_CU * (nCuOuter * 0.5 + nPlane * 0.9 + nInner * 0.5);
  const kt = ktCu + 0.3 * (board.settings.thickness / 1000);
  const hConv = 10 * 2; // W/m^2K, natural convection both faces
  const Tamb = input.ambientC;
  const T = new Float64Array(nxh * nyh).fill(Tamb);
  const dx2 = (cell / 1000) ** 2;
  const diag = (4 * kt) / dx2 + hConv;
  for (let it = 0; it < 600; it++) {
    let md = 0;
    for (let j = 0; j < nyh; j++) for (let i = 0; i < nxh; i++) {
      const idx = j * nxh + i;
      let sum = 0, cnt = 0;
      if (i > 0) { sum += T[idx - 1]; cnt++; } if (i < nxh - 1) { sum += T[idx + 1]; cnt++; }
      if (j > 0) { sum += T[idx - nxh]; cnt++; } if (j < nyh - 1) { sum += T[idx + nxh]; cnt++; }
      const dg = (cnt * kt) / dx2 + hConv;
      const nv = ((kt / dx2) * sum + q[idx] + hConv * Tamb) / dg;
      md = Math.max(md, Math.abs(nv - T[idx]));
      T[idx] = T[idx] + 1.6 * (nv - T[idx]); // SOR
    }
    if (md < 1e-4) break;
  }
  void diag;
  let tmax = -1e9, tmin = 1e9;
  for (let k = 0; k < T.length; k++) { tmax = Math.max(tmax, T[k]); tmin = Math.min(tmin, T[k]); }
  const fieldAt = (x: number, y: number) => T[Math.min(nyh - 1, Math.max(0, Math.floor(y / cell))) * nxh + Math.min(nxh - 1, Math.max(0, Math.floor(x / cell)))];
  const boardRise = (totalW) / (hConv * (board.width * board.height) * 1e-6);

  for (const r of results) {
    const theta = (r as CompResult & { theta?: number }).theta ?? 150;
    const bt = fieldAt(r.x, r.y);
    r.tempC = bt + Math.max(0, r.p) * theta * 0.7;
    const margin = r.maxTempC;
    const bumpT = (st: Status, msg: string) => { if (STATUS_RANK[st] > STATUS_RANK[r.status]) r.status = st; r.messages.push(msg); };
    if (r.tempC > margin * 1.25) bumpT('failed', `${r.tempC.toFixed(0)} °C is far above its ${margin} °C limit - it fails`);
    else if (r.tempC > margin) bumpT('overstress', `${r.tempC.toFixed(0)} °C exceeds the ${margin} °C maximum`);
    else if (r.tempC > margin * 0.85) bumpT('hot', `${r.tempC.toFixed(0)} °C is within 15% of the ${margin} °C limit`);
    else if (r.tempC > 60) bumpT('warm', `${r.tempC.toFixed(0)} °C - too hot to touch comfortably`);
    if (r.status === 'ok' && Math.abs(r.i) < 1e-9 && r.p < 1e-9 && r.vSupply < 0.1 && Math.abs(r.vAcross) < 0.01) r.status = 'off';
  }
  const netV: Record<string, number> = {};
  nets.forEach((x, i) => (netV[x.name] = S.V[i]));
  if (tmax > 130) events.push(`Board hot spot reaches ${tmax.toFixed(0)} °C - above typical FR-4 Tg (130-140 °C): delamination risk`);
  for (const s of sres) {
    const pr = s.pin ? connectorRating(board, s.pin) : undefined;
    if (pr !== undefined) { s.pinRatingA = pr; if (Math.abs(s.iA) > pr) events.push(`Source pin ${s.pin} carries ${Math.abs(s.iA).toFixed(2)} A - above its ${pr} A connector rating`); }
  }
  const worstTrack = new Map<string, TrackResult>();
  for (const t of tRes) if (STATUS_RANK[t.status] >= STATUS_RANK.overstress && t.dT > (worstTrack.get(t.net)?.dT ?? 0)) worstTrack.set(t.net, t);
  for (const t of worstTrack.values()) events.push(`Trace on ${t.net} (${t.width} mm) carrying up to ${t.iA.toFixed(2)} A would heat by ~${t.dT.toFixed(0)} °C${t.status === 'failed' ? ' and fuse' : ''}`);
  for (const r of results) if (STATUS_RANK[r.status] >= STATUS_RANK.failed) events.push(`${r.ref} ${r.status === 'burst' ? 'BURSTS' : 'FAILS'}: ${r.messages[0]}`);

  return {
    ok: true,
    netV, comps: results, tracks: tRes, sources: sres,
    heat: { nx: nxh, ny: nyh, cell, T: Float32Array.from(T), max: tmax, min: tmin },
    totalW, boardRiseC: boardRise, maxBoardC: tmax, events, cascadeRounds: rounds,
  };
}

function connectorRating(board: Board, pin: string): number | undefined {
  const ref = pin.split('.')[0];
  const c = board.comps.find((q) => q.ref === ref);
  if (!c) return undefined;
  const id = c.fp.id;
  if (/USB_C/.test(id)) return 3;
  if (/JST_PH/.test(id)) return 2;
  if (/JST_XH/.test(id)) return 3;
  if (/Terminal/.test(id)) return 10;
  if (/PinHeader/.test(id)) return 1;
  void getFootprint;
  return undefined;
}

export const STATUS_ICON: Record<Status, string> = { off: '·', ok: '✓', warm: '♨', hot: '🔥', overstress: '⚠', failed: '✖', burst: '💥' };
export const STATUS_COLOR: Record<Status, string> = { off: '#6e7681', ok: '#2ea043', warm: '#d29922', hot: '#f0883e', overstress: '#f85149', failed: '#da3633', burst: '#ff2d95' };
