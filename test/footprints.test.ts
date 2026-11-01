import { describe, it, expect } from 'vitest';
import { FOOTPRINTS, FOOTPRINT_IDS, getFootprint, footprintCatalog, approxFootprints, resolvePin } from '../src/footprints';
import { runPipeline } from '../src/pipeline';
import { runDrc } from '../src/drc';
import { DEFAULT_SETTINGS } from '../src/types';
import type { Design } from '../src/types';

describe('footprint library', () => {
  it('has unique ids and sane pads', () => {
    expect(new Set(FOOTPRINT_IDS).size).toBe(FOOTPRINT_IDS.length);
    expect(FOOTPRINT_IDS.length).toBeGreaterThan(250);
    for (const f of Object.values(FOOTPRINTS)) {
      expect(f.pads.length, f.id).toBeGreaterThan(0);
      for (const p of f.pads) { expect(Number.isFinite(p.x + p.y + p.w + p.h), f.id).toBe(true); expect(p.w, f.id).toBeGreaterThan(0); }
      const real = f.pads.filter((p) => p.type !== 'npth');
      for (const p of real) if (p.type === 'tht') expect(p.drill ?? p.slot, `${f.id} drill`).toBeTruthy();
      expect(f.courtyard.w, f.id).toBeGreaterThan(0);
    }
  });
  it('same-numbered pads never overlap different-numbered pads', () => {
    for (const f of Object.values(FOOTPRINTS)) {
      const ps = f.pads.filter((p) => p.type !== 'npth');
      for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
        const a = ps[i], b = ps[j];
        if (a.pin === b.pin) continue;
        const ox = Math.abs(a.x - b.x) < (a.w + b.w) / 2 - 1e-6, oy = Math.abs(a.y - b.y) < (a.h + b.h) / 2 - 1e-6;
        expect(ox && oy, `${f.id}: pads ${a.pin}/${b.pin} overlap`).toBe(false);
      }
    }
  });
  it('resolves synonyms and aliases', () => {
    expect(getFootprint('QFN-40')?.id).toBe('QFN-40_5x5_P0.4');
    expect(getFootprint('PinSocket_2x20')?.pinCount).toBe(40);
    expect(getFootprint('DPAK')?.id).toBe('TO-252-3');
    expect(resolvePin(FOOTPRINTS['QFN-40_5x5_P0.4'], 'EP')).toBe('41');
    expect(resolvePin(FOOTPRINTS['ESP32-S3-WROOM-1'], 'GPIO19')).toBe('13');
    expect(resolvePin(FOOTPRINTS['RPi_Pico'], 'GP28')).toBe('34');
    expect(FOOTPRINTS['QFN-48_6x6_P0.4'].pinCount).toBe(49);
    expect(FOOTPRINTS['ESP-12F'].pinCount).toBe(22);
  });
  it('catalog stays compact and flags nominal geometry', () => {
    expect(footprintCatalog().length).toBeLessThan(60000);
    expect(approxFootprints(['RPi_Pico', 'R_0603'])).toEqual(['RPi_Pico']);
  });
  it('lays out and routes a board using new parts', () => {
    const d: Design = {
      name: 'Mixed', notes: [], board: { width: 0, height: 0, cornerRadius: 1 },
      components: [
        { ref: 'U1', footprint: 'SOIC-8_EP', value: 'TPS5430', description: '', manufacturer: '', mpn: '', lcsc: '' },
        { ref: 'U2', footprint: 'MSOP-8', value: 'INA219', description: '', manufacturer: '', mpn: '', lcsc: '' },
        { ref: 'C1', footprint: 'CP_Elec_6.3x7.7', value: '100uF', description: '', manufacturer: '', mpn: '', lcsc: '' },
        { ref: 'C2', footprint: 'C_0603', value: '100nF', description: '', manufacturer: '', mpn: '', lcsc: '' },
        { ref: 'C3', footprint: 'C_0603', value: '100nF', description: '', manufacturer: '', mpn: '', lcsc: '' },
        { ref: 'D1', footprint: 'D_SMB', value: 'SS36', description: '', manufacturer: '', mpn: '', lcsc: '' },
        { ref: 'J1', footprint: 'TerminalBlock_5.08_2', value: 'IN', description: '', manufacturer: '', mpn: '', lcsc: '' },
        { ref: 'TP1', footprint: 'TestPoint_Pad_D1.5mm', value: 'TP', description: '', manufacturer: '', mpn: '', lcsc: '' },
      ],
      nets: [
        { name: 'GND', pins: ['J1.2', 'U1.EP', 'U1.4', 'U2.4', 'C1.2', 'C2.2', 'C3.2', 'D1.2'] },
        { name: 'VIN', pins: ['J1.1', 'U1.8', 'C1.1', 'U2.8', 'C2.1', 'C3.1', 'TP1.1'] },
        { name: 'SW', pins: ['U1.1', 'D1.1'] },
      ],
    } as unknown as Design;
    const b = runPipeline(d, DEFAULT_SETTINGS);
    expect(b.comps.length).toBe(8);
    expect(b.tracks.length).toBeGreaterThan(5);
    expect(runDrc(b).filter((x) => x.kind !== 'warning').map((x) => x.msg)).toEqual([]);
  });
});
