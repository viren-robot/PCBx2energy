// Offline "AI": parses the prompt with rules and builds a design from parameterized circuit templates.
// Used when no API key is configured, and as examples/test fixtures.
import type { Design, DesignComponent, DesignLabel } from './types';

// Commonly stocked JLCPCB basic/extended parts. Suggestions only - verify before ordering.
const LCSC: Record<string, string> = {
  'R_0603:10k': 'C25804', 'R_0603:1k': 'C21190', 'R_0603:5.1k': 'C23186', 'R_0603:100k': 'C25803', 'R_0603:330': 'C23138',
  'R_0603:4.7k': 'C23162', 'R_0603:47k': 'C25819', 'R_0603:100': 'C22775', 'R_0603:0': 'C21189', 'R_0603:220': 'C22962', 'R_0603:470': 'C23179',
  'C_0603:100nF': 'C14663', 'C_0603:1uF': 'C15849', 'C_0603:10nF': 'C57112', 'C_0603:22pF': 'C1653', 'C_0603:4.7uF': 'C19666',
  'C_0805:10uF': 'C15850', 'C_0805:22uF': 'C45783',
  'LED_0603:red': 'C2286', 'LED_0603:green': 'C72043', 'LED_0603:blue': 'C72041', 'LED_0603:yellow': 'C72038', 'LED_0603:white': 'C2290',
  'SOT-223:AMS1117-3.3': 'C6186', 'SOIC-8:NE555': 'C7593', 'USB_C_16P:USB-C': 'C165948', 'ESP32-WROOM-32:ESP32-WROOM-32E': 'C701341',
  'LQFP-32:ATmega328P-AU': 'C14877', 'D_SMA:SS34': 'C8678', 'SOT-23:AO3400A': 'C20917', 'SOIC-16:CH340C': 'C84681', 'D_SOD-123:1N4148W': 'C81598',
  'SW_SMD_5.1x5.1:SW': 'C318884', 'Crystal_SMD_3225:16MHz': 'C13738',
};

class Builder {
  comps: DesignComponent[] = [];
  nets = new Map<string, string[]>();
  private counters = new Map<string, number>();
  part(prefix: string, footprint: string, value: string, o: Partial<DesignComponent> = {}): string {
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    const ref = `${prefix}${n}`;
    this.comps.push({
      ref, footprint, value, description: o.description ?? '', manufacturer: o.manufacturer ?? '', mpn: o.mpn ?? '',
      lcsc: o.lcsc ?? LCSC[`${footprint}:${value}`] ?? '',
    });
    return ref;
  }
  connect(net: string, ...pins: string[]) {
    const a = this.nets.get(net) ?? [];
    a.push(...pins);
    this.nets.set(net, a);
  }
  design(name: string, description: string, notes: string[], w = 0, h = 0): Design {
    return {
      name, description,
      board: { width: w, height: h, cornerRadius: 1 },
      components: this.comps,
      nets: [...this.nets.entries()].map(([name, pins]) => ({ name, pins })),
      notes,
    };
  }
}

function usbC(b: Builder, net5v = 'VBUS') {
  const j = b.part('J', 'USB_C_16P', 'USB-C', { description: 'USB Type-C receptacle (power)', manufacturer: 'Korean Hroparts Elec', mpn: 'TYPE-C-31-M-12' });
  const r1 = b.part('R', 'R_0603', '5.1k', { description: 'CC1 pull-down (5V sink)' });
  const r2 = b.part('R', 'R_0603', '5.1k', { description: 'CC2 pull-down (5V sink)' });
  b.connect(net5v, `${j}.VBUS`);
  b.connect('GND', `${j}.GND`, `${j}.SHIELD`, `${r1}.2`, `${r2}.2`);
  b.connect('CC1', `${j}.CC1`, `${r1}.1`);
  b.connect('CC2', `${j}.CC2`, `${r2}.1`);
  return j;
}

function powerIn(b: Builder, kind: string, net: string) {
  if (kind === 'usbc') return usbC(b, net);
  if (kind === 'battery') {
    const j = b.part('J', 'JST_PH_2', 'JST-PH 2P', { description: 'Battery connector (+, -)', manufacturer: 'JST', mpn: 'B2B-PH-K-S', lcsc: 'C131337' });
    b.connect(net, `${j}.1`);
    b.connect('GND', `${j}.2`);
    return j;
  }
  if (kind === 'terminal') {
    const j = b.part('J', 'TerminalBlock_5.08_2', 'Screw terminal 2P', { description: 'Power input (+, -)' });
    b.connect(net, `${j}.1`);
    b.connect('GND', `${j}.2`);
    return j;
  }
  const j = b.part('J', 'PinHeader_1x02', 'Header 1x02', { description: 'Power input (+, GND)' });
  b.connect(net, `${j}.1`);
  b.connect('GND', `${j}.2`);
  return j;
}

function mountingHoles(b: Builder) {
  for (let i = 0; i < 4; i++) b.part('H', 'MountingHole_3.2mm_M3', 'M3 hole', { lcsc: '' });
}

export interface ParsedPrompt {
  ledCount: number;
  color: string;
  supply: 'usbc' | 'battery' | 'header' | 'terminal';
  holes: boolean;
  width: number;
  height: number;
  voltage: number;
}

export function parsePrompt(p: string): ParsedPrompt {
  const t = p.toLowerCase();
  const ledM = t.match(/(\d+)\s*(x\s*)?(?:\w+\s+)?leds?/);
  const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const ledW = t.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:\w+\s+)?leds?/);
  const color = (t.match(/\b(red|green|blue|yellow|white)\b/) ?? [, 'red'])[1]!;
  const size = t.match(/(\d+(?:\.\d+)?)\s*(?:mm)?\s*[x×*]\s*(\d+(?:\.\d+)?)\s*mm/);
  const volt = t.match(/(\d+(?:\.\d+)?)\s*v\b/);
  return {
    ledCount: Math.min(16, Math.max(1, ledM ? +ledM[1] : ledW ? words[ledW[1]] : 1)),
    color,
    supply: /usb/.test(t) ? 'usbc' : /lipo|battery|batt|li-ion|18650/.test(t) ? 'battery' : /terminal|screw/.test(t) ? 'terminal' : 'header',
    holes: /mount|hole|screw hole/.test(t),
    width: size ? +size[1] : 0,
    height: size ? +size[2] : 0,
    voltage: volt ? +volt[1] : 5,
  };
}

export function ledBoard(o: ParsedPrompt): Design {
  const b = new Builder();
  powerIn(b, o.supply, 'VCC');
  const vf: Record<string, number> = { red: 2.0, yellow: 2.1, green: 2.2, blue: 3.0, white: 3.0 };
  const supplyV = o.supply === 'usbc' ? 5 : o.supply === 'battery' ? 3.7 : o.voltage;
  const rIdeal = Math.max(10, ((supplyV - vf[o.color]) / 0.008));
  const e12 = [10, 12, 15, 18, 22, 27, 33, 39, 47, 56, 68, 82];
  let r = 1000;
  for (let dec = 1; dec <= 10000; dec *= 10) for (const e of e12) { const v = e * dec; if (v >= rIdeal && v < r) r = v; }
  const rStr = r >= 1000 ? `${r / 1000}k` : `${r}`;
  for (let i = 0; i < o.ledCount; i++) {
    const rr = b.part('R', 'R_0603', rStr, { description: `LED current limit (~${(((supplyV - vf[o.color]) / r) * 1000).toFixed(1)} mA)` });
    const d = b.part('D', 'LED_0603', o.color, { description: `${o.color} LED` });
    b.connect('VCC', `${rr}.1`);
    b.connect(`LED${i + 1}`, `${rr}.2`, `${d}.A`);
    b.connect('GND', `${d}.K`);
  }
  if (o.holes) mountingHoles(b);
  return b.design(`${o.ledCount}x ${o.color} LED board`, `${o.ledCount} ${o.color} LEDs with series resistors, powered from ${o.supply}.`,
    [`Series resistor ${rStr} sized for ~8 mA at ${supplyV} V.`], o.width, o.height);
}

export function blinker555(o: ParsedPrompt): Design {
  const b = new Builder();
  powerIn(b, o.supply, 'VCC');
  const u = b.part('U', 'SOIC-8', 'NE555', { description: 'Timer IC', manufacturer: 'Texas Instruments', mpn: 'NE555DR' });
  const r1 = b.part('R', 'R_0603', '1k', { description: 'Timing RA' });
  const r2 = b.part('R', 'R_0603', '47k', { description: 'Timing RB' });
  const c1 = b.part('C', 'C_0805', '10uF', { description: 'Timing capacitor' });
  const c2 = b.part('C', 'C_0603', '10nF', { description: 'CTRL bypass' });
  const c3 = b.part('C', 'C_0603', '100nF', { description: 'VCC decoupling' });
  const r3 = b.part('R', 'R_0603', '330', { description: 'LED resistor' });
  const d1 = b.part('D', 'LED_0603', o.color, { description: 'Blinking LED' });
  b.connect('VCC', `${u}.8`, `${u}.4`, `${r1}.1`, `${c3}.1`);
  b.connect('GND', `${u}.1`, `${c1}.2`, `${c2}.2`, `${c3}.2`, `${d1}.K`);
  b.connect('DIS', `${u}.7`, `${r1}.2`, `${r2}.1`);
  b.connect('THR', `${u}.6`, `${u}.2`, `${r2}.2`, `${c1}.1`);
  b.connect('CTRL', `${u}.5`, `${c2}.1`);
  b.connect('OUT', `${u}.3`, `${r3}.1`);
  b.connect('LED_A', `${r3}.2`, `${d1}.A`);
  if (o.holes) mountingHoles(b);
  return b.design('555 LED blinker', 'NE555 astable LED blinker (~1.5 Hz).', ['f = 1.44 / ((R1 + 2*R2) * C1) = ~1.5 Hz.'], o.width, o.height);
}

export function esp32Board(o: ParsedPrompt): Design {
  const b = new Builder();
  usbC(b, 'VBUS');
  const reg = b.part('U', 'SOT-223', 'AMS1117-3.3', { description: '3.3 V LDO', manufacturer: 'Advanced Monolithic Systems', mpn: 'AMS1117-3.3' });
  const mcu = b.part('U', 'ESP32-WROOM-32', 'ESP32-WROOM-32E', { description: 'Wi-Fi/BT MCU module', manufacturer: 'Espressif', mpn: 'ESP32-WROOM-32E-N4' });
  const cin = b.part('C', 'C_0805', '10uF', { description: 'LDO input' });
  const cout = b.part('C', 'C_0805', '22uF', { description: 'LDO output' });
  const cd = b.part('C', 'C_0603', '100nF', { description: 'ESP32 decoupling' });
  const ren = b.part('R', 'R_0603', '10k', { description: 'EN pull-up' });
  const cen = b.part('C', 'C_0603', '1uF', { description: 'EN RC delay' });
  const rb = b.part('R', 'R_0603', '10k', { description: 'IO0 pull-up' });
  const swr = b.part('SW', 'SW_SMD_5.1x5.1', 'SW', { description: 'RESET (EN) button' });
  const swb = b.part('SW', 'SW_SMD_5.1x5.1', 'SW', { description: 'BOOT (IO0) button' });
  const rl = b.part('R', 'R_0603', '1k', { description: 'Status LED resistor' });
  const dl = b.part('D', 'LED_0603', o.color, { description: 'Status LED on IO2' });
  const jp = b.part('J', 'PinHeader_1x06', 'Header 1x06', { description: 'Programming: 3V3, GND, TX, RX, EN, IO0' });
  const jio = b.part('J', 'PinHeader_1x08', 'Header 1x08', { description: 'GPIO breakout' });
  b.connect('VBUS', `${reg}.VIN`, `${cin}.1`);
  b.connect('3V3', `${reg}.VOUT`, `${cout}.1`, `${mcu}.3V3`, `${cd}.1`, `${ren}.1`, `${rb}.1`, `${jp}.1`, `${jio}.1`);
  b.connect('GND', `${reg}.GND`, `${cin}.2`, `${cout}.2`, `${mcu}.GND`, `${cd}.2`, `${cen}.2`, `${swr}.2`, `${swb}.2`, `${dl}.K`, `${jp}.2`, `${jio}.8`);
  b.connect('EN', `${mcu}.EN`, `${ren}.2`, `${cen}.1`, `${swr}.1`, `${jp}.5`);
  b.connect('IO0', `${mcu}.IO0`, `${rb}.2`, `${swb}.1`, `${jp}.6`);
  b.connect('TXD0', `${mcu}.TXD0`, `${jp}.3`);
  b.connect('RXD0', `${mcu}.RXD0`, `${jp}.4`);
  b.connect('IO2', `${mcu}.IO2`, `${rl}.1`);
  b.connect('LED_A', `${rl}.2`, `${dl}.A`);
  ['IO4', 'IO5', 'IO18', 'IO19', 'IO21', 'IO22'].forEach((io, i) => b.connect(io, `${mcu}.${io}`, `${jio}.${i + 2}`));
  if (o.holes) mountingHoles(b);
  return b.design('ESP32 dev board', 'ESP32-WROOM-32E board with USB-C power, AMS1117 3.3 V LDO, reset/boot buttons, status LED and headers.',
    ['Program through J (TX/RX) with an external 3.3 V USB-UART adapter; hold BOOT while pressing RESET to enter the bootloader.'], o.width, o.height);
}

export function atmegaBoard(o: ParsedPrompt): Design {
  const b = new Builder();
  powerIn(b, o.supply === 'header' ? 'usbc' : o.supply, 'VCC');
  const u = b.part('U', 'LQFP-32', 'ATmega328P-AU', { description: '8-bit AVR MCU', manufacturer: 'Microchip', mpn: 'ATMEGA328P-AU' });
  const y = b.part('Y', 'Crystal_SMD_3225', '16MHz', { description: '16 MHz crystal' });
  const c1 = b.part('C', 'C_0603', '22pF', { description: 'Crystal load' });
  const c2 = b.part('C', 'C_0603', '22pF', { description: 'Crystal load' });
  const c3 = b.part('C', 'C_0603', '100nF', { description: 'VCC decoupling' });
  const c4 = b.part('C', 'C_0603', '100nF', { description: 'VCC decoupling' });
  const c5 = b.part('C', 'C_0603', '100nF', { description: 'AVCC decoupling' });
  const c6 = b.part('C', 'C_0805', '10uF', { description: 'Bulk' });
  const rr = b.part('R', 'R_0603', '10k', { description: 'RESET pull-up' });
  const sw = b.part('SW', 'SW_SMD_5.1x5.1', 'SW', { description: 'Reset button' });
  const isp = b.part('J', 'PinHeader_2x03', 'AVR-ISP-6', { description: 'ISP programming header' });
  const rl = b.part('R', 'R_0603', '1k', { description: 'LED resistor' });
  const dl = b.part('D', 'LED_0603', o.color, { description: 'LED on PB5 (D13)' });
  const jio = b.part('J', 'PinHeader_1x08', 'Header 1x08', { description: 'IO breakout PD0-PD7' });
  b.connect('VCC', `${u}.4`, `${u}.6`, `${u}.18`, `${u}.20`, `${c3}.1`, `${c4}.1`, `${c5}.1`, `${c6}.1`, `${rr}.1`, `${isp}.2`);
  b.connect('GND', `${u}.3`, `${u}.5`, `${u}.21`, `${c1}.2`, `${c2}.2`, `${c3}.2`, `${c4}.2`, `${c5}.2`, `${c6}.2`, `${sw}.2`, `${isp}.6`, `${dl}.K`, `${y}.2`, `${y}.4`);
  b.connect('XTAL1', `${u}.7`, `${y}.1`, `${c1}.1`);
  b.connect('XTAL2', `${u}.8`, `${y}.3`, `${c2}.1`);
  b.connect('RESET', `${u}.29`, `${rr}.2`, `${sw}.1`, `${isp}.5`);
  b.connect('MOSI', `${u}.15`, `${isp}.4`);
  b.connect('MISO', `${u}.16`, `${isp}.1`);
  b.connect('SCK', `${u}.17`, `${isp}.3`, `${rl}.1`);
  b.connect('LED_A', `${rl}.2`, `${dl}.A`);
  const pd = [30, 31, 32, 1, 2, 9, 10, 11];
  pd.forEach((pin, i) => b.connect(`PD${i}`, `${u}.${pin}`, `${jio}.${i + 1}`));
  if (o.holes) mountingHoles(b);
  return b.design('ATmega328P minimal board', 'Arduino-compatible ATmega328P-AU with 16 MHz crystal, ISP header, reset button and LED on D13.',
    ['Flash an Arduino bootloader via the ISP header (e.g. USBasp).'], o.width, o.height);
}

export function ldoBoard(o: ParsedPrompt): Design {
  const b = new Builder();
  powerIn(b, o.supply === 'header' ? 'terminal' : o.supply, 'VIN');
  const u = b.part('U', 'SOT-223', 'AMS1117-3.3', { description: '3.3 V 1 A LDO', manufacturer: 'Advanced Monolithic Systems', mpn: 'AMS1117-3.3' });
  const c1 = b.part('C', 'C_0805', '10uF', { description: 'Input cap' });
  const c2 = b.part('C', 'C_0805', '22uF', { description: 'Output cap' });
  const c3 = b.part('C', 'C_0603', '100nF', { description: 'Output HF cap' });
  const r = b.part('R', 'R_0603', '1k', { description: 'Power LED resistor' });
  const d = b.part('D', 'LED_0603', o.color, { description: 'Power LED' });
  const j = b.part('J', 'PinHeader_1x02', 'Header 1x02', { description: '3V3 output' });
  b.connect('VIN', `${u}.VIN`, `${c1}.1`);
  b.connect('3V3', `${u}.VOUT`, `${c2}.1`, `${c3}.1`, `${r}.1`, `${j}.1`);
  b.connect('GND', `${u}.GND`, `${c1}.2`, `${c2}.2`, `${c3}.2`, `${d}.K`, `${j}.2`);
  b.connect('LED_A', `${r}.2`, `${d}.A`);
  if (o.holes) mountingHoles(b);
  return b.design('3.3V LDO regulator', 'AMS1117-3.3 regulator breakout with power LED.', ['Input 4.5-12 V; mind LDO dissipation (Vin-3.3)*I.'], o.width, o.height);
}

export function mosfetBoard(o: ParsedPrompt): Design {
  const b = new Builder();
  const jp = b.part('J', 'TerminalBlock_5.08_2', 'Screw terminal 2P', { description: 'Power in (+, -)' });
  const jl = b.part('J', 'TerminalBlock_5.08_2', 'Screw terminal 2P', { description: 'Load (+, -)' });
  const js = b.part('J', 'PinHeader_1x02', 'Header 1x02', { description: 'Logic input (SIG, GND)' });
  const q = b.part('Q', 'SOT-23', 'AO3400A', { description: 'N-MOSFET 30V 5.7A logic-level', manufacturer: 'Alpha & Omega', mpn: 'AO3400A' });
  const rg = b.part('R', 'R_0603', '100', { description: 'Gate resistor' });
  const rpd = b.part('R', 'R_0603', '10k', { description: 'Gate pull-down' });
  const d = b.part('D', 'D_SMA', 'SS34', { description: 'Flyback diode', mpn: 'SS34' });
  const rl = b.part('R', 'R_0603', '1k', { description: 'Indicator resistor' });
  const dl = b.part('D', 'LED_0603', o.color, { description: 'ON indicator' });
  b.connect('VIN', `${jp}.1`, `${jl}.1`, `${d}.K`);
  b.connect('GND', `${jp}.2`, `${js}.2`, `${q}.S`, `${rpd}.2`, `${dl}.K`);
  b.connect('LOAD-', `${jl}.2`, `${q}.D`, `${d}.A`);
  b.connect('SIG', `${js}.1`, `${rg}.1`, `${rl}.1`);
  b.connect('GATE', `${rg}.2`, `${q}.G`, `${rpd}.1`);
  b.connect('LED_A', `${rl}.2`, `${dl}.A`);
  if (o.holes) mountingHoles(b);
  return b.design('MOSFET load switch', 'Low-side N-MOSFET switch for motors/LED strips/solenoids with flyback diode.', ['AO3400A: keep load current below ~3 A without extra copper.'], o.width, o.height);
}

export function usbUartBoard(o: ParsedPrompt): Design {
  const b = new Builder();
  usbC(b, 'VBUS');
  const u = b.part('U', 'SOIC-16', 'CH340C', { description: 'USB to UART bridge (internal oscillator)', manufacturer: 'WCH', mpn: 'CH340C' });
  const c1 = b.part('C', 'C_0603', '100nF', { description: 'VCC decoupling' });
  const c2 = b.part('C', 'C_0603', '100nF', { description: 'V3 decoupling' });
  const j = b.part('J', 'PinHeader_1x06', 'Header 1x06', { description: 'GND, CTS, VCC, TXD, RXD, DTR (FTDI order)' });
  const r = b.part('R', 'R_0603', '1k', { description: 'Power LED resistor' });
  const d = b.part('D', 'LED_0603', o.color, { description: 'Power LED' });
  b.connect('VBUS', `${u}.16`, `${c1}.1`, `${j}.3`, `${r}.1`);
  b.connect('GND', `${u}.1`, `${c1}.2`, `${c2}.2`, `${j}.1`, `${d}.K`);
  b.connect('V3', `${u}.4`, `${c2}.1`);
  b.connect('D+', `${u}.5`, 'J1.D+');
  b.connect('D-', `${u}.6`, 'J1.D-');
  b.connect('TXD', `${u}.2`, `${j}.5`);
  b.connect('RXD', `${u}.3`, `${j}.4`);
  b.connect('CTS', `${u}.9`, `${j}.2`);
  b.connect('DTR', `${u}.13`, `${j}.6`);
  b.connect('LED_A', `${r}.2`, `${d}.A`);
  if (o.holes) mountingHoles(b);
  return b.design('USB-C to UART (CH340C)', 'CH340C USB-serial adapter with FTDI-style header, 5 V logic.', ['TXD/RXD are named from the CH340 side; cross them to your target.'], o.width, o.height);
}

export const EXAMPLES: { label: string; prompt: string }[] = [
  { label: 'LED board', prompt: '4 blue LEDs powered from USB-C, with mounting holes' },
  { label: '555 blinker', prompt: 'NE555 LED blinker running from a 2-pin header, red LED' },
  { label: 'ESP32 dev board', prompt: 'ESP32 dev board with USB-C power, 3.3V regulator, reset and boot buttons, status LED and GPIO headers' },
  { label: 'ATmega328P', prompt: 'Arduino compatible ATmega328P board with 16MHz crystal, ISP header and LED, USB-C power' },
  { label: '3.3V LDO', prompt: '3.3V LDO regulator breakout with screw terminal input and power LED' },
  { label: 'MOSFET switch', prompt: 'MOSFET low-side switch for a 12V LED strip with screw terminals' },
  { label: 'USB-UART', prompt: 'USB-C to UART adapter with CH340C and FTDI header' },
];

function offlineDesignRaw(prompt: string): { design: Design; matched: string } {
  const t = prompt.toLowerCase();
  const o = parsePrompt(prompt);
  if (/esp32|wifi|wi-fi|bluetooth/.test(t)) return { design: esp32Board(o), matched: 'ESP32 dev board' };
  if (/atmega|arduino|avr|328/.test(t)) return { design: atmegaBoard(o), matched: 'ATmega328P board' };
  if (/555|blink|flash|timer/.test(t)) return { design: blinker555(o), matched: '555 blinker' };
  if (/ch340|uart|serial|usb.?to.?ttl/.test(t)) return { design: usbUartBoard(o), matched: 'USB-UART adapter' };
  if (/mosfet|motor|switch|relay|strip|solenoid/.test(t)) return { design: mosfetBoard(o), matched: 'MOSFET load switch' };
  if (/regulator|ldo|3\.3|3v3|ams1117|power supply/.test(t)) return { design: ldoBoard(o), matched: '3.3V LDO' };
  return { design: ledBoard(o), matched: 'LED board' };
}

/** Silkscreen/schematic labels derived from nets and part descriptions (offline equivalent of the AI's labelling). */
export function autoLabels(d: Design): DesignLabel[] {
  const out: DesignLabel[] = [];
  const byRef = new Map(d.components.map((c) => [c.ref, c]));
  const short = (n: string) => n.replace(/^LED_?.*/i, '').replace(/^VBUS$/i, 'VBUS').toUpperCase().slice(0, 8);
  for (const net of d.nets) {
    for (const pin of net.pins) {
      const m = pin.match(/^([^.]+)\.(.+)$/);
      if (!m) continue;
      const c = byRef.get(m[1]);
      if (!c || !/^(PinHeader|JST|TerminalBlock)/.test(c.footprint)) continue;
      const t = short(net.name);
      if (t) out.push({ ref: c.ref, text: t, pin: m[2] });
    }
  }
  for (const c of d.components) {
    const t = `${c.value} ${c.description}`.toLowerCase();
    if (c.footprint === 'USB_C_16P') out.push({ ref: c.ref, text: 'USB-C' });
    else if (/^SW_/.test(c.footprint)) out.push({ ref: c.ref, text: /boot/.test(t) ? 'BOOT' : /reset|rst/.test(t) ? 'RST' : 'BTN' });
    else if (/^LED_/.test(c.footprint)) out.push({ ref: c.ref, text: /power|pwr/.test(t) ? 'PWR' : /status|io|blink|d13/.test(t) ? 'STAT' : 'LED' });
  }
  return out;
}

export function offlineDesign(prompt: string): { design: Design; matched: string } {
  const r = offlineDesignRaw(prompt);
  r.design.labels = autoLabels(r.design);
  return r;
}
