# PCBx2energy — Text → PCB

Describe a circuit in plain English and get a manufacturable 2-layer PCB: schematic-level netlist, automatic placement, autorouting with a ground pour, 2D and 3D previews, and ready-to-upload fabrication files for **JLCPCB**, **PCBWay** or **OSH Park**.

```
"ESP32 board with USB-C power, 3.3V regulator, reset/boot buttons and GPIO headers"
        │  Claude (structured output)  ──or──  offline circuit templates
        ▼
   Design JSON (components + nets)
        │  placer → negotiated-congestion router → DRC   (Web Worker)
        ▼
   2D view · 3D view · BOM · Netlist  →  Gerber + Excellon + BOM + pick-and-place (.zip)
```

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # routing/export/AI tests
npm run build      # static site in dist/ (deploy anywhere)
```

1. Type a description (or click an example) and press **Generate PCB**.
2. Inspect the board in **2D** (layers, net highlight, hover info) and **3D** (orbit, top/bottom views).
3. Pick your fab at the top — **JLCPCB / PCBWay / OSH Park** — and download the files.

### AI mode vs offline mode

* **With an Anthropic API key** (⚙ Settings): Claude designs the full circuit from any description, and **Modify current design** lets you iterate ("add a buzzer on IO25", "make it 40×30 mm", "use 0805 parts"). The key is kept in your browser's localStorage and is sent only to `api.anthropic.com`. Requests use structured outputs (JSON schema constrained to the footprint library), so the result always parses. Opus 5.5 is the default; Sonnet 5.5 and Haiku 5.5 are selectable.
* **Without a key**: built-in parameterised templates (LED boards, 555 blinker, ESP32 dev board, ATmega328P, 3.3 V LDO, MOSFET switch, CH340C USB-UART). The prompt is parsed for LED count/colour, power input (USB-C, battery, header, screw terminal), board size (`50x40mm`) and mounting holes.

You can also edit the **Design JSON** tab directly (or open a saved `.design.json`) and press *Apply*.

## Fabrication outputs

| | JLCPCB | PCBWay | OSH Park |
|---|---|---|---|
| Gerbers | `.GTL .GBL .GTS .GBS .GTO .GBO .GTP .GBP .GKO` (RS-274X + X2 attributes) | same | same (no bottom paste) |
| Drill | `-PTH.drl` + `-NPTH.drl` (Excellon, metric) | same | single `.XLN` |
| BOM | `Comment, Designator, Footprint, LCSC Part #` | PCBWay assembly template (Manufacturer / MPN / Package / Type) | generic BOM |
| Placement | CPL `Designator, Mid X, Mid Y, Layer, Rotation` with JLCPCB rotation corrections | Centroid (Altium-style) | generic PnP |
| Default mask | green | green | purple |

Gerber files are packed into a ZIP (Gerber itself is an ASCII format by specification — the ZIP is what you upload). **Everything (.zip)** additionally contains the BOM, placement file, a fab README with board parameters, and the design JSON.

The output was checked by parsing every layer and drill file with an independent Gerber library (gerbonara) and rendering the copper.

## How it works

| Module | Purpose |
|---|---|
| `src/ai.ts` | Claude call (streaming, structured JSON output, server-side refusal fallback) |
| `src/templates.ts` | Offline prompt parser + circuit templates |
| `src/footprints.ts` | Footprint library (KiCad/IPC-7351 land patterns, KiCad orientation): 0402–1206 passives, LEDs, SOD-123, SMA, SOT-23/-5/-6, SOT-223, SOIC-8/14/16, TSSOP-20, LQFP-32/48, DIP, pin headers 1×N/2×N, JST-PH/XH, screw terminals, USB-C 16P, ESP32-WROOM-32, crystals, electrolytics, buttons, TO-220, M3 holes |
| `src/layout.ts` | Netlist validation, auto board sizing, edge-connector placement (USB-C mouth / antenna toward the edge), connectivity-driven greedy placement with refinement, grid snapping for fine-pitch parts |
| `src/router.ts` | 2-layer grid router: A* with vias, signal/power width classes, keep-outs, no via-in-pad, **PathFinder negotiated congestion**, strict legalisation with 45° string-pulling, GND-to-pour connection with pour-island analysis |
| `src/drc.ts` | Geometric clearance / edge / connectivity check |
| `src/silk.ts`, `src/font.ts` | Silkscreen outlines (clipped from pads), pin-1 marks, reference designators (vector font) |
| `src/gerber.ts`, `src/export.ts` | Gerber/Excellon writers, ground pour with clearance cut-outs, fab-specific packaging |
| `src/view2d.ts`, `src/view3d.ts` | Canvas 2D viewer and three.js 3D viewer with procedural part models |

Default rules: 0.25 mm signal / 0.5 mm power tracks, 0.2 mm clearance, 0.6/0.3 mm vias, 0.4 mm copper-to-edge — inside the standard capabilities of all three fabs. Change them under *Design rules* and press *Re-place & re-route*.

## Limitations — check before you order

* Parts are limited to the footprint library above; all components go on the top side.
* The AI can make electrical mistakes. Review the **Netlist** tab against the datasheets of the ICs you use.
* LCSC numbers are suggestions; confirm stock/part in the JLCPCB part library. JLCPCB rotation offsets follow the commonly used KiCad→JLCPCB table — always confirm in JLCPCB's placement preview.
* Ground pour uses solid connections (no thermal reliefs), which makes hand-soldering large GND THT pads slower.
* The autorouter is grid-based; very dense boards may need a larger board size (it grows auto-sized boards automatically) or narrower tracks.

## v2: accounts, schematic, editing, self-checking

* **Sign-in** (Supabase Auth): email magic link to any address (Gmail works) or one of four fixed admin accounts (`stellarx1`, `stellarx2`, `strix3`, `strix4`; usernames are not case sensitive). Admins can see every user's saved designs in the **Cloud** tab. Row Level Security enforces this in the database.
* **Dark / light mode** toggle (◐), remembered per browser.
* **AI does the work, you keep control**: Claude (or the offline templates) designs the circuit, adds silkscreen/schematic **labels**, picks the **board colour** from plain words ("matte black with gold finish", "purple board white silkscreen"), then you can drag/rotate/delete parts in 2D, add parts, edit nets in the Netlist tab, change rules and colours.
* **Schematic** tab: generated from the *board* (PCB → schematic) with real symbols, power/ground symbols and net labels. It also reports whether the copper matches the netlist (layout-vs-schematic: shorts/opens).
* **3D**: shadows and reflections, rounded bodies, gull-wing IC leads, solder joints, resistor markings, LED domes, hover tooltips, X-ray copper mode, auto-rotate.
* **Self-check before anything is exported**: 3 review passes (Claude re-checks its own circuit against an electrical-rule checker; an edit that makes the checks worse is rejected) and 5 full place-route-DRC runs (clearance, edge, courtyard overlap, shorts, opens, unrouted). Every export re-runs the 5× DRC on the current design.

### Deployment notes
* Backend: Supabase project `pcbx2energy` (table `designs` with RLS). Only the public publishable key is in the client.
* In the Supabase dashboard set **Authentication → URL Configuration → Site URL** to your deployed URL and add the other deployment URL(s) to *Redirect URLs*, otherwise magic links return to the wrong address. The built-in Supabase mailer is rate limited and may only deliver to your own team's addresses until you configure custom SMTP.

## v3: layers, simulation, mechanics

* **2 / 4 / 6 / 8 / 10 copper layers.** Claude chooses the layer count (`board.layers`) and explains why; you can force a count under *Board & design rules*. On 4+ layers ground and the main power rail become real inner planes, connected by vias placed next to each SMD pad; extra layers are routable signal layers. With "Auto" the pipeline adds layers (2→4→6→8→10) before it enlarges the board. Gerbers contain every layer (`.GTL .G1…G8 .GBL`; OSH Park naming `.G2L/.G3L`), and DRC / layout-vs-schematic checks run across all layers. OSH Park only builds 2 and 4 layers: the app warns.
* **Default model is Claude Fable 5.1** (`claude-fable-5-1`, with server-side refusal fallback). Opus 5.5, Sonnet 5.5 and Haiku 5.5 stay selectable in Settings.
* **Simulation tab.** Apply a supply to any net or pin (`J1.VBUS`), drag the voltage / current-limit sliders (negative voltage = reverse polarity), press switches, set ambient temperature. A nodal DC solver (LEDs/diodes, LDO regulators, MOSFETs, IC loads, current-limited supplies) gives per-part V/I/P; temperatures come from package thermal resistance plus a 2-D board heat-diffusion model (copper planes spread heat, both faces convect); traces are checked with IPC-2221. Parts that exceed ratings are flagged **overstress / failed / burst** and, with *cascade* on, burnt parts open or short and the circuit is re-solved. Heat-map and failure markers also show on the 3D tab (glow, smoke on bursts). These are engineering estimates from typical datasheet values.
* **Mechanic tab.** Import STEP (`.step/.stp`, units read from the file), STL or OBJ files for the case, holder or brackets; position/rotate/scale them; *Check fit* tests every component body (including tall headers and through-hole legs) and the PCB outline against the solids; *Auto-move parts* finds the nearest collision-free spot for each colliding part, re-routes the board, re-runs the 5× DRC, and the Gerber/BOM/pick-and-place exports then reflect the new layout. You can also drag parts directly in the 3D view. Edge connectors (USB-C, terminals) are never auto-moved because they must line up with case cut-outs.

## Footprint library

~290 footprints: chip passives 0402–2512, inductors/ferrites/fuses, LEDs (SMD, PLCC, THT, WS2812B), diodes (SOD-523 … SMC, DO-35/41/201), tantalum and electrolytic caps, axial/radial THT parts, SOT/SC-70/SOT-89/DPAK/D2PAK/TO-92/TO-220/TO-247, SOIC/SOIC-W/SSOP/TSSOP/MSOP/DFN, LQFP 32–144, QFN 16–64 (incl. 40-pin for ESP32-C6, RP2040, nRF52, ESP32-S3), headers and sockets, JST PH/XH/SH, terminal blocks, USB-C/micro-B/A, barrel jack, U.FL, crystals/oscillators, DIP switches, encoder, buzzer, test points, mounting holes, and ESP32-WROOM-32, ESP32-S3-WROOM-1, ESP-12F and Raspberry Pi Pico modules.

Footprints flagged `approx` use typical datasheet dimensions (mostly connectors, modules, power packages and exposed-pad sizes). The app lists them after each build - compare them with your part's datasheet before ordering.

### Imported KiCad footprints and AI-created footprints

`src/footprints_kicad.ts` is generated by `python3 tools/import_kicad.py` from the official KiCad footprint and symbol libraries (CC-BY-SA 4.0 with the KiCad library exception for designs): microSD/SD sockets, RJ45 MagJacks, HDMI, FPC/FFC (0.5 and 1.0 mm), relays, coin-cell/18650/AA holders, SMA, BGAs and the ESP32-C6-MINI-1 module. Pin functions come from the matching KiCad symbols.

When no footprint fits a part, the AI writes one itself (`customFootprints` in the design JSON: pads, pin names, body, edge side) and uses it without asking. These footprints are stored with the design, appear in the Edit-part list, get a schematic symbol from their pin names, and are flagged for a datasheet check before ordering.
