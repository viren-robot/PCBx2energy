import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { runPipeline } from '../src/pipeline';
import { buildSchematic, schematicDownload } from '../src/schematic';
import { offlineDesign } from '../src/templates';
import { buildSilk } from '../src/silk';
import { DEFAULT_SETTINGS } from '../src/types';

describe('schematic + labels from board', () => {
  it('ESP32 board: symbols for every part, nets labelled, labels on silkscreen', () => {
    const { design } = offlineDesign('ESP32 dev board with usb-c');
    expect(design.labels!.length).toBeGreaterThan(5);
    const b = runPipeline(design, DEFAULT_SETTINGS);
    const sch = buildSchematic(b);
    expect(sch.symbols).toBe(b.comps.filter((c) => c.fp.body.kind !== 'hole').length);
    expect(sch.svg).toContain('data-net');
    expect(sch.svg).toContain('ESP32-WROOM-32E');
    expect(sch.svg).toContain('TXD0');
    expect(sch.svg.startsWith('<svg')).toBe(true);
    const silk = buildSilk(b);
    const labelTexts = silk.texts.filter((t) => t.ref === 'label').map((t) => t.text);
    expect(labelTexts.length).toBeGreaterThan(3);
    mkdirSync('test/out/sch', { recursive: true });
    writeFileSync('test/out/sch/esp32.svg', schematicDownload(sch, false));
    writeFileSync('test/out/sch/esp32-dark.svg', schematicDownload(sch, true));
  });
  it('LED board has resistor/LED symbols', () => {
    const b = runPipeline(offlineDesign('3 green leds usb').design, DEFAULT_SETTINGS);
    const sch = buildSchematic(b);
    expect(sch.svg).toContain('sch-body');
    expect(sch.symbols).toBe(b.comps.length);
  });
});
