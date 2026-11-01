// Footprint library. Pad geometry follows KiCad / IPC-7351 nominal land patterns, with the
// footprint origin at the body centre and the same visual orientation as KiCad (pin 1 top-left
// for ICs), converted to a +Y-up frame. This keeps JLCPCB rotation corrections valid.
import type { FootprintDef, PadDef, BodyKind } from './types';

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

export const FOOTPRINTS: Record<string, FootprintDef> = Object.fromEntries(fps.map((f) => [f.id, f]));
export const FOOTPRINT_IDS = fps.map((f) => f.id);

export function getFootprint(id: string): FootprintDef | undefined {
  if (FOOTPRINTS[id]) return FOOTPRINTS[id];
  const norm = id.replace(/\s+/g, '').toLowerCase();
  const f = fps.find((x) => x.id.toLowerCase() === norm);
  if (f) return f;
  // common forms: "0603 resistor", "R0603", "PinHeader_1x4"
  const m = norm.match(/pinheader_?([12])x0?(\d+)/);
  if (m) return FOOTPRINTS[`PinHeader_${m[1]}x${m[2].padStart(2, '0')}`];
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

/** Compact catalog text for the AI system prompt. */
export function footprintCatalog(): string {
  const lines: string[] = [];
  const seenHeaders = { h1: false, h2: false };
  for (const f of fps) {
    if (f.id.startsWith('PinHeader_1x')) {
      if (!seenHeaders.h1) lines.push('- PinHeader_1x01 .. PinHeader_1x20: male header 1 row, 2.54mm, pins 1..N.');
      seenHeaders.h1 = true;
      continue;
    }
    if (f.id.startsWith('PinHeader_2x')) {
      if (!seenHeaders.h2) lines.push('- PinHeader_2x02 .. PinHeader_2x20: male header 2 rows, 2.54mm, odd pins left/even right, pin 1 top-left. 2x03 = AVR ISP (1=MISO 2=VCC 3=SCK 4=MOSI 5=RESET 6=GND).');
      seenHeaders.h2 = true;
      continue;
    }
    lines.push(`- ${f.id}: ${f.description}`);
  }
  return lines.join('\n');
}
