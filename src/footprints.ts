// Footprint library. Pad geometry follows KiCad / IPC-7351 nominal land patterns, with the
// footprint origin at the body centre and the same visual orientation as KiCad (pin 1 top-left
// for ICs), converted to a +Y-up frame. This keeps JLCPCB rotation corrections valid.
import type { FootprintDef, PadDef, BodyKind, CustomFootprintSpec } from './types';
import { KICAD_FOOTPRINTS } from './footprints_kicad';

const fps: FootprintDef[] = [];
const add = (f: Omit<FootprintDef, 'pinCount'>) => {
  const pins = new Set(f.pads.filter((p) => p.type !== 'npth').map((p) => p.pin));
  fps.push({ ...f, pinCount: pins.size });
};

const smd = (pin: string, x: number, y: number, w: number, h: number, shape: PadDef['shape'] = 'rect'): PadDef => ({
  pin, x, y, w, h, shape, type: 'smd',
});
const tht = (pin: string, x: number, y: number, w: number, h: number, drill: number, shape: PadDef['shape'] = 'circle'): PadDef => ({
  pin, x, y, w, h, shape, type: 'tht', drill,
});

// ---- 2-terminal chips ----
function chip(id: string, desc: string, dx: number, pw: number, ph: number, bw: number, bh: number, bz: number, kind: BodyKind, color?: number, aliases?: Record<string, string>) {
  add({
    id, description: desc, mount: 'smd',
    pads: [smd('1', -dx, 0, pw, ph), smd('2', dx, 0, pw, ph)],
    body: { w: bw, h: bh, z: bz, kind, color },
    courtyard: { w: 2 * dx + pw + 0.5, h: Math.max(ph, bh) + 0.5 },
    aliases,
  });
}
const sizes: [string, number, number, number, number, number][] = [
  // name, dx, padW, padH, bodyW, bodyH
  ['0402', 0.51, 0.54, 0.64, 1.0, 0.5],
  ['0603', 0.825, 0.8, 0.95, 1.6, 0.8],
  ['0805', 0.9125, 1.025, 1.4, 2.0, 1.25],
  ['1206', 1.4625, 1.125, 1.75, 3.2, 1.6],
];
for (const [n, dx, pw, ph, bw, bh] of sizes) {
  chip(`R_${n}`, `Resistor ${n} SMD. Pins 1,2.`, dx, pw, ph, bw, bh, 0.45, 'chip', 0x1a1a1a);
  chip(`C_${n}`, `Ceramic capacitor ${n} SMD. Pins 1,2.`, dx, pw, ph, bw, bh, n === '0402' ? 0.5 : 0.8, 'chip', 0xb08850);
}
chip('L_0805', 'Inductor / ferrite bead 0805. Pins 1,2.', 0.9125, 1.025, 1.4, 2.0, 1.25, 0.8, 'chip', 0x333333);
chip('L_1210', 'Power inductor 1210. Pins 1,2.', 1.5, 1.15, 2.7, 3.2, 2.5, 1.6, 'chip', 0x333333);
chip('F_1206', 'Fuse / PTC 1206. Pins 1,2.', 1.4625, 1.125, 1.75, 3.2, 1.6, 0.8, 'chip', 0x2c6e2c);
for (const n of ['0603', '0805']) {
  const s = sizes.find((x) => x[0] === n)!;
  chip(`LED_${n}`, `LED ${n} SMD. Pin 1 = K (cathode), pin 2 = A (anode). Aliases K, A.`, s[1], s[2], s[3], s[4], s[5], 0.6, 'led', 0xff3030, { K: '1', A: '2' });
}
chip('D_SOD-123', 'Diode SOD-123 (1N4148W, Schottky B5819W, Zener). Pin 1 = K (cathode), pin 2 = A. Aliases K, A.', 1.65, 0.9, 1.2, 2.7, 1.6, 1.1, 'diode', 0x111111, { K: '1', A: '2' });
chip('D_SMA', 'Diode SMA/DO-214AC (SS34, M7, SMAJ TVS). Pin 1 = K (cathode), pin 2 = A. Aliases K, A.', 2.0, 2.5, 1.7, 4.4, 2.6, 2.2, 'diode', 0x111111, { K: '1', A: '2' });

// ---- SOT packages ----
add({
  id: 'SOT-23', mount: 'smd', jlcRotation: 180,
  description: 'SOT-23-3. Pins 1,2 on one side, 3 opposite. MOSFET (AO3400/2N7002): 1=G, 2=S, 3=D. BJT (MMBT3904): 1=B, 2=E, 3=C. LDO/regulator pinouts vary - follow datasheet.',
  pads: [smd('1', -1.1, 0.95, 1.325, 0.6), smd('2', -1.1, -0.95, 1.325, 0.6), smd('3', 1.1, 0, 1.325, 0.6)],
  body: { w: 1.4, h: 3.0, z: 1.1, kind: 'sot' },
  courtyard: { w: 3.9, h: 3.6 },
  aliases: { G: '1', S: '2', D: '3', B: '1', E: '2', C: '3' },
});
for (const n of [5, 6]) {
  const pads: PadDef[] = [];
  const left = n === 5 ? [0.95, 0, -0.95] : [0.95, 0, -0.95];
  left.forEach((y, i) => pads.push(smd(String(i + 1), -1.1375, y, 1.325, 0.6)));
  const right = n === 5 ? [-0.95, 0.95] : [-0.95, 0, 0.95];
  right.forEach((y, i) => pads.push(smd(String(4 + i), 1.1375, y, 1.325, 0.6)));
  add({
    id: `SOT-23-${n}`, mount: 'smd', jlcRotation: 180,
    description: n === 5
      ? 'SOT-23-5. Pins 1-3 left side top-to-bottom, 4-5 right side bottom-to-top. AP2112K-3.3 LDO: 1=VIN 2=GND 3=EN 4=NC 5=VOUT.'
      : 'SOT-23-6. Pins 1-3 left side top-to-bottom, 4-6 right side bottom-to-top. USBLC6-2SC6 ESD: 1=IO1 2=GND 3=IO2 4=IO2 5=VBUS 6=IO1.',
    pads, body: { w: 1.6, h: 3.0, z: 1.1, kind: 'sot' }, courtyard: { w: 4.0, h: 3.6 },
  });
}
add({
  id: 'SOT-223', mount: 'smd', jlcRotation: 180,
  description: 'SOT-223 regulator. Pins 1,2,3 plus large tab which is ALSO pin 2. AMS1117-x.x: 1=GND/ADJ, 2=VOUT (and tab), 3=VIN.',
  pads: [smd('1', -3.15, 2.3, 2.0, 1.5), smd('2', -3.15, 0, 2.0, 1.5), smd('3', -3.15, -2.3, 2.0, 1.5), smd('2', 3.15, 0, 2.0, 3.8)],
  body: { w: 3.5, h: 6.5, z: 1.8, kind: 'sot' },
  courtyard: { w: 8.8, h: 7.2 },
  aliases: { GND: '1', ADJ: '1', VOUT: '2', VIN: '3' },
  bridgedPins: ['2'],
});

// ---- Dual row SMD ICs ----
function dualRow(id: string, n: number, pitch: number, dx: number, pw: number, ph: number, bw: number, bh: number, desc: string, jlc = 270) {
  const half = n / 2;
  const pads: PadDef[] = [];
  const y0 = ((half - 1) * pitch) / 2;
  for (let i = 0; i < half; i++) pads.push(smd(String(i + 1), -dx, y0 - i * pitch, pw, ph));
  for (let i = 0; i < half; i++) pads.push(smd(String(half + i + 1), dx, -y0 + i * pitch, pw, ph));
  add({
    id, mount: 'smd', jlcRotation: jlc, description: desc, pads,
    body: { w: bw, h: bh, z: 1.5, kind: 'ic' },
    courtyard: { w: 2 * dx + pw + 0.5, h: Math.max(bh, 2 * y0 + ph) + 0.5 },
  });
}
dualRow('SOIC-8', 8, 1.27, 2.475, 1.95, 0.6, 3.9, 4.9, 'SOIC-8 (NE555, op-amps LM358, EEPROM, MOSFET drivers). Pins 1-4 left top-to-bottom, 5-8 right bottom-to-top. NE555: 1=GND 2=TRIG 3=OUT 4=RESET 5=CTRL 6=THR 7=DIS 8=VCC.');
dualRow('SOIC-14', 14, 1.27, 2.475, 1.95, 0.6, 3.9, 8.65, 'SOIC-14 (74HC logic, LM324). Pins 1-7 left, 8-14 right (counter-clockwise).');
dualRow('SOIC-16', 16, 1.27, 2.475, 1.95, 0.6, 3.9, 9.9, 'SOIC-16 (CH340C USB-UART, 74HC595). CH340C: 1=GND 2=TXD 3=RXD 4=V3 5=UD+ 6=UD- 7..14 modem/NC (9=CTS 10=DSR 11=RI 12=DCD 13=DTR 14=RTS) 15=R232 16=VCC.');
dualRow('TSSOP-20', 20, 0.65, 2.8625, 1.475, 0.4, 4.4, 6.5, 'TSSOP-20 (STM32F030F4, CH340G alt). Pins 1-10 left, 11-20 right (counter-clockwise).');

// ---- Quad flat packs ----
function qfp(id: string, n: number, pitch: number, d: number, pw: number, ph: number, body: number, desc: string) {
  const per = n / 4;
  const pads: PadDef[] = [];
  const s0 = ((per - 1) * pitch) / 2;
  for (let i = 0; i < per; i++) pads.push(smd(String(i + 1), -d, s0 - i * pitch, pw, ph)); // left, top->bottom
  for (let i = 0; i < per; i++) pads.push(smd(String(per + i + 1), -s0 + i * pitch, -d, ph, pw)); // bottom, left->right
  for (let i = 0; i < per; i++) pads.push(smd(String(2 * per + i + 1), d, -s0 + i * pitch, pw, ph)); // right, bottom->top
  for (let i = 0; i < per; i++) pads.push(smd(String(3 * per + i + 1), s0 - i * pitch, d, ph, pw)); // top, right->left
  add({
    id, mount: 'smd', jlcRotation: 270, description: desc, pads,
    body: { w: body, h: body, z: 1.4, kind: 'qfp' },
    courtyard: { w: 2 * d + pw + 0.6, h: 2 * d + pw + 0.6 },
  });
}
qfp('LQFP-32', 32, 0.8, 4.1625, 1.475, 0.55, 7, 'LQFP-32 7x7 0.8mm (ATmega328P-AU). Pin 1 top-left, counter-clockwise. ATmega328P-AU: 1=PD3 2=PD4 3=GND 4=VCC 5=GND 6=VCC 7=PB6/XTAL1 8=PB7/XTAL2 9=PD5 10=PD6 11=PD7 12=PB0 13=PB1 14=PB2 15=PB3/MOSI 16=PB4/MISO 17=PB5/SCK 18=AVCC 19=ADC6 20=AREF 21=GND 22=ADC7 23=PC0 24=PC1 25=PC2 26=PC3 27=PC4/SDA 28=PC5/SCL 29=PC6/RESET 30=PD0/RXD 31=PD1/TXD 32=PD2.');
qfp('LQFP-48', 48, 0.5, 4.1625, 1.475, 0.3, 7, 'LQFP-48 7x7 0.5mm (STM32F103C8T6, STM32F401). Pin 1 top-left, counter-clockwise. STM32F103C8: 1=VBAT 5=OSC_IN 6=OSC_OUT 7=NRST 8=VSSA 9=VDDA 10..17=PA0..PA7 18=PB0 19=PB1 20=PB2/BOOT1 21=PB10 22=PB11 23=VSS 24=VDD 25..28=PB12..PB15 29..32=PA8..PA11 33=PA12 34=PA13/SWDIO 35=VSS 36=VDD 37=PA14/SWCLK 38=PA15 39..43=PB3..PB7 44=BOOT0 45=PB8 46=PB9 47=VSS 48=VDD.');

// ---- Through-hole ----
function dip(n: number) {
  const half = n / 2;
  const pads: PadDef[] = [];
  const y0 = ((half - 1) * 2.54) / 2;
  for (let i = 0; i < half; i++) pads.push(tht(String(i + 1), -3.81, y0 - i * 2.54, 1.6, 1.6, 0.8, i === 0 ? 'rect' : 'oval'));
  for (let i = 0; i < half; i++) pads.push(tht(String(half + i + 1), 3.81, -y0 + i * 2.54, 1.6, 1.6, 0.8, 'oval'));
  add({
    id: `DIP-${n}`, mount: 'tht', pads,
    description: `DIP-${n} through-hole IC, 300mil. Pins 1-${half} left top-to-bottom, ${half + 1}-${n} right bottom-to-top.`,
    body: { w: 6.35, h: half * 2.54 + 0.3, z: 3.3, kind: 'dip' },
    courtyard: { w: 9.6, h: half * 2.54 + 0.8 },
  });
}
[8, 14, 16].forEach(dip);

for (let n = 1; n <= 20; n++) {
  const pads: PadDef[] = [];
  const y0 = ((n - 1) * 2.54) / 2;
  for (let i = 0; i < n; i++) pads.push(tht(String(i + 1), 0, y0 - i * 2.54, 1.7, 1.7, 1.0, i === 0 ? 'rect' : 'oval'));
  add({
    id: `PinHeader_1x${String(n).padStart(2, '0')}`, mount: 'tht', pads,
    description: `Male pin header 1x${n}, 2.54mm pitch. Pins 1..${n}.`,
    body: { w: 2.54, h: n * 2.54, z: 2.5, kind: 'header' },
    courtyard: { w: 3.0, h: n * 2.54 + 0.5 },
  });
}
for (let n = 2; n <= 20; n++) {
  const pads: PadDef[] = [];
  const y0 = ((n - 1) * 2.54) / 2;
  for (let i = 0; i < n; i++) {
    pads.push(tht(String(2 * i + 1), -1.27, y0 - i * 2.54, 1.7, 1.7, 1.0, i === 0 ? 'rect' : 'oval'));
    pads.push(tht(String(2 * i + 2), 1.27, y0 - i * 2.54, 1.7, 1.7, 1.0, 'oval'));
  }
  add({
    id: `PinHeader_2x${String(n).padStart(2, '0')}`, mount: 'tht', pads,
    description: `Male pin header 2x${n}, 2.54mm. Odd pins left column, even right; pin 1 top-left (2x03 = AVR ISP: 1=MISO 2=VCC 3=SCK 4=MOSI 5=RESET 6=GND).`,
    body: { w: 5.08, h: n * 2.54, z: 2.5, kind: 'header' },
    courtyard: { w: 5.6, h: n * 2.54 + 0.5 },
  });
}
for (let n = 2; n <= 6; n++) {
  const pads: PadDef[] = [];
  const x0 = ((n - 1) * 2.0) / 2;
  for (let i = 0; i < n; i++) pads.push(tht(String(i + 1), -x0 + i * 2.0, 0, 1.2, 1.75, 0.75, i === 0 ? 'rect' : 'oval'));
  add({
    id: `JST_PH_${n}`, mount: 'tht', edge: 'top', pads,
    description: `JST PH 2.0mm vertical connector, ${n} pins (B${n}B-PH-K). For LiPo batteries: pin 1 = +, pin 2 = -.`,
    body: { w: (n - 1) * 2 + 3.9, h: 4.5, z: 6.0, kind: 'jst' },
    courtyard: { w: (n - 1) * 2 + 4.4, h: 5.0, cy: 0.8 },
  });
}
for (let n = 2; n <= 4; n++) {
  const pads: PadDef[] = [];
  const x0 = ((n - 1) * 2.5) / 2;
  for (let i = 0; i < n; i++) pads.push(tht(String(i + 1), -x0 + i * 2.5, 0, 1.7, 2.0, 0.95, i === 0 ? 'rect' : 'oval'));
  add({
    id: `JST_XH_${n}`, mount: 'tht', edge: 'top', pads,
    description: `JST XH 2.5mm vertical connector, ${n} pins (B${n}B-XH-A).`,
    body: { w: (n - 1) * 2.5 + 4.9, h: 5.75, z: 7.0, kind: 'jst' },
    courtyard: { w: (n - 1) * 2.5 + 5.4, h: 6.3, cy: 0.6 },
  });
}
for (let n = 2; n <= 4; n++) {
  const pads: PadDef[] = [];
  const x0 = ((n - 1) * 5.08) / 2;
  for (let i = 0; i < n; i++) pads.push(tht(String(i + 1), -x0 + i * 5.08, 0, 2.6, 2.6, 1.3, i === 0 ? 'rect' : 'circle'));
  add({
    id: `TerminalBlock_5.08_${n}`, mount: 'tht', edge: 'top', pads,
    description: `Screw terminal block 5.08mm, ${n} positions. Pins 1..${n}. Wire entry faces board edge.`,
    body: { w: n * 5.08, h: 8.0, z: 10, kind: 'terminal', color: 0x2e8b57 },
    courtyard: { w: n * 5.08 + 0.6, h: 8.6, cy: 0.5 },
  });
}
add({
  id: 'SW_Tactile_6x6', mount: 'tht',
  description: '6x6mm tactile push button THT. Pin 1 (two legs, connected) and pin 2 (two legs). Pressing connects 1-2.',
  pads: [tht('1', -3.25, 2.25, 2.0, 2.0, 1.1), tht('1', 3.25, 2.25, 2.0, 2.0, 1.1), tht('2', -3.25, -2.25, 2.0, 2.0, 1.1), tht('2', 3.25, -2.25, 2.0, 2.0, 1.1)],
  body: { w: 6.0, h: 6.0, z: 5.0, kind: 'tactile' },
  courtyard: { w: 8.8, h: 7.0 },
  bridgedPins: ['1', '2'],
});
add({
  id: 'SW_SMD_5.1x5.1', mount: 'smd',
  description: 'SMD tactile switch 5.1x5.1mm 4-pad (TS-1187A). Pins 1,1 connected; pins 2,2 connected. Pressing connects 1-2.',
  pads: [smd('1', -3.0, 1.85, 1.0, 0.75), smd('1', 3.0, 1.85, 1.0, 0.75), smd('2', -3.0, -1.85, 1.0, 0.75), smd('2', 3.0, -1.85, 1.0, 0.75)],
  body: { w: 5.1, h: 5.1, z: 1.5, kind: 'tactile' },
  courtyard: { w: 7.4, h: 5.8 },
  bridgedPins: ['1', '2'],
});
add({
  id: 'Crystal_HC49-US', mount: 'tht',
  description: 'Quartz crystal HC-49/US THT. Pins 1,2 (non-polar). Needs two load caps (e.g. 22pF) to GND.',
  pads: [tht('1', -2.44, 0, 1.5, 1.5, 0.8), tht('2', 2.44, 0, 1.5, 1.5, 0.8)],
  body: { w: 11.0, h: 4.65, z: 3.5, kind: 'crystal' },
  courtyard: { w: 11.6, h: 5.2 },
});
add({
  id: 'Crystal_SMD_3225', mount: 'smd',
  description: 'SMD crystal 3.2x2.5mm 4-pad. Pins 1 and 3 are the crystal; pins 2 and 4 are case GND.',
  pads: [smd('1', -1.1, -0.8, 1.4, 1.15), smd('2', 1.1, -0.8, 1.4, 1.15), smd('3', 1.1, 0.8, 1.4, 1.15), smd('4', -1.1, 0.8, 1.4, 1.15)],
  body: { w: 3.2, h: 2.5, z: 0.8, kind: 'crystal_smd' },
  courtyard: { w: 4.2, h: 3.4 },
});
add({
  id: 'CP_Radial_D5.0', mount: 'tht',
  description: 'Electrolytic capacitor radial 5mm diameter, 2mm pitch THT. Pin 1 = + , pin 2 = -.',
  pads: [tht('1', -1.0, 0, 1.6, 1.6, 0.8, 'rect'), tht('2', 1.0, 0, 1.6, 1.6, 0.8)],
  body: { w: 5.0, h: 5.0, z: 11, kind: 'cap_elec' },
  courtyard: { w: 5.6, h: 5.6 },
  aliases: { '+': '1', '-': '2' },
});
add({
  id: 'CP_Elec_6.3x5.8', mount: 'smd',
  description: 'SMD aluminium electrolytic capacitor 6.3x5.8mm. Pin 1 = +, pin 2 = -.',
  pads: [smd('1', -2.7, 0, 3.3, 1.6), smd('2', 2.7, 0, 3.3, 1.6)],
  body: { w: 6.6, h: 6.6, z: 5.8, kind: 'cap_smd_elec' },
  courtyard: { w: 9.0, h: 7.2 },
  aliases: { '+': '1', '-': '2' },
});
add({
  id: 'TO-220-3_Vertical', mount: 'tht',
  description: 'TO-220 vertical THT (LM7805: 1=IN 2=GND 3=OUT; IRLZ44N MOSFET: 1=G 2=D 3=S).',
  pads: [tht('1', -2.54, 0, 1.9, 2.0, 1.1, 'rect'), tht('2', 0, 0, 1.9, 2.0, 1.1, 'oval'), tht('3', 2.54, 0, 1.9, 2.0, 1.1, 'oval')],
  body: { w: 10.0, h: 4.5, z: 15, kind: 'to220' },
  courtyard: { w: 10.6, h: 5.0, cy: 0.6 },
});
add({
  id: 'MountingHole_3.2mm_M3', mount: 'tht',
  description: 'M3 mounting hole (non-plated, 3.2mm). No pins. Place 4 of these for corners.',
  pads: [{ pin: 'H', x: 0, y: 0, w: 3.2, h: 3.2, shape: 'circle', type: 'npth', drill: 3.2 }],
  body: { w: 3.2, h: 3.2, z: 0, kind: 'hole' },
  courtyard: { w: 6.4, h: 6.4 },
});

// ---- USB-C (HRO TYPE-C-31-M-12, LCSC C165948) ----
{
  const y = 4.045;
  const sig: [string, number, number][] = [
    ['GND', -3.25, 0.6], ['VBUS', -2.45, 0.6], ['SBU2', -1.75, 0.3], ['CC1', -1.25, 0.3], ['D-', -0.75, 0.3], ['D+', -0.25, 0.3],
    ['D-', 0.25, 0.3], ['D+', 0.75, 0.3], ['SBU1', 1.25, 0.3], ['CC2', 1.75, 0.3], ['VBUS', 2.45, 0.6], ['GND', 3.25, 0.6],
  ];
  const pads: PadDef[] = sig.map(([p, x, w]) => smd(p, x, y, w, 1.45));
  for (const sx of [-4.32, 4.32]) {
    pads.push({ pin: 'SHIELD', x: sx, y: 3.105, w: 1.0, h: 2.1, shape: 'oval', type: 'tht', slot: { w: 0.6, h: 1.7 } });
    pads.push({ pin: 'SHIELD', x: sx, y: -1.075, w: 1.0, h: 1.6, shape: 'oval', type: 'tht', slot: { w: 0.6, h: 1.2 } });
  }
  pads.push({ pin: 'NP', x: -2.89, y: 2.605, w: 0.65, h: 0.65, shape: 'circle', type: 'npth', drill: 0.65 });
  pads.push({ pin: 'NP', x: 2.89, y: 2.605, w: 0.65, h: 0.65, shape: 'circle', type: 'npth', drill: 0.65 });
  add({
    id: 'USB_C_16P', mount: 'smd', edge: 'bottom', jlcRotation: 0,
    description: 'USB Type-C receptacle 16-pin (USB 2.0), HRO TYPE-C-31-M-12 (LCSC C165948). Pin names: GND, VBUS, CC1, CC2, D+, D-, SBU1, SBU2, SHIELD. For a 5V sink: CC1 and CC2 each need their own 5.1k resistor to GND. Connect SHIELD to GND.',
    pads,
    body: { w: 8.94, h: 7.3, z: 3.2, kind: 'usbc' },
    courtyard: { w: 10.0, h: 9.4, cy: 0.5 },
    bridgedPins: ['SHIELD'],
  });
}

// ---- ESP32-WROOM-32 module ----
{
  const names = ['GND', '3V3', 'EN', 'SENSOR_VP', 'SENSOR_VN', 'IO34', 'IO35', 'IO32', 'IO33', 'IO25', 'IO26', 'IO27', 'IO14', 'IO12',
    'GND', 'IO13', 'SD2', 'SD3', 'CMD', 'CLK', 'SD0', 'SD1', 'IO15', 'IO2',
    'IO0', 'IO4', 'IO16', 'IO17', 'IO5', 'IO18', 'IO19', 'NC', 'IO21', 'RXD0', 'TXD0', 'IO22', 'IO23', 'GND'];
  const pads: PadDef[] = [];
  const pid = (i: number) => (names[i] === 'GND' ? 'GND' : String(i + 1));
  for (let i = 0; i < 14; i++) pads.push(smd(pid(i), -8.75, 5.26 - i * 1.27, 1.5, 0.9));
  for (let i = 0; i < 10; i++) pads.push(smd(pid(14 + i), -5.715 + i * 1.27, -12.5, 0.9, 1.5));
  for (let i = 0; i < 14; i++) pads.push(smd(pid(24 + i), 8.75, -11.25 + i * 1.27, 1.5, 0.9));
  pads.push(smd('GND', -1.0, -2.96, 5.0, 5.0));
  const aliases: Record<string, string> = {};
  names.forEach((n, i) => { if (n !== 'GND' && n !== 'NC') aliases[n] = String(i + 1); });
  for (const g of ['1', '15', '38', '39']) aliases[g] = 'GND';
  aliases.TX = '35'; aliases.RX = '34'; aliases.TXD = '35'; aliases.RXD = '34'; aliases.VCC = '2';
  add({
    id: 'ESP32-WROOM-32', mount: 'smd', edge: 'top',
    description: 'ESP32-WROOM-32E module (LCSC C701341). Pins by number 1-39 or by name: GND (pins 1/15/38/39 + exposed pad, all one pin named GND), 2=3V3, 3=EN, 4=SENSOR_VP, 5=SENSOR_VN, 6=IO34, 7=IO35, 8=IO32, 9=IO33, 10=IO25, 11=IO26, 12=IO27, 13=IO14, 14=IO12, 16=IO13, 23=IO15, 24=IO2, 25=IO0, 26=IO4, 27=IO16, 28=IO17, 29=IO5, 30=IO18, 31=IO19, 33=IO21, 34=RXD0, 35=TXD0, 36=IO22, 37=IO23. Pins 17-22 are internal flash, leave unconnected. Antenna end must face the board edge (handled automatically).',
    pads,
    body: { w: 18, h: 25.5, z: 3.1, kind: 'module' },
    courtyard: { w: 19.0, h: 26.5 },
    keepouts: [{ x0: -9, y0: 6.75, x1: 9, y1: 12.75 }],
    bridgedPins: ['GND'],
    aliases,
  });
}


// =====================================================================================
// Extended library. Nominal IPC-7351 / KiCad-style land patterns. Footprints flagged
// `approx` use typical datasheet dimensions - the app reminds the user to compare them
// with the exact part's datasheet before ordering.
// =====================================================================================
const approxIds = new Set<string>();
const approx = (...ids: string[]) => ids.forEach((i) => approxIds.add(i));

// ---- more chip sizes, inductors, fuses, LEDs ----
chip('R_1210', 'Resistor 1210 SMD. Pins 1,2.', 1.5, 1.2, 2.7, 3.2, 2.5, 0.55, 'chip', 0x1a1a1a);
chip('C_1210', 'Ceramic capacitor 1210 SMD. Pins 1,2.', 1.5, 1.2, 2.7, 3.2, 2.5, 1.5, 'chip', 0xb08850);
chip('R_2010', 'Resistor 2010 SMD (0.5-1 W). Pins 1,2.', 2.3, 1.4, 2.7, 5.0, 2.5, 0.6, 'chip', 0x1a1a1a);
chip('R_2512', 'Resistor 2512 SMD (1-2 W, current-sense shunt). Pins 1,2.', 2.95, 1.5, 3.35, 6.35, 3.2, 0.7, 'chip', 0x1a1a1a);
approx('R_2010', 'R_2512');
for (const n of ['0402', '0603', '1206']) {
  const s = sizes.find((x) => x[0] === n)!;
  chip(`L_${n}`, `Inductor / ferrite bead ${n}. Pins 1,2.`, s[1], s[2], s[3], s[4], s[5], 0.6, 'chip', 0x333333);
}
for (const n of ['0603', '0805']) {
  const s = sizes.find((x) => x[0] === n)!;
  chip(`F_${n}`, `Fuse / PTC ${n}. Pins 1,2.`, s[1], s[2], s[3], s[4], s[5], 0.6, 'chip', 0x2c6e2c);
}
chip('F_1812', 'Resettable fuse / PTC 1812. Pins 1,2.', 2.15, 1.7, 3.4, 4.5, 3.2, 1.0, 'chip', 0x2c6e2c);
chip('F_2920', 'Resettable fuse / PTC 2920 (up to ~3 A hold). Pins 1,2.', 3.6, 2.4, 5.4, 7.3, 5.0, 1.2, 'chip', 0x2c6e2c);
chip('L_SMD_4x4', 'Shielded power inductor 4x4mm (SRN4018, CD43). Pins 1,2.', 1.8, 1.4, 3.4, 4.0, 4.0, 1.8, 'chip', 0x333333);
chip('L_SMD_5x5', 'Shielded power inductor 5x5mm (SRN5040, CD54). Pins 1,2.', 2.2, 1.6, 4.4, 5.0, 5.0, 2.4, 'chip', 0x333333);
chip('L_SMD_6x6', 'Shielded power inductor 6x6mm (SRN6045, CD75). Pins 1,2.', 2.55, 1.9, 5.0, 6.0, 6.0, 3.0, 'chip', 0x333333);
chip('L_SMD_10x10', 'Power inductor 10x10mm (SRR1210, CDRH104R). Pins 1,2.', 4.5, 2.8, 8.4, 10.0, 10.0, 4.5, 'chip', 0x333333);
approx('F_1812', 'F_2920', 'L_SMD_4x4', 'L_SMD_5x5', 'L_SMD_6x6', 'L_SMD_10x10');
chip('LED_0402', 'LED 0402 SMD. Pin 1 = K (cathode), pin 2 = A (anode). Aliases K, A.', 0.51, 0.54, 0.64, 1.0, 0.5, 0.4, 'led', 0xff3030, { K: '1', A: '2' });
chip('LED_1206', 'LED 1206 SMD. Pin 1 = K (cathode), pin 2 = A (anode). Aliases K, A.', 1.4625, 1.125, 1.75, 3.2, 1.6, 0.8, 'led', 0xff3030, { K: '1', A: '2' });
chip('LED_PLCC2_3528', 'High-brightness LED PLCC-2 3.5x2.8mm. Pin 1 = K, pin 2 = A. Aliases K, A.', 1.5, 1.5, 2.2, 3.5, 2.8, 1.9, 'led', 0xff3030, { K: '1', A: '2' });
approx('LED_PLCC2_3528');
add({
  id: 'WS2812B_5050', mount: 'smd', approx: true,
  description: 'WS2812B / SK6812 addressable RGB LED 5x5mm. 1=VDD, 2=DOUT, 3=VSS(GND), 4=DIN. Aliases VDD, DOUT, VSS, GND, DIN. Add a 100nF cap per LED.',
  pads: [smd('1', 2.45, 1.6, 1.5, 1.0), smd('2', 2.45, -1.6, 1.5, 1.0), smd('3', -2.45, -1.6, 1.5, 1.0), smd('4', -2.45, 1.6, 1.5, 1.0)],
  body: { w: 5.0, h: 5.0, z: 1.6, kind: 'ic', color: 0xf2efe6 }, courtyard: { w: 6.9, h: 5.8 },
  aliases: { VDD: '1', DOUT: '2', VSS: '3', GND: '3', DIN: '4' },
});
for (const [d, drill, pad, z] of [[3, 0.9, 1.8, 4.5], [5, 1.0, 1.9, 8.6]] as const) {
  add({
    id: `LED_THT_${d}mm`, mount: 'tht',
    description: `LED ${d}mm through-hole, 2.54mm pitch. Pin 1 = K (cathode, flat side, square pad), pin 2 = A (anode, long leg). Aliases K, A.`,
    pads: [tht('1', -1.27, 0, pad, pad, drill, 'rect'), tht('2', 1.27, 0, pad, pad, drill)],
    body: { w: d, h: d, z, kind: 'led_tht' }, courtyard: { w: d + 3.4, h: d + 0.8 }, aliases: { K: '1', A: '2' },
  });
}

// ---- more diodes ----
chip('D_SOD-323', 'Diode SOD-323 (1N4148WS, BAT54WS, small Zener/Schottky). Pin 1 = K, pin 2 = A. Aliases K, A.', 1.1, 0.8, 0.8, 1.7, 1.25, 0.95, 'diode', 0x111111, { K: '1', A: '2' });
chip('D_SOD-523', 'Diode SOD-523 (tiny TVS/Zener/switching). Pin 1 = K, pin 2 = A. Aliases K, A.', 0.7, 0.6, 0.7, 1.2, 0.8, 0.6, 'diode', 0x111111, { K: '1', A: '2' });
chip('D_SOD-123F', 'Diode SOD-123F flat-lead power Schottky (SS14F, PMEG). Pin 1 = K, pin 2 = A. Aliases K, A.', 1.65, 0.9, 1.2, 2.7, 1.6, 1.0, 'diode', 0x111111, { K: '1', A: '2' });
chip('D_SMB', 'Diode SMB/DO-214AA (SS36, SMBJ TVS, 1N4007 SMD equivalent M7 is SMA). Pin 1 = K, pin 2 = A. Aliases K, A.', 2.15, 2.5, 2.3, 4.4, 3.6, 2.3, 'diode', 0x111111, { K: '1', A: '2' });
chip('D_SMC', 'Diode SMC/DO-214AB (SS56, SMCJ TVS, high-current). Pin 1 = K, pin 2 = A. Aliases K, A.', 3.4, 3.3, 2.8, 6.9, 5.9, 2.4, 'diode', 0x111111, { K: '1', A: '2' });
approx('D_SOD-523', 'D_SMB', 'D_SMC');
chip('CP_Tantalum_A', 'Tantalum capacitor case A (EIA 3216-18). Pin 1 = +, pin 2 = -.', 1.5, 1.8, 1.5, 3.2, 1.6, 1.6, 'diode', 0xd9a520, { '+': '1', '-': '2' });
chip('CP_Tantalum_B', 'Tantalum capacitor case B (EIA 3528-21). Pin 1 = +, pin 2 = -.', 1.6, 1.8, 2.2, 3.5, 2.8, 1.9, 'diode', 0xd9a520, { '+': '1', '-': '2' });
chip('CP_Tantalum_C', 'Tantalum capacitor case C (EIA 6032-28). Pin 1 = +, pin 2 = -.', 2.5, 2.2, 2.4, 6.0, 3.2, 2.5, 'diode', 0xd9a520, { '+': '1', '-': '2' });
chip('CP_Tantalum_D', 'Tantalum capacitor case D (EIA 7343-31). Pin 1 = +, pin 2 = -.', 3.2, 2.5, 2.6, 7.3, 4.3, 2.8, 'diode', 0xd9a520, { '+': '1', '-': '2' });
approx('CP_Tantalum_A', 'CP_Tantalum_B', 'CP_Tantalum_C', 'CP_Tantalum_D');
chip('ANT_Chip_3216', 'Chip antenna 2.4 GHz 3.2x1.6mm (2450AT). Pin 1 = feed, pin 2 = NC/GND. Keep copper and parts away from it; use a 50-ohm feed.', 1.35, 1.1, 1.8, 3.2, 1.6, 1.0, 'chip', 0xb8b0a0);
approx('ANT_Chip_3216');

// ---- through-hole axial parts ----
function axial(id: string, desc: string, pitch: number, padD: number, drill: number, bl: number, bd: number, color: number, aliases?: Record<string, string>) {
  add({
    id, description: desc, mount: 'tht', aliases,
    pads: [tht('1', -pitch / 2, 0, padD, padD, drill, 'rect'), tht('2', pitch / 2, 0, padD, padD, drill)],
    body: { w: bl, h: bd, z: bd, kind: 'axial', color }, courtyard: { w: pitch + padD + 0.6, h: Math.max(bd, padD) + 0.6 },
  });
}
axial('R_Axial_0207_P7.62', 'Axial resistor 1/4 W (DIN0207), 7.62mm pitch. Pins 1,2.', 7.62, 1.6, 0.8, 6.3, 2.5, 0x5b7fa6);
axial('R_Axial_0207_P10.16', 'Axial resistor 1/4 W (DIN0207), 10.16mm pitch. Pins 1,2.', 10.16, 1.6, 0.8, 6.3, 2.5, 0x5b7fa6);
axial('R_Axial_0309_P12.7', 'Axial resistor 1/2 W (DIN0309), 12.7mm pitch. Pins 1,2.', 12.7, 1.8, 0.9, 9.0, 3.2, 0x5b7fa6);
axial('R_Axial_0411_P15.24', 'Axial resistor 1 W (DIN0411), 15.24mm pitch. Pins 1,2.', 15.24, 2.0, 1.0, 9.9, 3.6, 0x5b7fa6);
axial('D_DO-35', 'Diode DO-35 axial (1N4148, small Zener). Pin 1 = K (band), pin 2 = A. Aliases K, A.', 7.62, 1.6, 0.8, 3.6, 1.8, 0xd9a14a, { K: '1', A: '2' });
axial('D_DO-41', 'Diode DO-41 axial (1N4001-1N4007, 1N5819). Pin 1 = K (band), pin 2 = A. Aliases K, A.', 10.16, 2.2, 1.1, 5.2, 2.7, 0x1c1c1e, { K: '1', A: '2' });
axial('D_DO-201', 'Diode DO-201 axial (1N5400 series, 3 A). Pin 1 = K (band), pin 2 = A. Aliases K, A.', 15.24, 2.6, 1.3, 9.5, 5.2, 0x1c1c1e, { K: '1', A: '2' });
approx('R_Axial_0309_P12.7', 'R_Axial_0411_P15.24', 'D_DO-201');
for (const [id, name, pitch, bw, bh, bz] of [['C_Disc_P5.0', 'Ceramic disc capacitor', 5.0, 5.0, 2.8, 6.5], ['C_Rect_P5.0', 'Film box capacitor 5mm pitch', 5.0, 7.2, 3.5, 8.5], ['C_Rect_P7.5', 'Film box capacitor 7.5mm pitch', 7.5, 10.3, 4.5, 10], ['C_Rect_P10.0', 'Film box capacitor 10mm pitch', 10.0, 13.0, 5.0, 11]] as [string, string, number, number, number, number][]) {
  add({
    id, mount: 'tht', description: `${name}. Pins 1,2 (non-polar).`,
    pads: [tht('1', -pitch / 2, 0, 1.6, 1.6, 0.8, 'rect'), tht('2', pitch / 2, 0, 1.6, 1.6, 0.8)],
    body: { w: bw, h: bh, z: bz, kind: 'box', color: id.startsWith('C_Disc') ? 0xd89a3a : 0x2a62b8 }, courtyard: { w: Math.max(bw, pitch + 1.6) + 0.6, h: bh + 0.8 },
  });
  approx(id);
}
for (const [d, pitch, z] of [[4.0, 1.5, 7], [6.3, 2.5, 11], [8.0, 3.5, 11.5], [10.0, 5.0, 16], [12.5, 5.0, 20], [16.0, 7.5, 25]] as const) {
  const drill = d >= 10 ? 1.0 : d >= 6.3 ? 0.9 : d >= 5 ? 0.8 : 0.6;
  add({
    id: `CP_Radial_D${d.toFixed(1)}`, mount: 'tht',
    description: `Electrolytic capacitor radial ${d}mm diameter, ${pitch}mm pitch THT. Pin 1 = +, pin 2 = -.`,
    pads: [tht('1', -pitch / 2, 0, Math.min(drill + 0.8, pitch - 0.3), Math.min(drill + 0.8, pitch - 0.3), drill, 'rect'), tht('2', pitch / 2, 0, Math.min(drill + 0.8, pitch - 0.3), Math.min(drill + 0.8, pitch - 0.3), drill)],
    body: { w: d, h: d, z, kind: 'cap_elec' }, courtyard: { w: d + 0.6, h: d + 0.6 }, aliases: { '+': '1', '-': '2' },
  });
}
for (const [id, d, dx, pw, ph, z] of [['CP_Elec_4x5.4', 4.3, 1.8, 2.6, 1.6, 5.4], ['CP_Elec_5x5.4', 5.3, 2.2, 3.0, 1.6, 5.4], ['CP_Elec_6.3x7.7', 6.6, 2.7, 3.3, 1.6, 7.7], ['CP_Elec_8x10', 8.3, 3.3, 3.8, 2.0, 10], ['CP_Elec_10x10', 10.3, 4.0, 4.0, 2.4, 10]] as [string, number, number, number, number, number][]) {
  add({
    id, mount: 'smd', description: `SMD aluminium electrolytic capacitor ${id.slice(8)}mm. Pin 1 = +, pin 2 = -.`,
    pads: [smd('1', -dx, 0, pw, ph), smd('2', dx, 0, pw, ph)],
    body: { w: d, h: d, z, kind: 'cap_smd_elec' }, courtyard: { w: 2 * dx + pw + 0.5, h: d + 0.6 }, aliases: { '+': '1', '-': '2' },
  });
  approx(id);
}
add({
  id: 'Pot_Trimmer_3296W', mount: 'tht', approx: true,
  description: 'Multi-turn trimmer potentiometer 3296W, in-line 2.54mm pins. 1 = end, 2 = wiper, 3 = end.',
  pads: [tht('1', -2.54, 0, 1.8, 1.8, 1.0, 'rect'), tht('2', 0, 0, 1.8, 1.8, 1.0), tht('3', 2.54, 0, 1.8, 1.8, 1.0)],
  body: { w: 9.5, h: 4.8, z: 10, kind: 'box', color: 0x2a62b8 }, courtyard: { w: 10.2, h: 5.6 },
  aliases: { W: '2', A: '1', B: '3' },
});

// ---- transistor / regulator packages ----
add({
  id: 'SOT-323', mount: 'smd', jlcRotation: 180, approx: true,
  description: 'SOT-323 / SC-70-3 (BAS70, BC847W, small MOSFETs). Same pin order as SOT-23: pins 1,2 left, 3 right (MOSFET 1=G 2=S 3=D, BJT 1=B 2=E 3=C).',
  pads: [smd('1', -0.95, 0.65, 0.8, 0.5), smd('2', -0.95, -0.65, 0.8, 0.5), smd('3', 0.95, 0, 0.8, 0.5)],
  body: { w: 1.25, h: 2.0, z: 0.95, kind: 'sot' }, courtyard: { w: 3.2, h: 2.5 },
  aliases: { G: '1', S: '2', D: '3', B: '1', E: '2', C: '3' },
});
for (const n of [5, 6]) {
  const pads: PadDef[] = [];
  [0.65, 0, -0.65].forEach((y, i) => pads.push(smd(String(i + 1), -0.95, y, 0.8, 0.4)));
  (n === 5 ? [-0.65, 0.65] : [-0.65, 0, 0.65]).forEach((y, i) => pads.push(smd(String(4 + i), 0.95, y, 0.8, 0.4)));
  add({
    id: `SC-70-${n}`, mount: 'smd', jlcRotation: 180, approx: true,
    description: `SC-70-${n} / SOT-${n === 5 ? '353' : '363'} (small logic gates, op-amps, dual transistors). Pins 1-3 left top-to-bottom, ${n === 5 ? '4-5' : '4-6'} right bottom-to-top.`,
    pads, body: { w: 1.25, h: 2.0, z: 0.95, kind: 'sot' }, courtyard: { w: 3.2, h: 2.6 },
  });
}
add({
  id: 'SOT-89-3', mount: 'smd', jlcRotation: 180, approx: true,
  description: 'SOT-89-3 (78L05, LDOs, RF transistors). Pins 1,2,3 along the bottom; pin 2 is also the large tab. Check pinout in the datasheet (78L05: 1=OUT 2=GND 3=IN).',
  pads: [smd('1', -1.5, -2.0, 0.9, 1.4), smd('2', 0, -2.0, 0.9, 1.4), smd('3', 1.5, -2.0, 0.9, 1.4), smd('2', 0, 0.9, 1.9, 2.4)],
  body: { w: 4.5, h: 2.5, z: 1.5, kind: 'sot' }, courtyard: { w: 5.6, h: 6.2, cy: -0.4 }, bridgedPins: ['2'],
});
add({
  id: 'TO-252-3', mount: 'smd', jlcRotation: 180, approx: true,
  description: 'TO-252 / DPAK power package, tab = pin 2. MOSFET: 1=G 2=D(tab) 3=S. LM1117/LDO: 1=GND/ADJ 2=VOUT(tab) 3=VIN. Aliases G,D,S,GND,ADJ,VOUT,VIN.',
  pads: [smd('1', -2.285, -4.0, 1.6, 3.0), smd('3', 2.285, -4.0, 1.6, 3.0), smd('2', 0, 1.3, 6.4, 5.8)],
  body: { w: 6.5, h: 6.1, z: 2.3, kind: 'sot' }, courtyard: { w: 7.6, h: 10.4, cy: -0.6 },
  aliases: { G: '1', D: '2', S: '3', GND: '1', ADJ: '1', VOUT: '2', VIN: '3' }, bridgedPins: ['2'],
});
add({
  id: 'TO-263-3', mount: 'smd', jlcRotation: 180, approx: true,
  description: 'TO-263 / D2PAK power package, tab = pin 2. MOSFET: 1=G 2=D(tab) 3=S. Regulator (LM2596 style differs - check datasheet). Aliases G,D,S,GND,VOUT,VIN.',
  pads: [smd('1', -2.54, -6.2, 1.4, 3.2), smd('3', 2.54, -6.2, 1.4, 3.2), smd('2', 0, 1.7, 10.0, 8.2)],
  body: { w: 10.2, h: 9.0, z: 4.4, kind: 'sot' }, courtyard: { w: 11.2, h: 14.2, cy: -1.0 },
  aliases: { G: '1', D: '2', S: '3', GND: '1', VOUT: '2', VIN: '3' }, bridgedPins: ['2'],
});
add({
  id: 'TO-92_Inline', mount: 'tht', approx: true,
  description: 'TO-92 through-hole transistor/regulator, pins 1,2,3 left-to-right facing the flat side. 2N3904: 1=E 2=B 3=C. 2N7000: 1=S 2=G 3=D. 78L05: 1=OUT 2=GND 3=IN. Check the datasheet pinout.',
  pads: [tht('1', -1.27, 0, 1.05, 1.5, 0.75, 'rect'), tht('2', 0, 0, 1.05, 1.5, 0.75, 'oval'), tht('3', 1.27, 0, 1.05, 1.5, 0.75, 'oval')],
  body: { w: 4.8, h: 3.8, z: 4.5, kind: 'box', color: 0x1c1c1e }, courtyard: { w: 5.6, h: 4.4 },
});
add({
  id: 'TO-247-3_Vertical', mount: 'tht', approx: true,
  description: 'TO-247 vertical power package (big MOSFETs/IGBTs). 1=G 2=D 3=S for most MOSFETs. Needs a heatsink.',
  pads: [tht('1', -5.45, 0, 2.7, 3.2, 1.5, 'rect'), tht('2', 0, 0, 2.7, 3.2, 1.5, 'oval'), tht('3', 5.45, 0, 2.7, 3.2, 1.5, 'oval')],
  body: { w: 15.9, h: 5.0, z: 21, kind: 'box', color: 0x1c1c1e }, courtyard: { w: 16.6, h: 5.8, cy: 0.5 },
  aliases: { G: '1', D: '2', S: '3' },
});

// ---- more SMD IC packages ----
dualRow('MSOP-8', 8, 0.65, 2.1, 1.5, 0.4, 3.0, 3.0, 'MSOP-8 3x3mm 0.65mm pitch (INA219, small op-amps/ADCs). Pins 1-4 left top-to-bottom, 5-8 right bottom-to-top.');
dualRow('MSOP-10', 10, 0.5, 2.1, 1.45, 0.3, 3.0, 3.0, 'MSOP-10 3x3mm 0.5mm pitch. Pins 1-5 left top-to-bottom, 6-10 right bottom-to-top.');
dualRow('MSOP-16', 16, 0.5, 2.1, 1.45, 0.3, 3.0, 4.0, 'MSOP-16 3x4mm 0.5mm pitch. Pins 1-8 left, 9-16 right (counter-clockwise).');
dualRow('TSSOP-8', 8, 0.65, 2.8625, 1.475, 0.4, 4.4, 3.0, 'TSSOP-8 (small op-amps, I2C EEPROM, RTC). Pins 1-4 left top-to-bottom, 5-8 right bottom-to-top.');
dualRow('TSSOP-14', 14, 0.65, 2.8625, 1.475, 0.4, 4.4, 5.0, 'TSSOP-14 (74HC logic, quad op-amps). Pins 1-7 left, 8-14 right (counter-clockwise).');
dualRow('TSSOP-16', 16, 0.65, 2.8625, 1.475, 0.4, 4.4, 5.0, 'TSSOP-16 (74HC595, PCA9685-style drivers). Pins 1-8 left, 9-16 right (counter-clockwise).');
dualRow('TSSOP-24', 24, 0.65, 2.8625, 1.475, 0.4, 4.4, 7.8, 'TSSOP-24 (TLC5940, I/O expanders). Pins 1-12 left, 13-24 right (counter-clockwise).');
dualRow('TSSOP-28', 28, 0.65, 2.8625, 1.475, 0.4, 4.4, 9.7, 'TSSOP-28 (STM32F0, CP2102N, FT232 alt). Pins 1-14 left, 15-28 right (counter-clockwise).');
dualRow('SSOP-20', 20, 0.65, 3.6, 1.75, 0.45, 5.3, 7.2, 'SSOP-20 5.3mm (CH340-alt, PIC16, FT230X). Pins 1-10 left, 11-20 right (counter-clockwise).');
dualRow('SSOP-24', 24, 0.65, 3.6, 1.75, 0.45, 5.3, 8.2, 'SSOP-24 5.3mm. Pins 1-12 left, 13-24 right (counter-clockwise).');
dualRow('SSOP-28', 28, 0.65, 3.6, 1.75, 0.45, 5.3, 10.2, 'SSOP-28 5.3mm (FT232RL, PIC18). Pins 1-14 left, 15-28 right (counter-clockwise).');
dualRow('SOIC-16W', 16, 1.27, 4.65, 2.0, 0.6, 7.5, 10.3, 'SOIC-16 wide 7.5mm (ADCs, gate drivers, ISO7xxx). Pins 1-8 left, 9-16 right (counter-clockwise).');
dualRow('SOIC-20W', 20, 1.27, 4.65, 2.0, 0.6, 7.5, 12.8, 'SOIC-20 wide 7.5mm (74HC logic, ATtiny/ATmega-U). Pins 1-10 left, 11-20 right (counter-clockwise).');
dualRow('SOIC-24W', 24, 1.27, 4.65, 2.0, 0.6, 7.5, 15.4, 'SOIC-24 wide 7.5mm. Pins 1-12 left, 13-24 right (counter-clockwise).');
dualRow('SOIC-28W', 28, 1.27, 4.65, 2.0, 0.6, 7.5, 17.9, 'SOIC-28 wide 7.5mm (ATmega-SOIC, PCA drivers). Pins 1-14 left, 15-28 right (counter-clockwise).');
approx('MSOP-8', 'MSOP-10', 'MSOP-16', 'SSOP-20', 'SSOP-24', 'SSOP-28', 'SOIC-24W', 'SOIC-28W');

function dualRowEp(id: string, n: number, pitch: number, dx: number, pw: number, ph: number, bw: number, bh: number, epw: number, eph: number, desc: string, kind: 'ic' | 'qfn' = 'qfn') {
  const half = n / 2, y0 = ((half - 1) * pitch) / 2;
  const pads: PadDef[] = [];
  for (let i = 0; i < half; i++) pads.push(smd(String(i + 1), -dx, y0 - i * pitch, pw, ph));
  for (let i = 0; i < half; i++) pads.push(smd(String(half + i + 1), dx, -y0 + i * pitch, pw, ph));
  pads.push(smd(String(n + 1), 0, 0, epw, eph));
  add({
    id, mount: 'smd', approx: true, description: `${desc} Exposed pad = pin ${n + 1} (alias EP, normally GND).`, pads,
    body: { w: bw, h: bh, z: 1.0, kind }, courtyard: { w: 2 * dx + pw + 0.5, h: Math.max(bh, 2 * y0 + ph) + 0.5 }, aliases: { EP: String(n + 1) },
  });
}
dualRowEp('SOIC-8_EP', 8, 1.27, 2.475, 1.95, 0.6, 3.9, 4.9, 2.41, 3.1, 'SOIC-8 with exposed pad (TPS5430-style buck, motor drivers, LM25xx). Pins 1-4 left, 5-8 right (counter-clockwise).', 'ic');
dualRowEp('DFN-6_2x2_EP', 6, 0.65, 0.9, 0.8, 0.35, 2.0, 2.0, 0.9, 1.6, 'DFN-6 2x2mm 0.65mm pitch. Pins 1-3 left top-to-bottom, 4-6 right bottom-to-top.');
dualRowEp('DFN-8_3x3_EP', 8, 0.65, 1.4, 0.85, 0.35, 3.0, 3.0, 1.65, 2.4, 'DFN-8 3x3mm 0.65mm pitch (small regulators, ADCs). Pins 1-4 left top-to-bottom, 5-8 right bottom-to-top.');
dualRowEp('DFN-10_3x3_EP', 10, 0.5, 1.4, 0.85, 0.3, 3.0, 3.0, 1.65, 2.4, 'DFN-10 3x3mm 0.5mm pitch. Pins 1-5 left top-to-bottom, 6-10 right bottom-to-top.');

qfp('LQFP-44', 44, 0.8, 5.7, 1.5, 0.55, 10, 'LQFP/TQFP-44 10x10 0.8mm (ATmega32U4-A/AU, STM32F1/F0). Pin 1 top-left, counter-clockwise.');
qfp('LQFP-64', 64, 0.5, 5.7, 1.5, 0.3, 10, 'LQFP/TQFP-64 10x10 0.5mm (STM32F103RB/F4/G4, ATmega64). Pin 1 top-left, counter-clockwise.');
qfp('LQFP-80', 80, 0.5, 6.7, 1.5, 0.3, 12, 'LQFP-80 12x12 0.5mm. Pin 1 top-left, counter-clockwise.');
qfp('LQFP-100', 100, 0.5, 7.7, 1.5, 0.3, 14, 'LQFP/TQFP-100 14x14 0.5mm (STM32F4/H7, LPC). Pin 1 top-left, counter-clockwise.');
qfp('LQFP-144', 144, 0.5, 10.7, 1.5, 0.3, 20, 'LQFP-144 20x20 0.5mm (STM32F4/H7). Pin 1 top-left, counter-clockwise.');
approx('LQFP-80');

function qfn(id: string, per: number, pitch: number, body: number, pwid: number, ep: number, desc: string) {
  const n = per * 4, d = body / 2 - 0.0625, pl = 0.875, s0 = ((per - 1) * pitch) / 2;
  const pads: PadDef[] = [];
  for (let i = 0; i < per; i++) pads.push(smd(String(i + 1), -d, s0 - i * pitch, pl, pwid));
  for (let i = 0; i < per; i++) pads.push(smd(String(per + i + 1), -s0 + i * pitch, -d, pwid, pl));
  for (let i = 0; i < per; i++) pads.push(smd(String(2 * per + i + 1), d, -s0 + i * pitch, pl, pwid));
  for (let i = 0; i < per; i++) pads.push(smd(String(3 * per + i + 1), s0 - i * pitch, d, pwid, pl));
  pads.push(smd(String(n + 1), 0, 0, ep, ep));
  add({
    id, mount: 'smd', approx: true, pads,
    description: `${desc} Pin 1 top-left, counter-clockwise; exposed pad = pin ${n + 1} (alias EP, normally GND). Check the exposed-pad size against the datasheet.`,
    body: { w: body, h: body, z: 0.9, kind: 'qfn' }, courtyard: { w: body + 1.25, h: body + 1.25 }, aliases: { EP: String(n + 1) },
  });
}
qfn('QFN-16_3x3_P0.5', 4, 0.5, 3, 0.25, 1.7, 'QFN-16 3x3mm 0.5mm (small MCUs, drivers, MCP, PCA9685-class).');
qfn('QFN-20_4x4_P0.5', 5, 0.5, 4, 0.25, 2.6, 'QFN-20 4x4mm 0.5mm (CH552, STM32G0/F0, ATtiny, CC1101).');
qfn('QFN-24_4x4_P0.5', 6, 0.5, 4, 0.25, 2.6, 'QFN-24 4x4mm 0.5mm (CH340-alt, nRF, CP2102N).');
qfn('QFN-28_5x5_P0.5', 7, 0.5, 5, 0.25, 3.35, 'QFN-28 5x5mm 0.5mm (CP2102, FT230).');
qfn('QFN-32_5x5_P0.5', 8, 0.5, 5, 0.25, 3.45, 'QFN-32 5x5mm 0.5mm (ESP32-C3, ATmega328P-MU, STM32G0/L4, ATSAMD21).');
qfn('QFN-40_5x5_P0.4', 10, 0.4, 5, 0.2, 3.6, 'QFN-40 5x5mm 0.4mm (bare ESP32-C6, ESP32-S2/C2-class). A bare Wi-Fi chip also needs flash, a 40 MHz crystal and an RF matching network - consider a ready-made module instead.');
qfn('QFN-48_6x6_P0.4', 12, 0.4, 6, 0.2, 4.6, 'QFN-48 6x6mm 0.4mm (nRF52832, nRF52833).');
qfn('QFN-48_7x7_P0.5', 12, 0.5, 7, 0.25, 5.6, 'QFN-48 7x7mm 0.5mm (STM32 UFQFPN48, CH32).');
qfn('QFN-56_7x7_EP3.2', 14, 0.4, 7, 0.2, 3.2, 'QFN-56 7x7mm 0.4mm with 3.2mm exposed pad (RP2040).');
qfn('QFN-56_7x7_EP5.3', 14, 0.4, 7, 0.2, 5.3, 'QFN-56 7x7mm 0.4mm with 5.3mm exposed pad (bare ESP32-S3).');
qfn('QFN-64_9x9_P0.5', 16, 0.5, 9, 0.25, 7.15, 'QFN-64 9x9mm 0.5mm (STM32 UFQFPN64, ATmega64M1).');

// ---- headers, sockets, connectors ----
for (let n = 1; n <= 20; n++) {
  const pads: PadDef[] = [];
  const y0 = ((n - 1) * 2.54) / 2;
  for (let i = 0; i < n; i++) pads.push(tht(String(i + 1), 0, y0 - i * 2.54, 1.7, 1.7, 1.0, i === 0 ? 'rect' : 'oval'));
  add({ id: `PinSocket_1x${String(n).padStart(2, '0')}`, mount: 'tht', pads, description: `Female pin socket 1x${n}, 2.54mm pitch. Pins 1..${n}.`, body: { w: 2.54, h: n * 2.54, z: 8.5, kind: 'socket' }, courtyard: { w: 3.0, h: n * 2.54 + 0.5 } });
}
for (let n = 2; n <= 20; n++) {
  const pads: PadDef[] = [];
  const y0 = ((n - 1) * 2.54) / 2;
  for (let i = 0; i < n; i++) {
    pads.push(tht(String(2 * i + 1), -1.27, y0 - i * 2.54, 1.7, 1.7, 1.0, i === 0 ? 'rect' : 'oval'));
    pads.push(tht(String(2 * i + 2), 1.27, y0 - i * 2.54, 1.7, 1.7, 1.0, 'oval'));
  }
  add({ id: `PinSocket_2x${String(n).padStart(2, '0')}`, mount: 'tht', pads, description: `Female pin socket 2x${n}, 2.54mm. Odd pins left column, even right; pin 1 top-left (2x20 = Raspberry Pi GPIO).`, body: { w: 5.08, h: n * 2.54, z: 8.5, kind: 'socket' }, courtyard: { w: 5.6, h: n * 2.54 + 0.5 } });
}
{
  const pads: PadDef[] = [];
  for (let i = 0; i < 5; i++) {
    pads.push(tht(String(2 * i + 1), -0.635, 2.54 - i * 1.27, 1.0, 1.0, 0.6, i === 0 ? 'rect' : 'oval'));
    pads.push(tht(String(2 * i + 2), 0.635, 2.54 - i * 1.27, 1.0, 1.0, 0.6, 'oval'));
  }
  add({
    id: 'PinHeader_2x05_P1.27mm', mount: 'tht', pads, approx: true,
    description: 'Male header 2x5, 1.27mm pitch - ARM Cortex debug/SWD connector. 1=VTref 2=SWDIO 3=GND 4=SWCLK 5=GND 6=SWO 7=KEY 8=NC 9=GND 10=nRESET.',
    body: { w: 2.54, h: 6.35, z: 5.0, kind: 'header' }, courtyard: { w: 3.6, h: 7.0 },
  });
}
for (let n = 2; n <= 8; n++) {
  const x0 = (n - 1) / 2, pads: PadDef[] = [];
  for (let i = 0; i < n; i++) pads.push(smd(String(i + 1), -x0 + i, 1.45, 0.6, 1.55));
  for (const s of [-1, 1]) pads.push(smd('MP', s * (x0 + 1.3), -0.35, 1.2, 1.8));
  add({
    id: `JST_SH_${n}_SMD`, mount: 'smd', edge: 'bottom', approx: true, pads, bridgedPins: ['MP'],
    description: `JST SH 1.0mm side-entry SMD connector, ${n} pins (SM0${n}B-SRSS-TB, Qwiic/STEMMA QT = 4-pin: 1=GND 2=3V3 3=SDA 4=SCL). Pins 1..${n}; MP = mounting tabs (connect to GND).`,
    body: { w: n - 1 + 4.0, h: 4.25, z: 4.25, kind: 'box', color: 0xece6d2 }, courtyard: { w: n - 1 + 5.4, h: 5.6, cy: 0.4 },
  });
}
for (const [pitch, drill, pad, bh, z, tag] of [[3.5, 1.2, 2.4, 7.2, 8.5, '3.5'], [3.81, 1.3, 2.4, 7.6, 9.0, '3.81']] as const) {
  for (let n = 2; n <= 6; n++) {
    const pads: PadDef[] = [];
    const x0 = ((n - 1) * pitch) / 2;
    for (let i = 0; i < n; i++) pads.push(tht(String(i + 1), -x0 + i * pitch, 0, pad, pad, drill, i === 0 ? 'rect' : 'circle'));
    add({
      id: `TerminalBlock_${tag}_${n}`, mount: 'tht', edge: 'top', pads, approx: true,
      description: `Screw/spring terminal block ${tag}mm pitch, ${n} positions. Pins 1..${n}. Wire entry faces board edge.`,
      body: { w: n * pitch, h: bh, z, kind: 'terminal', color: 0x2e8b57 }, courtyard: { w: n * pitch + 0.6, h: bh + 0.6, cy: 0.5 },
    });
  }
}
for (let n = 5; n <= 6; n++) {
  const pads: PadDef[] = [];
  const x0 = ((n - 1) * 5.08) / 2;
  for (let i = 0; i < n; i++) pads.push(tht(String(i + 1), -x0 + i * 5.08, 0, 2.6, 2.6, 1.3, i === 0 ? 'rect' : 'circle'));
  add({ id: `TerminalBlock_5.08_${n}`, mount: 'tht', edge: 'top', pads, description: `Screw terminal block 5.08mm, ${n} positions. Pins 1..${n}. Wire entry faces board edge.`, body: { w: n * 5.08, h: 8.0, z: 10, kind: 'terminal', color: 0x2e8b57 }, courtyard: { w: n * 5.08 + 0.6, h: 8.6, cy: 0.5 } });
}
add({
  id: 'USB_Micro-B_SMD', mount: 'smd', edge: 'bottom', approx: true, bridgedPins: ['SHIELD'],
  description: 'USB Micro-B receptacle, SMD. Pins: 1=VBUS 2=D- 3=D+ 4=ID 5=GND, SHIELD (connect to GND). Aliases VBUS, D-, D+, ID, GND.',
  pads: [smd('1', -1.3, 2.8, 0.4, 1.35), smd('2', -0.65, 2.8, 0.4, 1.35), smd('3', 0, 2.8, 0.4, 1.35), smd('4', 0.65, 2.8, 0.4, 1.35), smd('5', 1.3, 2.8, 0.4, 1.35),
    smd('SHIELD', -3.2, 2.5, 1.9, 1.9), smd('SHIELD', 3.2, 2.5, 1.9, 1.9), smd('SHIELD', -3.9, -1.3, 1.8, 1.9), smd('SHIELD', 3.9, -1.3, 1.8, 1.9)],
  body: { w: 7.5, h: 5.0, z: 2.8, kind: 'usbc' }, courtyard: { w: 9.6, h: 6.8, cy: 0.5 },
  aliases: { VBUS: '1', 'D-': '2', 'D+': '3', ID: '4', GND: '5' },
});
add({
  id: 'USB_A_Horizontal_THT', mount: 'tht', edge: 'bottom', approx: true, bridgedPins: ['SHIELD'],
  description: 'USB Type-A receptacle, horizontal through-hole. 1=VBUS 2=D- 3=D+ 4=GND, SHIELD (connect to GND). Aliases VBUS, D-, D+, GND.',
  pads: [tht('1', -3.5, 5.0, 1.7, 1.7, 1.0, 'rect'), tht('2', -1.0, 5.0, 1.7, 1.7, 1.0), tht('3', 1.0, 5.0, 1.7, 1.7, 1.0), tht('4', 3.5, 5.0, 1.7, 1.7, 1.0),
    tht('SHIELD', -6.57, 2.0, 3.0, 3.0, 2.2), tht('SHIELD', 6.57, 2.0, 3.0, 3.0, 2.2)],
  body: { w: 13.1, h: 14.0, z: 5.6, kind: 'usbc' }, courtyard: { w: 15.5, h: 15.0, cy: 0.5 },
  aliases: { VBUS: '1', 'D-': '2', 'D+': '3', GND: '4' },
});
add({
  id: 'BarrelJack_PJ-002A', mount: 'tht', edge: 'top', approx: true,
  description: 'DC barrel jack 5.5x2.1mm, horizontal (PJ-002A style). 1=centre pin (usually +), 2=sleeve (GND), 3=switch contact (leave open or use for battery detect). Verify pin positions against the datasheet of your jack.',
  pads: [tht('1', 0, -5.5, 3.4, 2.2, 1.0, 'oval'), tht('2', 0, 0.5, 3.4, 2.2, 1.0, 'oval'), tht('3', 4.7, -2.5, 2.2, 3.0, 1.0, 'oval')],
  body: { w: 9.0, h: 14.0, z: 11, kind: 'box', color: 0x222224 }, courtyard: { w: 10.0, h: 15.0, cy: 0.5 },
});
add({
  id: 'UFL_Hirose_SMT', mount: 'smd', approx: true,
  description: 'U.FL / IPEX MHF1 coaxial RF connector (Hirose U.FL-R-SMT-1), for an external 2.4 GHz antenna. Pin 1 = signal, pin 2 = ground (the two outer pads). Connect pin 1 to the 50-ohm RF trace and pin 2 to GND.',
  pads: [smd('1', -1.05, 0, 1.05, 1.0), smd('2', 0, -1.475, 2.2, 1.05), smd('2', 0, 1.475, 2.2, 1.05)],
  body: { w: 3.0, h: 3.0, z: 1.25, kind: 'box', color: 0xc0c0c0 }, courtyard: { w: 3.6, h: 4.6 }, bridgedPins: ['2'], aliases: { SIG: '1', GND: '2' },
});

// ---- switches, buzzers, rotary encoder ----
for (let n = 2; n <= 8; n++) {
  const pads: PadDef[] = [];
  const y0 = ((n - 1) * 2.54) / 2;
  for (let i = 0; i < n; i++) pads.push(tht(String(i + 1), -3.81, y0 - i * 2.54, 1.6, 1.6, 0.8, i === 0 ? 'rect' : 'oval'));
  for (let i = 0; i < n; i++) pads.push(tht(String(n + i + 1), 3.81, -y0 + i * 2.54, 1.6, 1.6, 0.8, 'oval'));
  add({
    id: `SW_DIP_x${String(n).padStart(2, '0')}`, mount: 'tht', pads, approx: true,
    description: `DIP switch, ${n} positions. Switch k connects pin k (left) to pin ${2 * n + 1}-k (right).`,
    body: { w: 7.6, h: n * 2.54 + 0.3, z: 5.5, kind: 'box', color: 0xc0392b }, courtyard: { w: 9.6, h: n * 2.54 + 0.8 },
  });
}
add({
  id: 'SW_Encoder_EC11', mount: 'tht', approx: true,
  description: 'Rotary encoder EC11 with push switch. Pins: 1=A, 2=C (common), 3=B, 4,5 = push switch. Aliases A, C, B, S1, S2.',
  pads: [tht('1', -2.5, 7.5, 2.0, 2.0, 1.0), tht('2', 0, 7.5, 2.0, 2.0, 1.0, 'rect'), tht('3', 2.5, 7.5, 2.0, 2.0, 1.0), tht('4', -2.5, -7.0, 2.0, 2.0, 1.0), tht('5', 2.5, -7.0, 2.0, 2.0, 1.0)],
  body: { w: 12.0, h: 12.0, z: 6.5, kind: 'box', color: 0x9a9a9e }, courtyard: { w: 13.0, h: 17.5 },
  aliases: { A: '1', C: '2', B: '3', S1: '4', S2: '5' },
});
add({
  id: 'Buzzer_THT_12mm', mount: 'tht', approx: true,
  description: 'Magnetic/active buzzer 12mm through-hole, 7.6mm pitch. Pin 1 = +, pin 2 = -. Drive through a MOSFET/transistor.',
  pads: [tht('1', -3.8, 0, 2.0, 2.0, 1.0, 'rect'), tht('2', 3.8, 0, 2.0, 2.0, 1.0)],
  body: { w: 12, h: 12, z: 9.5, kind: 'cylinder', color: 0x151515 }, courtyard: { w: 12.6, h: 12.6 }, aliases: { '+': '1', '-': '2' },
});

// ---- crystals and oscillators ----
function crystal4(id: string, desc: string, dx: number, dy: number, pw: number, ph: number, bw: number, bh: number, aliases?: Record<string, string>) {
  add({
    id, mount: 'smd', approx: true, description: desc, aliases,
    pads: [smd('1', -dx, -dy, pw, ph), smd('2', dx, -dy, pw, ph), smd('3', dx, dy, pw, ph), smd('4', -dx, dy, pw, ph)],
    body: { w: bw, h: bh, z: 0.8, kind: 'crystal_smd' }, courtyard: { w: 2 * dx + pw + 0.5, h: 2 * dy + ph + 0.5 },
  });
}
crystal4('Crystal_SMD_2016_4P', 'SMD crystal 2.0x1.6mm 4-pad. Pins 1 and 3 are the crystal; 2 and 4 are case GND.', 0.8, 0.6, 0.9, 0.8, 2.0, 1.6);
crystal4('Crystal_SMD_2520_4P', 'SMD crystal 2.5x2.0mm 4-pad. Pins 1 and 3 are the crystal; 2 and 4 are case GND.', 0.95, 0.725, 1.0, 0.95, 2.5, 2.0);
crystal4('Osc_SMD_3225_4P', 'SMD oscillator 3.2x2.5mm. 1=EN (or NC), 2=GND, 3=OUT, 4=VDD. Aliases EN, GND, OUT, VDD. Add a 100nF cap on VDD.', 1.1, 0.8, 1.4, 1.15, 3.2, 2.5, { EN: '1', GND: '2', OUT: '3', VDD: '4' });
crystal4('Osc_SMD_5032_4P', 'SMD oscillator 5.0x3.2mm. 1=EN (or NC), 2=GND, 3=OUT, 4=VDD. Aliases EN, GND, OUT, VDD. Add a 100nF cap on VDD.', 2.2, 1.15, 1.6, 1.4, 5.0, 3.2, { EN: '1', GND: '2', OUT: '3', VDD: '4' });
add({ id: 'Crystal_SMD_5032_2P', mount: 'smd', approx: true, description: 'SMD crystal 5.0x3.2mm 2-pad. Pins 1,2 (non-polar).', pads: [smd('1', -2.05, 0, 1.9, 2.4), smd('2', 2.05, 0, 1.9, 2.4)], body: { w: 5.0, h: 3.2, z: 1.2, kind: 'crystal_smd' }, courtyard: { w: 6.4, h: 3.8 } });
add({ id: 'Crystal_SMD_3215_2P', mount: 'smd', approx: true, description: 'SMD 32.768 kHz watch crystal 3.2x1.5mm. Pins 1,2 (non-polar).', pads: [smd('1', -1.25, 0, 1.0, 1.8), smd('2', 1.25, 0, 1.0, 1.8)], body: { w: 3.2, h: 1.5, z: 0.9, kind: 'crystal_smd' }, courtyard: { w: 3.9, h: 2.4 } });

// ---- modules ----
{
  const names = ['RST', 'ADC', 'EN', 'IO16', 'IO14', 'IO12', 'IO13', 'VCC', 'CS0', 'MISO', 'IO9', 'IO10', 'MOSI', 'SCLK', 'GND', 'IO15', 'IO2', 'IO0', 'IO4', 'IO5', 'RXD', 'TXD'];
  const pid = (i: number) => (names[i] === 'GND' ? 'GND' : String(i + 1));
  const pads: PadDef[] = [];
  for (let i = 0; i < 8; i++) pads.push(smd(pid(i), -7.9, 4.5 - i * 2, 1.5, 1.0));
  for (let i = 0; i < 6; i++) pads.push(smd(pid(8 + i), -5 + i * 2, -11.4, 1.0, 1.5));
  for (let i = 0; i < 8; i++) pads.push(smd(pid(14 + i), 7.9, -9.5 + i * 2, 1.5, 1.0));
  const aliases: Record<string, string> = { '3V3': '8', TX: '22', RX: '21' };
  names.forEach((nm, i) => { if (nm !== 'GND') aliases[nm] = String(i + 1); });
  add({
    id: 'ESP-12F', mount: 'smd', edge: 'top', approx: true, pads, bridgedPins: ['GND'], aliases,
    description: 'ESP-12F / ESP-12E ESP8266 Wi-Fi module 16x24mm. Pins: 1=RST 2=ADC 3=EN 4=IO16 5=IO14 6=IO12 7=IO13 8=VCC(3V3) 9=CS0 10=MISO 11=IO9 12=IO10 13=MOSI 14=SCLK 15=GND 16=IO15 17=IO2 18=IO0 19=IO4 20=IO5 21=RXD 22=TXD. EN and IO15 need pull-up/down (EN high, IO15 low, IO0 high to run).',
    body: { w: 16, h: 24, z: 3.0, kind: 'module' }, courtyard: { w: 17, h: 25 }, keepouts: [{ x0: -8.5, y0: 6.5, x1: 8.5, y1: 12.5 }],
  });
}
{
  const names = ['GND', '3V3', 'EN', 'IO4', 'IO5', 'IO6', 'IO7', 'IO15', 'IO16', 'IO17', 'IO18', 'IO8', 'IO19', 'IO20',
    'IO3', 'IO46', 'IO9', 'IO10', 'IO11', 'IO12', 'IO13', 'IO14', 'IO21', 'IO47', 'IO48', 'IO45',
    'IO0', 'IO35', 'IO36', 'IO37', 'IO38', 'IO39', 'IO40', 'IO41', 'IO42', 'RXD0', 'TXD0', 'IO2', 'IO1', 'GND'];
  const pid = (i: number) => (names[i] === 'GND' ? 'GND' : String(i + 1));
  const pads: PadDef[] = [];
  for (let i = 0; i < 14; i++) pads.push(smd(pid(i), -8.75, 5.26 - i * 1.27, 1.5, 0.9));
  for (let i = 0; i < 12; i++) pads.push(smd(pid(14 + i), -6.985 + i * 1.27, -12.5, 0.9, 1.5));
  for (let i = 0; i < 14; i++) pads.push(smd(pid(26 + i), 8.75, -11.25 + i * 1.27, 1.5, 0.9));
  pads.push(smd('GND', 0, -3.0, 3.9, 3.9));
  const aliases: Record<string, string> = { TX: '37', RX: '36', TXD: '37', RXD: '36', VCC: '2', 'USB_D-': '13', 'USB_D+': '14' };
  names.forEach((nm, i) => { if (nm !== 'GND') aliases[nm] = String(i + 1); });
  add({
    id: 'ESP32-S3-WROOM-1', mount: 'smd', edge: 'top', approx: true, pads, bridgedPins: ['GND'], aliases,
    description: 'ESP32-S3-WROOM-1 module 18x25.5mm (Wi-Fi + BLE, native USB on IO19=D- IO20=D+). Pins by number 1-40 or by name: 2=3V3 3=EN 4=IO4 5=IO5 6=IO6 7=IO7 8=IO15 9=IO16 10=IO17 11=IO18 12=IO8 13=IO19 14=IO20 15=IO3 16=IO46 17=IO9 18=IO10 19=IO11 20=IO12 21=IO13 22=IO14 23=IO21 24=IO47 25=IO48 26=IO45 27=IO0 28..34=IO35..IO41(IO35-37 not usable on N8R8 variants) 35=IO42 36=RXD0 37=TXD0 38=IO2 39=IO1. All GND pads (1, 40, exposed pad) are one pin named GND. Antenna end faces the board edge (automatic).',
    body: { w: 18, h: 25.5, z: 3.1, kind: 'module' }, courtyard: { w: 19.0, h: 26.5 }, keepouts: [{ x0: -9, y0: 6.75, x1: 9, y1: 12.75 }],
  });
}
{
  const names = ['GP0', 'GP1', 'GND', 'GP2', 'GP3', 'GP4', 'GP5', 'GND', 'GP6', 'GP7', 'GP8', 'GP9', 'GND', 'GP10', 'GP11', 'GP12', 'GP13', 'GND', 'GP14', 'GP15',
    'GP16', 'GP17', 'GND', 'GP18', 'GP19', 'GP20', 'GP21', 'GND', 'GP22', 'RUN', 'GP26', 'GP27', 'AGND', 'GP28', 'ADC_VREF', '3V3', '3V3_EN', 'GND', 'VSYS', 'VBUS'];
  const pid = (i: number) => (names[i] === 'GND' ? 'GND' : String(i + 1));
  const pads: PadDef[] = [];
  for (let i = 0; i < 20; i++) pads.push(tht(pid(i), -8.89, 24.13 - i * 2.54, 1.7, 1.7, 1.02, i === 0 ? 'rect' : 'circle'));
  for (let i = 0; i < 20; i++) pads.push(tht(pid(20 + i), 8.89, -24.13 + i * 2.54, 1.7, 1.7, 1.02, 'circle'));
  const aliases: Record<string, string> = {};
  names.forEach((nm, i) => { if (nm !== 'GND') aliases[nm] = String(i + 1); });
  add({
    id: 'RPi_Pico', mount: 'tht', approx: true, pads, bridgedPins: ['GND'], aliases,
    description: 'Raspberry Pi Pico / Pico W / RP2040-Zero-style 2x20 module, 21x51mm, through-hole. Pins 1-20 left top-to-bottom, 21-40 right bottom-to-top: GP0..GP22, GP26..GP28 by name, 30=RUN, 33=AGND, 35=ADC_VREF, 36=3V3(OUT), 37=3V3_EN, 39=VSYS, 40=VBUS. Every GND pin is one pin named GND. USB end is at the top.',
    body: { w: 21, h: 51, z: 1.0, kind: 'box', color: 0x1f7a3a }, courtyard: { w: 22, h: 52 },
  });
}

// ---- test points and mounting hardware ----
for (const d of [1.0, 1.5, 2.0]) {
  add({
    id: `TestPoint_Pad_D${d.toFixed(1)}mm`, mount: 'smd', description: `Test point, round SMD pad ${d}mm. Pin 1.`,
    pads: [smd('1', 0, 0, d, d, 'circle')], body: { w: d, h: d, z: 0.05, kind: 'box', color: 0xd4af37 }, courtyard: { w: d + 0.8, h: d + 0.8 },
  });
}
add({ id: 'TestPoint_THT_D2.0mm', mount: 'tht', description: 'Test point, round through-hole pad 2mm (fits a scope hook / probe). Pin 1.', pads: [tht('1', 0, 0, 2.0, 2.0, 1.0)], body: { w: 2.0, h: 2.0, z: 0.1, kind: 'box', color: 0xd4af37 }, courtyard: { w: 3.0, h: 3.0 } });
for (const [id, d, name] of [['MountingHole_2.2mm_M2', 2.2, 'M2'], ['MountingHole_2.7mm_M2.5', 2.7, 'M2.5'], ['MountingHole_4.3mm_M4', 4.3, 'M4'], ['MountingHole_5.3mm_M5', 5.3, 'M5']] as [string, number, string][]) {
  add({ id, mount: 'tht', description: `${name} mounting hole (non-plated, ${d}mm). No pins.`, pads: [{ pin: 'H', x: 0, y: 0, w: d, h: d, shape: 'circle', type: 'npth', drill: d }], body: { w: d, h: d, z: 0, kind: 'hole' }, courtyard: { w: d * 2 + 0.4, h: d * 2 + 0.4 } });
}
add({
  id: 'MountingHole_3.2mm_M3_Plated', mount: 'tht', description: 'M3 mounting hole with a 6mm plated ring (pin 1). Connect pin 1 to GND for a grounded screw post.',
  pads: [tht('1', 0, 0, 6.0, 6.0, 3.2)], body: { w: 3.2, h: 3.2, z: 0, kind: 'hole' }, courtyard: { w: 7.0, h: 7.0 },
});

for (const f of KICAD_FOOTPRINTS) add(f);
for (const f of fps) if (approxIds.has(f.id)) f.approx = true;

export const FOOTPRINTS: Record<string, FootprintDef> = Object.fromEntries(fps.map((f) => [f.id, f]));
export const FOOTPRINT_IDS = fps.map((f) => f.id);

const SYNONYMS: Record<string, string> = {
  'sot-23-3': 'SOT-23', 'sot23': 'SOT-23', 'sot-23': 'SOT-23', 'tsot-23-5': 'SOT-23-5', 'tsot-23-6': 'SOT-23-6', 'sot-25': 'SOT-23-5', 'sot-26': 'SOT-23-6', 'sot-223-3': 'SOT-223',
  'sc-70': 'SOT-323', 'sc-70-3': 'SOT-323', 'sot-353': 'SC-70-5', 'sot-363': 'SC-70-6', 'dpak': 'TO-252-3', 'to-252': 'TO-252-3', 'd2pak': 'TO-263-3', 'to-263': 'TO-263-3', 'sot-89': 'SOT-89-3',
  'to-92': 'TO-92_Inline', 'to-220': 'TO-220-3_Vertical', 'to-247': 'TO-247-3_Vertical', 'sop-8': 'SOIC-8', 'so-8': 'SOIC-8', 'soic-8_ep': 'SOIC-8_EP', 'msop8': 'MSOP-8',
  'tqfp-32': 'LQFP-32', 'tqfp-44': 'LQFP-44', 'tqfp-48': 'LQFP-48', 'tqfp-64': 'LQFP-64', 'tqfp-100': 'LQFP-100', 'qfn-16': 'QFN-16_3x3_P0.5', 'qfn-20': 'QFN-20_4x4_P0.5', 'qfn-24': 'QFN-24_4x4_P0.5',
  'qfn-28': 'QFN-28_5x5_P0.5', 'qfn-32': 'QFN-32_5x5_P0.5', 'qfn-40': 'QFN-40_5x5_P0.4', 'qfn-64': 'QFN-64_9x9_P0.5', 'esp32-wroom-32e': 'ESP32-WROOM-32', 'esp32-s3-wroom-1': 'ESP32-S3-WROOM-1',
  'esp8266-esp-12f': 'ESP-12F', 'esp-12e': 'ESP-12F', 'esp-12': 'ESP-12F', 'pico': 'RPi_Pico', 'rpi-pico': 'RPi_Pico', 'ws2812b': 'WS2812B_5050', 'sk6812': 'WS2812B_5050', 'u.fl': 'UFL_Hirose_SMT', 'ufl': 'UFL_Hirose_SMT',
  'usb_micro-b': 'USB_Micro-B_SMD', 'usb-micro-b': 'USB_Micro-B_SMD', 'usb_c': 'USB_C_16P', 'usb-c': 'USB_C_16P', 'barreljack': 'BarrelJack_PJ-002A', 'dc-jack': 'BarrelJack_PJ-002A',
};

export function getFootprint(id: string): FootprintDef | undefined {
  if (FOOTPRINTS[id]) return FOOTPRINTS[id];
  if (custom.has(id)) return custom.get(id);
  const norm = id.replace(/\s+/g, '').toLowerCase();
  const f = fps.find((x) => x.id.toLowerCase() === norm);
  if (f) return f;
  for (const [cid, cf] of custom) if (cid.toLowerCase() === norm) return cf;
  const syn = SYNONYMS[norm];
  if (syn && FOOTPRINTS[syn]) return FOOTPRINTS[syn];
  // common forms: "0603 resistor", "R0603", "PinHeader_1x4"
  const m = norm.match(/pinheader_?([12])x0?(\d+)/);
  if (m) return FOOTPRINTS[`PinHeader_${m[1]}x${m[2].padStart(2, '0')}`];
  const sock = norm.match(/pinsocket_?([12])x0?(\d+)/);
  if (sock) return FOOTPRINTS[`PinSocket_${sock[1]}x${sock[2].padStart(2, '0')}`];
  const chipM = norm.match(/^([rcl]|led)_?(0402|0603|0805|1206)$/);
  if (chipM) return FOOTPRINTS[`${chipM[1].toUpperCase()}_${chipM[2]}`];
  return undefined;
}

/** Resolve a pin reference against a footprint: exact id, alias, or case-insensitive. */
export function resolvePin(fp: FootprintDef, pin: string): string | undefined {
  const ids = new Set(fp.pads.filter((p) => p.type !== 'npth').map((p) => p.pin));
  if (ids.has(pin)) return pin;
  if (fp.aliases?.[pin]) return fp.aliases[pin];
  const up = pin.toUpperCase();
  for (const id of ids) if (id.toUpperCase() === up) return id;
  if (fp.aliases) for (const [k, v] of Object.entries(fp.aliases)) if (k.toUpperCase() === up) return v;
  // "IO02" -> "IO2", "GPIO2" -> "IO2"
  const g = up.replace(/^GPIO/, 'IO').replace(/^IO0+(\d)/, 'IO$1');
  if (fp.aliases?.[g]) return fp.aliases[g];
  return undefined;
}

/** Footprints used by a board that have nominal (non-verified) geometry. */
export function approxFootprints(ids: Iterable<string>): string[] {
  return [...new Set([...ids])].filter((id) => getFootprint(id)?.approx);
}

// ---------------- AI-created footprints ----------------
const custom = new Map<string, FootprintDef>();
export function customFootprintIds(): string[] { return [...custom.keys()]; }

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Replace the custom footprint registry with those of a design. Returns human-readable problems. */
export function registerCustomFootprints(specs: CustomFootprintSpec[] | undefined): string[] {
  custom.clear();
  const warnings: string[] = [];
  for (const s of Array.isArray(specs) ? specs : []) {
    if (!s || typeof s.id !== 'string' || !Array.isArray(s.pads)) continue;
    const id = s.id.trim().replace(/[^A-Za-z0-9_.+\-]/g, '_').slice(0, 60);
    if (!id) continue;
    if (FOOTPRINTS[id]) { warnings.push(`Custom footprint "${id}" has the same name as a library footprint - the library one is used.`); continue; }
    const pads: PadDef[] = [];
    for (const q of s.pads.slice(0, 800)) {
      if (!q) continue;
      const pin = String(q.pin ?? '').trim() || 'MP';
      const type = q.type === 'tht' || q.type === 'npth' ? q.type : 'smd';
      const shape = q.shape === 'circle' || q.shape === 'oval' ? q.shape : 'rect';
      const w = clamp(num(q.w, 1), 0.05, 80), h = clamp(num(q.h, 1), 0.05, 80);
      const pad: PadDef = { pin, x: clamp(num(q.x), -200, 200), y: clamp(num(q.y), -200, 200), w, h, shape: type === 'smd' ? shape : shape === 'rect' ? 'rect' : shape, type };
      const drill = num(q.drill), sw = num(q.slotW), sh = num(q.slotH);
      if (type !== 'smd') {
        if (sw > 0 && sh > 0 && Math.abs(sw - sh) > 1e-3) pad.slot = { w: clamp(sw, 0.2, 80), h: clamp(sh, 0.2, 80) };
        else pad.drill = clamp(drill > 0 ? drill : type === 'npth' ? Math.min(w, h) : Math.min(w, h) * 0.6, 0.2, 40);
      }
      pads.push(pad);
    }
    if (!pads.length) { warnings.push(`Custom footprint "${id}" has no pads and was ignored.`); continue; }
    const real = pads.filter((p) => p.type !== 'npth');
    const aliases: Record<string, string> = {};
    for (const q of s.pads) {
      const nm = String(q?.name ?? '').trim(), pin = String(q?.pin ?? '').trim() || 'MP';
      if (nm && nm !== pin && !(nm in aliases)) aliases[nm] = pin;
    }
    const counts = new Map<string, number>();
    for (const p of real) counts.set(p.pin, (counts.get(p.pin) ?? 0) + 1);
    const bridged = new Set<string>([...counts].filter(([, n]) => n > 1).map(([k]) => k));
    for (const b of Array.isArray(s.bridgedPins) ? s.bridgedPins : []) if (counts.has(String(b))) bridged.add(String(b));
    // pad overlap sanity check
    let overlap = '';
    for (let i = 0; i < real.length && !overlap; i++) for (let j = i + 1; j < real.length; j++) {
      const a = real[i], b = real[j];
      if (a.pin !== b.pin && Math.abs(a.x - b.x) < (a.w + b.w) / 2 - 1e-6 && Math.abs(a.y - b.y) < (a.h + b.h) / 2 - 1e-6) { overlap = `${a.pin}/${b.pin}`; break; }
    }
    if (overlap) warnings.push(`Custom footprint "${id}": pads ${overlap} overlap - check the land pattern.`);
    let hx = 0, hy = 0;
    for (const p of pads) { hx = Math.max(hx, Math.abs(p.x) + p.w / 2); hy = Math.max(hy, Math.abs(p.y) + p.h / 2); }
    const bw = clamp(num(s.bodyW) || hx * 2, 0.2, 200), bh = clamp(num(s.bodyH) || hy * 2, 0.2, 200);
    const kind: BodyKind = (['box', 'ic', 'qfn', 'cylinder', 'module'] as const).includes(s.bodyKind) ? s.bodyKind : 'box';
    const colorM = /^#?([0-9a-f]{6})$/i.exec(String(s.bodyColor ?? '').trim());
    const def: FootprintDef = {
      id, mount: s.mount === 'tht' || pads.some((p) => p.type === 'tht') ? 'tht' : 'smd', approx: true, pads,
      description: `AI-created footprint${s.description ? `: ${s.description}` : ''}`,
      body: { w: bw, h: bh, z: clamp(num(s.bodyZ, 2), 0, 60), kind, ...(colorM ? { color: parseInt(colorM[1], 16) } : {}) },
      courtyard: { w: Math.max(num(s.courtyardW), hx * 2 + 0.5, bw + 0.3), h: Math.max(num(s.courtyardH), hy * 2 + 0.5, bh + 0.3) },
      pinCount: new Set(real.map((p) => p.pin)).size,
    };
    if (s.edge === 'top' || s.edge === 'bottom') def.edge = s.edge;
    if (Object.keys(aliases).length) def.aliases = aliases;
    if (bridged.size) def.bridgedPins = [...bridged];
    custom.set(id, def);
  }
  return warnings;
}


const CATALOG_GROUPS: [RegExp, string][] = [
  [/^PinHeader_1x\d\d$/, '- PinHeader_1x01 .. PinHeader_1x20: male header 1 row, 2.54mm, pins 1..N.'],
  [/^PinHeader_2x\d\d$/, '- PinHeader_2x02 .. PinHeader_2x20: male header 2 rows, 2.54mm, odd pins left/even right, pin 1 top-left. 2x03 = AVR ISP (1=MISO 2=VCC 3=SCK 4=MOSI 5=RESET 6=GND).'],
  [/^PinSocket_1x\d\d$/, '- PinSocket_1x01 .. PinSocket_1x20: female socket 1 row, 2.54mm, pins 1..N (for modules/shields).'],
  [/^PinSocket_2x\d\d$/, '- PinSocket_2x02 .. PinSocket_2x20: female socket 2 rows, 2.54mm, odd pins left/even right. 2x20 = Raspberry Pi GPIO.'],
  [/^JST_PH_\d$/, '- JST_PH_2 .. JST_PH_6: JST PH 2.0mm vertical connector, N pins. LiPo batteries: pin 1 = +, pin 2 = -.'],
  [/^JST_XH_\d$/, '- JST_XH_2 .. JST_XH_4: JST XH 2.5mm vertical connector, N pins.'],
  [/^JST_SH_\d_SMD$/, '- JST_SH_2_SMD .. JST_SH_8_SMD: JST SH 1.0mm side-entry SMD connector (4-pin = Qwiic/STEMMA QT: 1=GND 2=3V3 3=SDA 4=SCL), MP = mounting tabs (GND). [nominal geometry]'],
  [/^TerminalBlock_/, '- TerminalBlock_5.08_2 .. _6, TerminalBlock_3.5_2 .. _6, TerminalBlock_3.81_2 .. _6: screw terminal blocks, pins 1..N, wire entry faces the board edge.'],
  [/^SW_DIP_x\d\d$/, '- SW_DIP_x02 .. SW_DIP_x08: DIP switch with N positions; switch k connects pin k (left) to pin 2N+1-k (right). [nominal geometry]'],
];

/** Compact catalog text for the AI system prompt. */
export function footprintCatalog(): string {
  const lines: string[] = [];
  const done = new Set<string>();
  for (const f of fps) {
    const g = CATALOG_GROUPS.find(([re]) => re.test(f.id));
    if (g) {
      if (g[1] && !done.has(g[1])) { lines.push(g[1]); done.add(g[1]); }
      continue;
    }
    lines.push(`- ${f.id}: ${f.description}${f.approx ? ' [nominal geometry]' : ''}`);
  }
  return lines.join('\n');
}
