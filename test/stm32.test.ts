import { it, expect } from 'vitest';
import { runPipeline } from '../src/pipeline';
import { runDrc } from '../src/drc';
import { DEFAULT_SETTINGS, type Design } from '../src/types';
import { writeFileSync, mkdirSync } from 'node:fs';
import { boardSvg } from './debugsvg';

const C = (ref: string, footprint: string, value: string, extra: Partial<Design['components'][0]> = {}) => ({ ref, footprint, value, description: '', manufacturer: '', mpn: '', lcsc: '', ...extra });

it('STM32F103 board (LQFP-48, 0.5mm pitch) routes cleanly', () => {
  const d: Design = {
    name: 'STM32 Blue', description: '', notes: [], board: { width: 0, height: 0, cornerRadius: 1 },
    components: [
      C('U1', 'LQFP-48', 'STM32F103C8T6', { mpn: 'STM32F103C8T6' }), C('U2', 'SOT-223', 'AMS1117-3.3'), C('J1', 'USB_C_16P', 'USB-C'),
      C('Y1', 'Crystal_SMD_3225', '8MHz'), C('C1', 'C_0603', '20pF'), C('C2', 'C_0603', '20pF'),
      C('C3', 'C_0603', '100nF'), C('C4', 'C_0603', '100nF'), C('C5', 'C_0603', '100nF'), C('C6', 'C_0603', '100nF'), C('C7', 'C_0603', '1uF'),
      C('C8', 'C_0805', '10uF'), C('C9', 'C_0805', '22uF'), C('R1', 'R_0603', '5.1k'), C('R2', 'R_0603', '5.1k'), C('R3', 'R_0603', '10k'),
      C('R4', 'R_0603', '1.5k'), C('R5', 'R_0603', '1k'), C('D1', 'LED_0603', 'green'), C('SW1', 'SW_SMD_5.1x5.1', 'RESET'),
      C('J2', 'PinHeader_1x04', 'SWD'), C('J3', 'PinHeader_1x10', 'GPIO'), C('R6', 'R_0603', '22'), C('R7', 'R_0603', '22'),
    ],
    nets: [
      { name: 'VBUS', pins: ['J1.VBUS', 'U2.VIN', 'C8.1'] },
      { name: 'GND', pins: ['J1.GND', 'J1.SHIELD', 'R1.2', 'R2.2', 'U2.GND', 'C8.2', 'C9.2', 'U1.8', 'U1.23', 'U1.35', 'U1.47', 'C1.2', 'C2.2', 'C3.2', 'C4.2', 'C5.2', 'C6.2', 'C7.2', 'SW1.2', 'J2.4', 'J3.10', 'D1.K', 'Y1.2', 'Y1.4', 'R3.2'] },
      { name: '3V3', pins: ['U2.VOUT', 'C9.1', 'U1.1', 'U1.9', 'U1.24', 'U1.36', 'U1.48', 'C3.1', 'C4.1', 'C5.1', 'C6.1', 'J2.1', 'R4.1', 'R5.1', 'J3.1'] },
      { name: 'CC1', pins: ['J1.CC1', 'R1.1'] }, { name: 'CC2', pins: ['J1.CC2', 'R2.1'] },
      { name: 'OSC_IN', pins: ['U1.5', 'Y1.1', 'C1.1'] }, { name: 'OSC_OUT', pins: ['U1.6', 'Y1.3', 'C2.1'] },
      { name: 'NRST', pins: ['U1.7', 'C7.1', 'SW1.1'] }, { name: 'BOOT0', pins: ['U1.44', 'R3.1'] },
      { name: 'USB_DP', pins: ['U1.33', 'R7.1'] }, { name: 'USB_DM', pins: ['U1.32', 'R6.1'] },
      { name: 'DP', pins: ['R7.2', 'J1.D+', 'R4.2'] }, { name: 'DM', pins: ['R6.2', 'J1.D-'] },
      { name: 'SWDIO', pins: ['U1.34', 'J2.2'] }, { name: 'SWCLK', pins: ['U1.37', 'J2.3'] },
      { name: 'LED', pins: ['U1.2', 'R5.2'] }, { name: 'LED_K', pins: ['D1.A', 'R5.2'] },
      ...[10, 11, 12, 13, 14, 15, 16, 17].map((pin, i) => ({ name: `PA${i}`, pins: [`U1.${pin}`, `J3.${i + 2}`] })),
    ],
  };
  const t0 = Date.now();
  const b = runPipeline(d, DEFAULT_SETTINGS);
  const issues = runDrc(b).filter((x) => x.kind !== 'warning');
  console.log(`STM32: ${b.width}x${b.height} in ${Date.now() - t0} ms; ${b.routeLog.join(' | ')}`, issues.slice(0, 5).map((i) => i.msg));
  { const n = b.nets.findIndex((x) => x.name === 'DP'); console.log('DPPADS', b.pads.filter((p) => p.net === n).map((p) => `${p.ref}.${p.pin}@${p.x.toFixed(2)},${p.y.toFixed(2)} ${p.w}x${p.h}`).join(' ; ')); console.log('DPTRK', JSON.stringify(b.tracks.filter((t) => t.net === n).map((t) => [t.layer, t.width, t.pts])), JSON.stringify(b.vias.filter((v) => v.net === n))); }
  mkdirSync('test/out/stm32', { recursive: true });
  writeFileSync('test/out/stm32/debug.svg', boardSvg(b));
  expect(b.warnings.filter((w) => !/only one pin|merged/.test(w))).toEqual([]);
  expect(issues).toEqual([]);
}, 120_000);
