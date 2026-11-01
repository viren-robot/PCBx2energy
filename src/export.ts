// Fab-specific packaging: Gerber/drill naming, BOM and pick-and-place formats, ZIP bundles.
import JSZip from 'jszip';
import { buildLayers, excellon } from './gerber';
import type { Board, FabId, PlacedComponent } from './types';

export interface FabProfile {
  id: FabId;
  name: string;
  url: string;
  assembly: boolean;
  defaultMask: string;
  maskName: string;
  notes: string[];
}

export const FABS: Record<FabId, FabProfile> = {
  jlcpcb: {
    id: 'jlcpcb', name: 'JLCPCB', url: 'https://cart.jlcpcb.com/quote', assembly: true,
    defaultMask: '#1f7a3a', maskName: 'Green',
    notes: [
      'Upload the *_gerbers_JLCPCB.zip on the quote page (detected automatically).',
      'For SMT assembly, enable "PCB Assembly" and upload BOM_JLCPCB.csv and CPL_JLCPCB.csv.',
      'Rotations in the CPL already include the common JLCPCB corrections; still check the 3D preview on the JLCPCB site before ordering.',
      'Parts without an LCSC number will be reported as missing - pick them in the JLCPCB part matcher.',
    ],
  },
  pcbway: {
    id: 'pcbway', name: 'PCBWay', url: 'https://www.pcbway.com/QuickOrderOnline.aspx', assembly: true,
    defaultMask: '#1f7a3a', maskName: 'Green',
    notes: [
      'Upload *_gerbers_PCBWay.zip under "Quick-order PCB".',
      'For assembly ("PCB Assembly" service) attach BOM_PCBWay.csv and Centroid_PCBWay.csv.',
      'PCBWay sources parts by Manufacturer + MPN; fill these columns for best results.',
    ],
  },
  oshpark: {
    id: 'oshpark', name: 'OSH Park', url: 'https://oshpark.com/', assembly: false,
    defaultMask: '#5b2a86', maskName: 'Purple (After Dark / standard)',
    notes: [
      'Upload *_gerbers_OSHPark.zip directly at oshpark.com.',
      'OSH Park uses a single drill file (.XLN); non-plated holes in it will be plated.',
      'OSH Park does not assemble boards: BOM.csv and PnP.csv are provided for hand assembly or a third-party assembler.',
    ],
  },
};

export interface OutFile { name: string; content: string | Uint8Array; mime: string }

const csvCell = (v: string | number) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (rows: (string | number)[][]) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
const mm = (v: number) => v.toFixed(4);
const safeName = (s: string) => (s || 'board').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'board';

function assemblable(c: PlacedComponent) {
  return c.fp.body.kind !== 'hole';
}

interface BomLine { refs: string[]; comp: PlacedComponent['comp']; fp: PlacedComponent['fp'] }
export function bomLines(board: Board): BomLine[] {
  const m = new Map<string, BomLine>();
  for (const c of board.comps) {
    if (!assemblable(c)) continue;
    const key = [c.comp.value, c.fp.id, c.comp.lcsc, c.comp.mpn].join('|');
    const l = m.get(key);
    if (l) l.refs.push(c.ref); else m.set(key, { refs: [c.ref], comp: c.comp, fp: c.fp });
  }
  const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
  const lines = [...m.values()];
  lines.forEach((l) => l.refs.sort(natural));
  return lines.sort((a, b) => natural(a.refs[0], b.refs[0]));
}

const jlcRot = (c: PlacedComponent) => (((c.rot + (c.fp.jlcRotation ?? 0)) % 360) + 360) % 360;

export function makeBom(board: Board, fab: FabId): OutFile {
  const lines = bomLines(board);
  if (fab === 'jlcpcb') {
    return {
      name: 'BOM_JLCPCB.csv', mime: 'text/csv',
      content: csv([['Comment', 'Designator', 'Footprint', 'LCSC Part #'], ...lines.map((l) => [l.comp.value, l.refs.join(','), l.fp.id, l.comp.lcsc])]),
    };
  }
  if (fab === 'pcbway') {
    return {
      name: 'BOM_PCBWay.csv', mime: 'text/csv',
      content: csv([
        ['Item #', 'Designator', 'Qty', 'Manufacturer', 'Mfg Part #', 'Description / Value', 'Package/Footprint', 'Type', 'Your Instructions / Notes'],
        ...lines.map((l, i) => [i + 1, l.refs.join(','), l.refs.length, l.comp.manufacturer, l.comp.mpn, `${l.comp.value}${l.comp.description ? ` - ${l.comp.description}` : ''}`, l.fp.id, l.fp.mount === 'smd' ? 'SMD' : 'THT', l.comp.lcsc ? `LCSC ${l.comp.lcsc}` : '']),
      ]),
    };
  }
  return {
    name: 'BOM.csv', mime: 'text/csv',
    content: csv([
      ['Reference', 'Qty', 'Value', 'Footprint', 'Manufacturer', 'MPN', 'LCSC', 'Description'],
      ...lines.map((l) => [l.refs.join(','), l.refs.length, l.comp.value, l.fp.id, l.comp.manufacturer, l.comp.mpn, l.comp.lcsc, l.comp.description]),
    ]),
  };
}

export function makePnp(board: Board, fab: FabId): OutFile {
  const comps = board.comps.filter(assemblable).sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }));
  if (fab === 'jlcpcb') {
    return {
      name: 'CPL_JLCPCB.csv', mime: 'text/csv',
      content: csv([['Designator', 'Mid X', 'Mid Y', 'Layer', 'Rotation'], ...comps.map((c) => [c.ref, `${mm(c.x)}mm`, `${mm(c.y)}mm`, 'Top', jlcRot(c)])]),
    };
  }
  if (fab === 'pcbway') {
    return {
      name: 'Centroid_PCBWay.csv', mime: 'text/csv',
      content: csv([
        ['Designator', 'Footprint', 'Mid X', 'Mid Y', 'Ref X', 'Ref Y', 'Pad X', 'Pad Y', 'Layer', 'Rotation', 'Comment'],
        ...comps.map((c) => {
          const p1 = board.pads.find((p) => p.ref === c.ref && p.type !== 'npth');
          return [c.ref, c.fp.id, `${mm(c.x)}mm`, `${mm(c.y)}mm`, `${mm(c.x)}mm`, `${mm(c.y)}mm`, `${mm(p1?.x ?? c.x)}mm`, `${mm(p1?.y ?? c.y)}mm`, 'T', c.rot, c.comp.value];
        }),
      ]),
    };
  }
  return {
    name: 'PnP.csv', mime: 'text/csv',
    content: csv([['Ref', 'Val', 'Package', 'PosX', 'PosY', 'Rot', 'Side'], ...comps.map((c) => [c.ref, c.comp.value, c.fp.id, mm(c.x), mm(c.y), c.rot.toFixed(1), 'top'])]),
  };
}

export function gerberFiles(board: Board, fab: FabId, date = new Date()): OutFile[] {
  const L = buildLayers(board, date);
  const n = safeName(board.design.name);
  const t = 'application/vnd.gerber';
  const files: OutFile[] = [
    { name: `${n}.GTL`, content: L.F_Cu, mime: t },
    ...L.inner.map((c, i) => ({ name: `${n}.${fab === 'oshpark' ? `G${i + 2}L` : `G${i + 1}`}`, content: c, mime: t })),
    { name: `${n}.GBL`, content: L.B_Cu, mime: t },
    { name: `${n}.GTS`, content: L.F_Mask, mime: t },
    { name: `${n}.GBS`, content: L.B_Mask, mime: t },
    { name: `${n}.GTO`, content: L.F_Silk, mime: t },
    { name: `${n}.GBO`, content: L.B_Silk, mime: t },
    { name: `${n}.GTP`, content: L.F_Paste, mime: t },
    { name: `${n}.GKO`, content: L.Edge_Cuts, mime: t },
  ];
  if (fab === 'oshpark') {
    files.push({ name: `${n}.XLN`, content: excellon(board, 'ALL', date), mime: 'text/plain' });
  } else {
    files.push({ name: `${n}-PTH.drl`, content: L.PTH, mime: 'text/plain' });
    if (board.pads.some((p) => p.type === 'npth')) files.push({ name: `${n}-NPTH.drl`, content: L.NPTH, mime: 'text/plain' });
    files.push({ name: `${n}.GBP`, content: L.B_Paste, mime: t });
  }
  return files;
}

export function fabReadme(board: Board, fab: FabId): string {
  const f = FABS[fab];
  const s = board.settings;
  const minHole = Math.min(...board.pads.filter((p) => p.drill).map((p) => p.drill!), ...board.vias.map((v) => v.drill), 99);
  return [
    `${board.design.name} - fabrication package for ${f.name}`,
    `Generated by PCBx2energy on ${new Date().toISOString().slice(0, 10)}`,
    '',
    'Board parameters',
    `  Layers:            ${board.layers} (${board.stack.join('')})`,
    `  Dimensions:        ${board.width.toFixed(1)} x ${board.height.toFixed(1)} mm`,
    `  Thickness:         ${s.thickness} mm`,
    `  Min track/space:   ${Math.min(s.trackWidth, s.powerTrackWidth)} / ${s.clearance} mm`,
    `  Min hole:          ${minHole.toFixed(2)} mm`,
    `  Surface finish:    ${s.finish}`,
    `  Copper weight:     1 oz`,
    `  Components:        ${board.comps.length} (${board.comps.filter((c) => c.fp.mount === 'smd').length} SMD, top side only)`,
    `  Unrouted:          ${board.unrouted.length}`,
    '',
    'Files',
    `  .GTL top copper  .GBL bottom copper  ${board.layers > 2 ? (fab === 'oshpark' ? '.G2L/.G3L inner copper  ' : '.G1-.G' + (board.layers - 2) + ' inner copper  ') : ''}.GTS/.GBS solder mask  .GTO/.GBO silkscreen`,
    '  .GTP/.GBP paste  .GKO board outline  .drl/.XLN Excellon drill (metric, decimal)',
    '',
    'Ordering notes',
    ...f.notes.map((n) => `  - ${n}`),
    ...(fab === 'oshpark' && board.layers > 4 ? [`  - WARNING: OSH Park only makes 2- and 4-layer boards; this design has ${board.layers} layers. Use JLCPCB or PCBWay.`] : []),
    ...(fab === 'jlcpcb' && board.layers > 2 ? [`  - Select "${board.layers} layers" on the JLCPCB quote page (impedance-controlled stack-ups are priced separately).`] : []),
    '',
  ].join('\n');
}

export async function zipFiles(files: OutFile[]): Promise<Uint8Array> {
  const z = new JSZip();
  const date = new Date();
  for (const f of files) z.file(f.name, f.content, { date });
  return z.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

export interface FabPackage { gerberZip: OutFile; bom: OutFile; pnp: OutFile; readme: OutFile; all: OutFile }

export async function buildFabPackage(board: Board, fab: FabId): Promise<FabPackage> {
  const n = safeName(board.design.name);
  const label = { jlcpcb: 'JLCPCB', pcbway: 'PCBWay', oshpark: 'OSHPark' }[fab];
  const readme: OutFile = { name: 'README_fab.txt', content: fabReadme(board, fab), mime: 'text/plain' };
  const gerbers = gerberFiles(board, fab);
  const gerberZip: OutFile = { name: `${n}_gerbers_${label}.zip`, content: await zipFiles([...gerbers, readme]), mime: 'application/zip' };
  const bom = makeBom(board, fab);
  const pnp = makePnp(board, fab);
  const design: OutFile = { name: `${n}.design.json`, content: JSON.stringify(board.design, null, 2), mime: 'application/json' };
  const all: OutFile = { name: `${n}_${label}_all.zip`, content: await zipFiles([gerberZip, bom, pnp, readme, design]), mime: 'application/zip' };
  return { gerberZip, bom, pnp, readme, all };
}
