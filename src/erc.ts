// Electrical rule check on the logical design: catches the mistakes AI-made schematics typically contain.
// Used by the 3-pass AI review and by the offline auto-fixer.
import { resolvePin } from './footprints';
import { prepare } from './layout';
import type { Design } from './types';

export interface ErcIssue { severity: 'error' | 'warn'; msg: string; ref?: string; fixable?: boolean }

const isIc = (fpId: string, kind: string) => kind === 'ic' || kind === 'qfp' || kind === 'module' || kind === 'dip' || kind === 'qfn' || (kind === 'sot' && /^U/.test(fpId)) || /SOIC|TSSOP|SSOP|MSOP|LQFP|QFN|DFN|DIP|ESP32|ESP-12|WS2812|Pico/.test(fpId);

export function runErc(design: Design): ErcIssue[] {
  const issues: ErcIssue[] = [];
  const prep = prepare(design);
  for (const w of prep.warnings) issues.push({ severity: /unknown footprint|has no pin|bad pin|unknown component/.test(w) ? 'error' : 'warn', msg: w });
  const fpOf = new Map(prep.comps.map((c) => [c.comp.ref, c.fp]));
  const netOf = (ref: string, pin: string) => {
    const fp = fpOf.get(ref);
    const id = fp ? resolvePin(fp, pin) ?? pin : pin;
    return prep.pinNet.get(`${ref}.${id}`);
  };
  const gnd = prep.nets.findIndex((n) => n.isGround);
  if (gnd < 0) issues.push({ severity: 'error', msg: 'No ground net (name it "GND").' });

  // pins on each net per component
  const compNets = new Map<string, Set<number>>();
  for (const [k, n] of prep.pinNet) {
    const ref = k.slice(0, k.indexOf('.'));
    const set = compNets.get(ref) ?? new Set<number>();
    set.add(n);
    compNets.set(ref, set);
  }
  const caps = prep.comps.filter((c) => /^C/.test(c.comp.ref) && c.fp.pinCount === 2);
  const capsOnNet = (n: number) => caps.filter((c) => {
    const a = netOf(c.comp.ref, '1'), b = netOf(c.comp.ref, '2');
    return (a === n && b === gnd) || (b === n && a === gnd);
  }).length;

  for (const { comp, fp } of prep.comps) {
    const kind = fp.body.kind;
    if (kind === 'hole') continue;
    const ids = [...new Set(fp.pads.filter((p) => p.type !== 'npth').map((p) => p.pin))];
    const connected = ids.filter((id) => netOf(comp.ref, id) !== undefined);
    if (connected.length === 0) { issues.push({ severity: 'error', msg: `${comp.ref} (${fp.id}) is not connected to anything.`, ref: comp.ref }); continue; }
    if (fp.pinCount <= 3 && !fp.pads.some((p) => p.pin === 'SHIELD')) {
      const missing = ids.filter((id) => netOf(comp.ref, id) === undefined);
      if (missing.length) issues.push({ severity: 'error', msg: `${comp.ref} has unconnected pin(s): ${missing.join(', ')}.`, ref: comp.ref });
    }
    // decoupling: every IC power net needs a capacitor to ground
    if (isIc(fp.id, kind) && gnd >= 0) {
      const nets = [...(compNets.get(comp.ref) ?? [])].filter((n) => prep.nets[n].isPower);
      for (const n of nets) {
        if (capsOnNet(n) === 0) issues.push({ severity: 'warn', msg: `${comp.ref} is powered from ${prep.nets[n].name} but no capacitor connects that net to GND (add 100nF decoupling).`, ref: comp.ref, fixable: true });
      }
      if (nets.length === 0) issues.push({ severity: 'warn', msg: `${comp.ref} has no recognisable power net (VCC/3V3/5V/VBUS...).`, ref: comp.ref });
    }
    // LEDs need a series resistor
    if (/^LED_/.test(fp.id)) {
      const a = netOf(comp.ref, 'A');
      const hasR = a !== undefined && prep.comps.some((c) => /^R/.test(c.comp.ref) && (netOf(c.comp.ref, '1') === a || netOf(c.comp.ref, '2') === a));
      const k = netOf(comp.ref, 'K');
      const hasRk = k !== undefined && prep.comps.some((c) => /^R/.test(c.comp.ref) && (netOf(c.comp.ref, '1') === k || netOf(c.comp.ref, '2') === k));
      if (!hasR && !hasRk) issues.push({ severity: 'error', msg: `${comp.ref} (LED) has no series resistor on either side - it will burn out.`, ref: comp.ref });
    }
    // USB-C sink needs 5.1k pull-downs on CC1/CC2
    if (fp.id === 'USB_C_16P') {
      for (const cc of ['CC1', 'CC2']) {
        const n = netOf(comp.ref, cc);
        const ok = n !== undefined && prep.comps.some((c) => /^R/.test(c.comp.ref) && ((netOf(c.comp.ref, '1') === n && netOf(c.comp.ref, '2') === gnd) || (netOf(c.comp.ref, '2') === n && netOf(c.comp.ref, '1') === gnd)));
        if (!ok) issues.push({ severity: 'error', msg: `${comp.ref}.${cc} needs a 5.1k resistor to GND, otherwise USB-C hosts supply no power.`, ref: comp.ref });
      }
      if (netOf(comp.ref, 'GND') === undefined) issues.push({ severity: 'error', msg: `${comp.ref} GND pin is not connected.`, ref: comp.ref });
    }
  }
  // dangling nets
  const pinCount = new Map<number, number>();
  for (const n of prep.pinNet.values()) pinCount.set(n, (pinCount.get(n) ?? 0) + 1);
  prep.nets.forEach((n, i) => { if ((pinCount.get(i) ?? 0) < 2) issues.push({ severity: 'warn', msg: `Net ${n.name} has a single pin (floating).` }); });
  // short between supply nets via the same net name collisions is handled by prepare(); power-to-ground short:
  for (const n of prep.nets) if (n.isGround && n.isPower) issues.push({ severity: 'error', msg: `Net ${n.name} is both ground and power.` });
  return issues;
}

/** Deterministic fixes used when no API key is available (and as a safety net after AI edits). */
export function autoFixErc(design: Design): { design: Design; fixes: string[] } {
  const d: Design = JSON.parse(JSON.stringify(design));
  const fixes: string[] = [];
  for (let guard = 0; guard < 12; guard++) {
    const issue = runErc(d).find((i) => i.fixable && i.ref);
    if (!issue) break;
    const m = issue.msg.match(/powered from (\S+)/);
    if (!m) break;
    let n = 1;
    while (d.components.some((c) => c.ref === `C${900 + n}`)) n++;
    const ref = `C${900 + n}`;
    d.components.push({ ref, footprint: 'C_0603', value: '100nF', description: `Decoupling for ${issue.ref}`, manufacturer: '', mpn: '', lcsc: 'C14663' });
    const addPin = (net: string, pin: string) => { const x = d.nets.find((q) => q.name === net); if (x) x.pins.push(pin); else d.nets.push({ name: net, pins: [pin] }); };
    addPin(m[1], `${ref}.1`);
    addPin('GND', `${ref}.2`);
    fixes.push(`Added ${ref} (100nF) decoupling on ${m[1]} for ${issue.ref}`);
  }
  return { design: d, fixes };
}
