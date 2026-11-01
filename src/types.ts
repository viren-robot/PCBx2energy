// Core data model shared by the AI layer, layout engine, router, viewers and exporters.
// Units: millimetres. Board coordinates: origin at bottom-left, +Y up (same as Gerber).

export type PadShape = 'rect' | 'circle' | 'oval';
export type PadType = 'smd' | 'tht' | 'npth';

export interface PadDef {
  pin: string; // pin id; several pads may share one id (internally connected)
  x: number;
  y: number;
  w: number;
  h: number;
  shape: PadShape;
  type: PadType;
  drill?: number; // round hole diameter
  slot?: { w: number; h: number }; // oval hole (slot) size, axis aligned in footprint frame
}

export type BodyKind =
  | 'chip'
  | 'led'
  | 'diode'
  | 'sot'
  | 'ic'
  | 'qfp'
  | 'dip'
  | 'header'
  | 'jst'
  | 'terminal'
  | 'usbc'
  | 'module'
  | 'tactile'
  | 'crystal'
  | 'crystal_smd'
  | 'cap_elec'
  | 'cap_smd_elec'
  | 'to220'
  | 'hole';

export interface FootprintDef {
  id: string;
  description: string; // shown to the AI: pin meaning, typical parts
  pads: PadDef[];
  body: { w: number; h: number; z: number; kind: BodyKind; color?: number };
  courtyard: { w: number; h: number; cx?: number; cy?: number };
  aliases?: Record<string, string>; // pin name -> pin id
  mount: 'smd' | 'tht';
  /** Connector-like part that must sit on the board edge. The given side (in footprint frame) faces outward. */
  edge?: 'top' | 'bottom';
  /** Copper keep-out rectangles in footprint frame (e.g. antenna areas). */
  keepouts?: { x0: number; y0: number; x1: number; y1: number }[];
  /** Rotation offset JLCPCB's assembly line expects relative to this (KiCad-oriented) footprint. */
  jlcRotation?: number;
  /** Pins whose multiple pads are connected inside the part (switch legs, SOT-223 tab, module GND). */
  bridgedPins?: string[];
  pinCount: number;
}

// ---------- Logical design (what the AI produces) ----------

export interface DesignComponent {
  ref: string;
  footprint: string;
  value: string;
  description: string;
  manufacturer: string;
  mpn: string;
  lcsc: string;
  /** Optional fixed placement (board mm). Use null/omit for automatic placement. */
  x?: number | null;
  y?: number | null;
  rotation?: number | null;
}

export interface DesignNet {
  name: string;
  pins: string[]; // "R1.1", "U1.VCC", "J1.GND"
}

export interface Design {
  name: string;
  description: string;
  board: { width: number; height: number; cornerRadius: number };
  components: DesignComponent[];
  nets: DesignNet[];
  notes: string[];
}

// ---------- Physical board ----------

export interface Settings {
  trackWidth: number;
  powerTrackWidth: number;
  clearance: number;
  viaDiameter: number;
  viaDrill: number;
  edgeClearance: number;
  groundPour: boolean;
  thickness: number;
  maskColor: string;
  silkColor: string;
  finish: 'HASL' | 'ENIG';
  gridOverride?: number;
}

export const DEFAULT_SETTINGS: Settings = {
  trackWidth: 0.25,
  powerTrackWidth: 0.5,
  clearance: 0.2,
  viaDiameter: 0.6,
  viaDrill: 0.3,
  edgeClearance: 0.4,
  groundPour: true,
  thickness: 1.6,
  maskColor: '#1f7a3a',
  silkColor: '#ffffff',
  finish: 'HASL',
};

export interface PlacedComponent {
  ref: string;
  fp: FootprintDef;
  comp: DesignComponent;
  x: number;
  y: number;
  rot: number; // degrees, multiple of 90, CCW
  fixed: boolean;
}

export interface WorldPad {
  id: number;
  ref: string;
  pin: string;
  net: number; // -1 = unconnected
  x: number;
  y: number;
  w: number; // axis-aligned after rotation
  h: number;
  shape: PadShape;
  type: PadType;
  drill?: number;
  slot?: { w: number; h: number };
  top: boolean;
  bottom: boolean;
}

export interface NetInfo {
  name: string;
  width: number;
  isGround: boolean;
  isPower: boolean;
}

export interface Track {
  net: number;
  layer: 0 | 1; // 0 = top (F.Cu), 1 = bottom (B.Cu)
  width: number;
  pts: [number, number][];
}

export interface Via {
  net: number;
  x: number;
  y: number;
  d: number;
  drill: number;
}

export interface RouteResult {
  tracks: Track[];
  vias: Via[];
  unrouted: { net: number; a: [number, number]; b: [number, number] }[];
  pourNet: number; // -1 if none
  log: string[];
}

export interface Board {
  design: Design;
  settings: Settings;
  width: number;
  height: number;
  cornerRadius: number;
  comps: PlacedComponent[];
  pads: WorldPad[];
  nets: NetInfo[];
  keepouts: { x0: number; y0: number; x1: number; y1: number }[];
  tracks: Track[];
  vias: Via[];
  unrouted: RouteResult['unrouted'];
  pourNet: number;
  warnings: string[];
  routeLog: string[];
}

export type FabId = 'jlcpcb' | 'pcbway' | 'oshpark';
