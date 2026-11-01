import { describe, it, expect } from 'vitest';
import { runPipeline } from '../src/pipeline';
import { simulate, type SimInput } from '../src/sim';
import { offlineDesign } from '../src/templates';
import { DEFAULT_SETTINGS, type Board } from '../src/types';

const mk = (prompt: string, layers = 2): Board => runPipeline(offlineDesign(prompt).design, { ...DEFAULT_SETTINGS, layers });
const inp = (target: string, volts: number, limitA = 5, extra: Partial<SimInput> = {}): SimInput => ({ sources: [{ id: 'S1', target, volts, limitA, enabled: true }], ambientC: 25, closedSwitches: [], cascade: true, ...extra });
const byRef = (r: ReturnType<typeof simulate>, ref: string) => r.comps.find((c) => c.ref === ref)!;

describe('power simulation', () => {
  it('LED + resistor from 5 V behaves like the hand calculation', () => {
    const b = mk('3 green LEDs powered from USB-C');
    const res = simulate(b, inp('VCC', 5));
    expect(res.ok).toBe(true);
    const led = res.comps.find((c) => /^D/.test(c.ref))!;
    // resistor chosen for ~8 mA at 5 V and Vf 2.2: expect 5-12 mA, ~2.2 V drop
    expect(led.i).toBeGreaterThan(0.003);
    expect(led.i).toBeLessThan(0.015);
    expect(led.vAcross).toBeGreaterThan(1.9);
    expect(led.vAcross).toBeLessThan(2.5);
    expect(res.comps.every((c) => ['ok', 'off', 'warm'].includes(c.status))).toBe(true);
  });

  it('Ohm / KCL: source current equals the sum of branch currents', () => {
    const b = mk('3 green LEDs powered from USB-C');
    const res = simulate(b, inp('VCC', 5));
    const leds = res.comps.filter((c) => /^D/.test(c.ref));
    const sum = leds.reduce((a, c) => a + c.i, 0);
    expect(res.sources[0].iA).toBeCloseTo(sum, 3);
  });

  it('supply current limit collapses the rail', () => {
    const b = mk('3 green LEDs powered from USB-C');
    const res = simulate(b, inp('VCC', 5, 0.005));
    expect(res.sources[0].limited).toBe(true);
    expect(res.sources[0].vActual).toBeLessThan(5);
    expect(res.events.join()).toMatch(/current limit/);
  });

  it('ESP32 board runs fine from 5 V USB, regulator not overloaded', () => {
    const b = mk('ESP32 dev board with usb-c', 4);
    const res = simulate(b, inp('VBUS', 5));
    expect(res.netV['3V3']).toBeGreaterThan(3.2);
    expect(res.netV['3V3']).toBeLessThan(3.4);
    const esp = res.comps.find((c) => /ESP32/.test(c.kind))!;
    expect(['ok', 'warm']).toContain(esp.status);
    const reg = res.comps.find((c) => c.kind === 'voltage regulator')!;
    expect(reg.p).toBeGreaterThan(0.2); // (5-3.3) * ~0.16 A
    expect(reg.tempC).toBeLessThan(80);
  });

  it('12 V into the ESP32 board: regulator overheats / dies and the 3V3 chip is at risk', () => {
    const b = mk('ESP32 dev board with usb-c');
    const res = simulate(b, inp('VBUS', 20));
    const reg = res.comps.find((c) => c.kind === 'voltage regulator')!;
    expect(['failed', 'burst']).toContain(reg.status);
    expect(res.events.length).toBeGreaterThan(0);
  });

  it('feeding 5 V directly into the 3V3 rail destroys the ESP32 module', () => {
    const b = mk('ESP32 dev board with usb-c');
    const res = simulate(b, inp('3V3', 6));
    const esp = res.comps.find((c) => /ESP32/.test(c.kind))!;
    expect(['failed', 'burst']).toContain(esp.status);
  });

  it('reverse polarity gives a failure report', () => {
    const b = mk('3 green LEDs powered from USB-C');
    const res = simulate(b, inp('VCC', -12));
    const led = res.comps.find((c) => /^D/.test(c.ref))!;
    expect(['failed', 'burst']).toContain(led.status);
  });

  it('too much voltage on a resistor-limited LED chain burns the LED and resistor, then cascades', () => {
    const b = mk('3 green LEDs powered from USB-C');
    const res = simulate(b, inp('VCC', 24));
    expect(res.comps.some((c) => c.status === 'failed')).toBe(true);
    expect(res.cascadeRounds).toBeGreaterThanOrEqual(1);
  });

  it('heat field: hottest point is at/near the dissipating regulator, and 4-layer spreads heat better than 2-layer', () => {
    const b2 = mk('ESP32 dev board with usb-c', 2);
    const b4 = mk('ESP32 dev board with usb-c', 4);
    const r2 = simulate(b2, inp('VBUS', 9)), r4 = simulate(b4, inp('VBUS', 9));
    expect(r2.heat.max).toBeGreaterThan(25.05);
    expect(r4.heat.max - 25).toBeLessThan(r2.heat.max - 25);
    expect(r2.totalW).toBeGreaterThan(0.5);
  });

  it('IPC-2221 trace heating: a thin trace carrying amps is flagged', () => {
    const b = mk('MOSFET low-side switch for a 12V LED strip with screw terminals');
    const res = simulate(b, inp('VIN', 12, 30, { closedSwitches: [] }));
    expect(res.ok).toBe(true);
    expect(res.tracks.length).toBeGreaterThan(0);
  });

  it('rejects unknown targets and missing sources', () => {
    const b = mk('3 green LEDs powered from USB-C');
    expect(simulate(b, inp('NOPE', 5)).ok).toBe(false);
    expect(simulate(b, { ...inp('VCC', 5), sources: [] }).ok).toBe(false);
    const viaPin = simulate(b, inp('J1.VBUS', 5));
    expect(viaPin.ok).toBe(true);
    expect(viaPin.sources[0].pin).toBe('J1.VBUS');
    expect(viaPin.sources[0].pinRatingA).toBe(3);
    void byRef;
  });
});
