import { describe, it, expect } from 'vitest';
import { parseStyle, isStyleOnly } from '../src/style';
import { runErc, autoFixErc } from '../src/erc';
import { offlineDesign } from '../src/templates';

describe('style parser', () => {
  it('parses colours', () => {
    expect(parseStyle('make the PCB matte black').maskColor).toBe('#141414');
    expect(parseStyle('change board colour to purple with white silkscreen')).toMatchObject({ maskColor: '#5b2a86', silkColor: '#f2f2ee' });
    expect(parseStyle('make the pcb blue and use gold finish')).toMatchObject({ maskColor: '#1d4f9c', finish: 'ENIG' });
    expect(parseStyle('make the solder mask #ff8800').maskColor).toBe('#ff8800');
    expect(parseStyle('add a resistor')).toEqual({});
  });
  it('detects cosmetic-only requests', () => {
    expect(isStyleOnly('make the PCB red')).toBe(true);
    expect(isStyleOnly('make the pcb red and add a usb port')).toBe(false);
    expect(isStyleOnly('ESP32 board in black')).toBe(false);
  });
});

describe('ERC', () => {
  it('template designs have no ERC errors', () => {
    for (const p of ['4 blue LEDs usb-c', 'esp32 dev board', 'atmega328p board', 'ldo regulator', 'mosfet switch', 'ch340 uart', '555 blinker']) {
      const errs = runErc(offlineDesign(p).design).filter((i) => i.severity === 'error');
      expect(errs, p).toEqual([]);
    }
  });
  it('flags and fixes a missing decoupling cap, flags LED without resistor', () => {
    const d = offlineDesign('555 blinker').design;
    d.components = d.components.filter((c) => c.value !== '100nF');
    d.nets.forEach((n) => (n.pins = n.pins.filter((p) => !/^C3\./.test(p))));
    expect(runErc(d).some((i) => /decoupling/.test(i.msg))).toBe(true);
    const fixed = autoFixErc(d);
    expect(fixed.fixes.length).toBeGreaterThan(0);
    expect(runErc(fixed.design).some((i) => /decoupling/.test(i.msg))).toBe(false);
    const led = offlineDesign('4 blue LEDs').design;
    led.components = led.components.filter((c) => !c.ref.startsWith('R'));
    expect(runErc(led).some((i) => /series resistor/.test(i.msg))).toBe(true);
  });
});
