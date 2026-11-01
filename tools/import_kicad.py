#!/usr/bin/env python3
"""Generate src/footprints_kicad.ts from official KiCad footprints (CC-BY-SA 4.0 with the KiCad library license exception).
Run:  python3 tools/import_kicad.py
Geometry (pads, courtyard, body outline) is read from the .kicad_mod files; y is flipped (KiCad y-down -> y-up) and the
origin is moved to the centre of the F.Fab outline."""
import json, re, sys, urllib.request, urllib.parse

BASE = 'https://gitlab.com/kicad/libraries/kicad-footprints/-/raw/master/'
SYM = 'https://gitlab.com/kicad/libraries/kicad-symbols/-/raw/master/'

def tokenize(s):
    i, n, out = 0, len(s), []
    while i < n:
        c = s[i]
        if c in ' \t\r\n': i += 1
        elif c == '(' or c == ')': out.append(c); i += 1
        elif c == '"':
            j = i + 1; buf = ''
            while s[j] != '"':
                if s[j] == '\\': j += 1
                buf += s[j]; j += 1
            out.append(('s', buf)); i = j + 1
        else:
            j = i
            while j < n and s[j] not in ' \t\r\n()': j += 1
            out.append(s[i:j]); i = j
    return out

def parse(tokens):
    pos = 0
    def rd():
        nonlocal pos
        t = tokens[pos]
        if t == '(':
            pos += 1; lst = []
            while tokens[pos] != ')': lst.append(rd())
            pos += 1; return lst
        pos += 1
        return t[1] if isinstance(t, tuple) else (float(t) if re.fullmatch(r'-?\d+(\.\d+)?', t) else t)
    return rd()

def find(node, key):
    return [c for c in node if isinstance(c, list) and c and c[0] == key]

def fetch(url):
    with urllib.request.urlopen(url, timeout=60) as r: return r.read().decode()

def bbox_layer(node, layer):
    xs, ys = [], []
    for c in node:
        if not (isinstance(c, list) and c and c[0] in ('fp_line', 'fp_rect', 'fp_circle', 'fp_arc', 'fp_poly')): continue
        lay = find(c, 'layer')
        if not lay or lay[0][1] != layer: continue
        for sub in c:
            if isinstance(sub, list) and sub and sub[0] in ('start', 'end', 'mid', 'center') and len(sub) >= 3:
                xs.append(sub[1]); ys.append(sub[2])
            if isinstance(sub, list) and sub and sub[0] == 'pts':
                for p in sub[1:]:
                    if isinstance(p, list) and p and p[0] == 'xy': xs.append(p[1]); ys.append(p[2])
        if c[0] == 'fp_circle':
            ctr = find(c, 'center')[0]; end = find(c, 'end')[0]
            r = ((end[1]-ctr[1])**2 + (end[2]-ctr[2])**2) ** .5
            xs += [ctr[1]-r, ctr[1]+r]; ys += [ctr[2]-r, ctr[2]+r]
    return (min(xs), min(ys), max(xs), max(ys)) if xs else None

def convert(src, fid, desc, kind, z, edge=None, color=None, aliases=None, mount=None, sym=None):
    node = parse(tokenize(fetch(BASE + src + '.kicad_mod')))
    crt = bbox_layer(node, 'F.CrtYd')
    fab = bbox_layer(node, 'F.Fab') or crt
    ox, oy = (fab[0] + fab[2]) / 2, (fab[1] + fab[3]) / 2
    pads, dropped = [], 0
    for p in find(node, 'pad'):
        name, ptype, shape = p[1], p[2], p[3]
        at = find(p, 'at')[0]; size = find(p, 'size')[0]
        layers = find(p, 'layers')[0][1:] if find(p, 'layers') else []
        if ptype == 'smd' and 'F.Cu' not in layers and '*.Cu' not in layers: dropped += 1; continue
        if ptype == 'connect': dropped += 1; continue
        ang = int(round(at[3])) % 360 if len(at) > 3 else 0
        w, h = size[1], size[2]
        if ang in (90, 270): w, h = h, w
        x, y = at[1] - ox, -(at[2] - oy)
        d = {'pin': str(name) if str(name) != '' else 'MP', 'x': round(x, 3), 'y': round(y, 3), 'w': round(w, 3), 'h': round(h, 3),
             'shape': 'circle' if shape == 'circle' else ('oval' if shape == 'oval' else 'rect')}
        if ptype == 'smd': d['type'] = 'smd'
        else:
            d['type'] = 'tht' if ptype == 'thru_hole' else 'npth'
            dr = find(p, 'drill')
            if dr:
                dr = dr[0]
                if dr[1] == 'oval':
                    sw, sh = dr[2], dr[3]
                    if ang in (90, 270): sw, sh = sh, sw
                    if abs(sw - sh) < 1e-3: d['drill'] = round(sw, 3)
                    else: d['slot'] = {'w': round(sw, 3), 'h': round(sh, 3)}
                else: d['drill'] = round(dr[1], 3)
            if d['type'] == 'npth' and 'drill' not in d and 'slot' not in d: d['drill'] = round(min(w, h), 3)
            if d['type'] == 'tht' and 'drill' not in d and 'slot' not in d: d['drill'] = round(min(w, h) * 0.6, 3)
        pads.append(d)
    names = {}
    for p in pads:
        if p['type'] != 'npth': names[p['pin']] = names.get(p['pin'], 0) + 1
    bridged = sorted(k for k, v in names.items() if v > 1)
    cw, ch = (crt[2]-crt[0], crt[3]-crt[1]) if crt else (fab[2]-fab[0]+1, fab[3]-fab[1]+1)
    ccx, ccy = ((crt[0]+crt[2])/2 - ox, -((crt[1]+crt[3])/2 - oy)) if crt else (0, 0)
    attr = find(node, 'attr')
    has_smd = any(p['type'] == 'smd' for p in pads)
    mnt = mount or ('smd' if (attr and 'smd' in attr[0]) or (has_smd and not any(p['type'] == 'tht' for p in pads)) else 'tht')
    out = {'id': fid, 'description': desc + (f' [from KiCad {src.split("/")[-1]}]'), 'mount': mnt, 'pads': pads,
           'body': {'w': round(fab[2]-fab[0], 3), 'h': round(fab[3]-fab[1], 3), 'z': z, 'kind': kind},
           'courtyard': {'w': round(cw, 3), 'h': round(ch, 3)}}
    if color is not None: out['body']['color'] = color
    if abs(ccx) > .01: out['courtyard']['cx'] = round(ccx, 3)
    if abs(ccy) > .01: out['courtyard']['cy'] = round(ccy, 3)
    if edge: out['edge'] = edge
    if bridged: out['bridgedPins'] = bridged
    if aliases: out['aliases'] = aliases
    if dropped: out['description'] += f' ({dropped} back-side/edge pads not modelled)'; out['approx'] = True
    if sym: out['_sym'] = sym
    return out

M = []  # (src, id, desc, kind, z, edge, color, aliases)
def add(*a, **k): M.append((a, k))

SD = 'Connector_Card.pretty/'
add(SD+'microSD_HC_Hirose_DM3AT-SF-PEJM5', 'microSD_Hirose_DM3AT', 'microSD card socket, push-push, Hirose DM3AT-SF-PEJM5. SD-mode pins: 1=DAT2 2=CD/DAT3 3=CMD 4=VDD 5=CLK 6=VSS 7=DAT0 8=DAT1; pads 9 and 10 are the card-detect switch contacts; SH = shield (connect to GND). For SPI mode: CS=2 MOSI=3 SCK=5 MISO=7.', 'box', 1.8, edge='bottom', color=0xb0b0b4, sym=('Connector','Micro_SD_Card_Det1'),
    aliases={'DAT2':'1','CD':'2','DAT3':'2','CS':'2','CMD':'3','MOSI':'3','VDD':'4','VCC':'4','3V3':'4','CLK':'5','SCK':'5','VSS':'6','GND':'6','DAT0':'7','MISO':'7','DAT1':'8'})
add(SD+'microSD_HC_Wuerth_693072010801', 'microSD_Wuerth_693072010801', 'microSD card socket (Wuerth 693072010801, hinged/push-pull). SD-mode pins: 1=DAT2 2=CD/DAT3 3=CMD 4=VDD 5=CLK 6=VSS 7=DAT0 8=DAT1; other pads are the card-detect switch and shield. SPI mode: CS=2 MOSI=3 SCK=5 MISO=7.', 'box', 1.8, edge='bottom', color=0xb0b0b4,
    aliases={'DAT2':'1','CD':'2','DAT3':'2','CS':'2','CMD':'3','MOSI':'3','VDD':'4','VCC':'4','3V3':'4','CLK':'5','SCK':'5','VSS':'6','GND':'6','DAT0':'7','MISO':'7','DAT1':'8'})
add(SD+'SD_Hirose_DM1AA_SF_PEJ82', 'SD_Hirose_DM1AA', 'Full-size SD card socket (Hirose DM1AA-SF-PEJ82). SD-mode pins: 1=CD/DAT3 2=CMD 3=VSS 4=VDD 5=CLK 6=VSS 7=DAT0 8=DAT1 9=DAT2; other pads are card-detect/write-protect switches and shield. SPI mode: CS=1 MOSI=2 SCK=5 MISO=7.', 'box', 2.2, edge='bottom', color=0xb0b0b4, sym=('Connector','SD_Card_Receptacle'),
    aliases={'CD':'1','DAT3':'1','CS':'1','CMD':'2','MOSI':'2','VDD':'4','VCC':'4','3V3':'4','CLK':'5','SCK':'5','DAT0':'7','MISO':'7','DAT1':'8','DAT2':'9'})
RJ = 'Connector_RJ.pretty/'
add(RJ+'RJ45_Hanrun_HR911105A_Horizontal', 'RJ45_Hanrun_HR911105A', 'RJ45 MagJack with integrated Ethernet magnetics and 2 LEDs (Hanrun HR911105A, 10/100). Pins 1..8 per datasheet: 1=TD+ 2=TD- 3=RD+ 4=CT(TX centre tap) 5=CT(RX centre tap) 6=RD- 7=NC 8=GND(chassis); LED pads are the remaining numbered pins. Check the datasheet for the exact pad function list.', 'box', 13.5, edge='bottom', color=0x909094, sym=('Connector','RJ45_Hanrun_HR911105A_Horizontal'))
add(RJ+'RJ45_Amphenol_54602-x08_Horizontal', 'RJ45_Amphenol_54602', 'Plain RJ45 jack (no magnetics, Amphenol 54602-x08), 8 pins at 1.02mm staggered + shield. Pins 1..8 follow the T568 contact order. For Ethernet use a MagJack instead.', 'box', 13.5, edge='bottom', color=0x909094, sym=('Connector','RJ45'))
add(RJ+'RJ45_HALO_HFJ11-x2450E-LxxRL_Horizontal', 'RJ45_HALO_HFJ11', 'RJ45 MagJack with magnetics and LEDs (HALO HFJ11-x2450E, 10/100/1000-class). Check the datasheet for pad functions.', 'box', 13.5, edge='bottom', color=0x909094, sym=('Connector','RJ45_Halo_HFJ11-x2450E-LxxRL'))
VID = 'Connector_Video.pretty/'
add(VID+'HDMI_A_Amphenol_10029449-x01xLF_Horizontal', 'HDMI_A_Amphenol_10029449', 'HDMI type A receptacle, right-angle SMD (Amphenol 10029449). Pins 1..19: 1=D2+ 2=D2_SH 3=D2- 4=D1+ 5=D1_SH 6=D1- 7=D0+ 8=D0_SH 9=D0- 10=CLK+ 11=CLK_SH 12=CLK- 13=CEC 14=NC 15=SCL 16=SDA 17=GND 18=+5V 19=HPD; shield pads named per datasheet. Route TMDS pairs as 100-ohm differential.', 'box', 6.5, edge='bottom', color=0xa0a0a4, sym=('Connector','HDMI_A'),
    aliases={'D2+':'1','D2-':'3','D1+':'4','D1-':'6','D0+':'7','D0-':'9','CLK+':'10','CLK-':'12','CEC':'13','SCL':'15','SDA':'16','GND':'17','5V':'18','HPD':'19'})
add(VID+'HDMI_A_Molex_208658-1001_Horizontal', 'HDMI_A_Molex_208658', 'HDMI type A receptacle (Molex 208658-1001), same 19-pin HDMI pinout: 1=D2+ 3=D2- 4=D1+ 6=D1- 7=D0+ 9=D0- 10=CLK+ 12=CLK- 13=CEC 15=SCL 16=SDA 17=GND 18=+5V 19=HPD; shield-pins are the *_SH pins (2,5,8,11) and shell.', 'box', 6.5, edge='bottom', color=0xa0a0a4, sym=('Connector','HDMI_A'),
    aliases={'D2+':'1','D2-':'3','D1+':'4','D1-':'6','D0+':'7','D0-':'9','CLK+':'10','CLK-':'12','CEC':'13','SCL':'15','SDA':'16','GND':'17','5V':'18','HPD':'19'})
FPC = 'Connector_FFC-FPC.pretty/'
for n in (6, 8, 10, 12, 14, 16, 20, 24, 30, 40):
    add(FPC+f'Hirose_FH12-{n}S-0.5SH_1x{n:02d}-1MP_P0.50mm_Horizontal', f'FPC_0.5mm_{n}P', f'FPC/FFC ZIF connector, 0.5mm pitch, {n} contacts (Hirose FH12-{n}S-0.5SH). Pins 1..{n}; MP = mounting tabs (connect to GND).', 'box', 1.0, edge='bottom', color=0xe8e0c8)
for n in (4, 6, 8, 10, 12):
    add(FPC+f'Molex_200528-{n*10:04d}_1x{n:02d}-1MP_P1.00mm_Horizontal', f'FPC_1.0mm_{n}P', f'FPC/FFC ZIF connector, 1.0mm pitch, {n} contacts (Molex 200528-{n*10:04d}). Pins 1..{n}; MP = mounting tabs (connect to GND).', 'box', 2.0, edge='bottom', color=0xe8e0c8)
RLT = 'Relay_THT.pretty/'
add(RLT+'Relay_SPDT_Omron-G5LE-1', 'Relay_SPDT_Omron_G5LE', 'SPDT power relay Omron G5LE-1 (10 A). Pads 1,2 = coil; pads 3,4,5 = the three contacts (COM/NO/NC - confirm which is which in the datasheet before routing the load). Drive the coil from a transistor/MOSFET with a flyback diode across it.', 'box', 15.7, color=0x2a62b8, aliases={'COIL1':'1','COIL2':'2'})
add(RLT+'Relay_SPDT_Hongfa_JQC-3FF_0XX-1Z', 'Relay_SPDT_Hongfa_JQC-3FF', 'SPDT power relay Hongfa JQC-3FF (10 A). Pads: A1, A2 = coil; 11 = COM, 12 = NC, 14 = NO. Drive the coil from a transistor/MOSFET with a flyback diode across it.', 'box', 15.5, color=0x2a62b8, aliases={'COIL1':'A1','COIL2':'A2','COM':'11','NC':'12','NO':'14'})
add(RLT+'Relay_DPDT_Omron_G5V-2', 'Relay_DPDT_Omron_G5V-2', 'DPDT signal relay Omron G5V-2 (1 A). Pads 1 and 16 = coil; pads 4,6,8 and 9,11,13 = the two changeover contact sets (confirm COM/NC/NO per the datasheet). Flyback diode across the coil.', 'box', 10.0, color=0x2a2a2e, aliases={'COIL1':'1','COIL2':'16'})
add('Relay_SMD.pretty/Relay_DPDT_Omron_G6K-2F', 'Relay_DPDT_Omron_G6K-2F', 'DPDT SMD signal relay Omron G6K-2F (1 A). Pads A1, A2 = coil; first contact set 11 = COM, 12 = NC, 14 = NO; second set 21 = COM, 22 = NC, 24 = NO. Flyback diode across the coil.', 'box', 5.4, color=0x2a2a2e, aliases={'COIL1':'A1','COIL2':'A2','COM1':'11','NC1':'12','NO1':'14','COM2':'21','NC2':'22','NO2':'24'})
BAT = 'Battery.pretty/'
add(BAT+'BatteryHolder_Keystone_3034_1x20mm', 'BatteryHolder_CR2032_Keystone_3034', 'SMD coin-cell holder for CR2032 (Keystone 3034). Pins: 1 = +, 2 = -.', 'box', 4.0, color=0xb8b8bc, aliases={'+':'1','-':'2'})
add(BAT+'BatteryHolder_Keystone_1058_1x2032', 'BatteryHolder_CR2032_Keystone_1058', 'Through-hole coin-cell holder for CR2032 (Keystone 1058). Pins: 1 = +, 2 = -.', 'box', 4.0, color=0xb8b8bc, aliases={'+':'1','-':'2'})
add(BAT+'BatteryHolder_MYOUNG_BS-07-A1BJ001_CR2032', 'BatteryHolder_CR2032_BS-07', 'Through-hole CR2032 holder (Myoung BS-07-A1BJ001). Pins: 1 = +, 2 = -.', 'box', 4.0, color=0xb8b8bc, aliases={'+':'1','-':'2'})
add(BAT+'BatteryHolder_Keystone_1042_1x18650', 'BatteryHolder_18650_Keystone_1042', 'Through-hole 18650 Li-ion cell holder (Keystone 1042). Pins: 1 = +, 2 = -. Add reverse-polarity and under-voltage protection.', 'box', 20.0, color=0x2a2a2e, aliases={'+':'1','-':'2'})
add(BAT+'BatteryHolder_Keystone_2460_1xAA', 'BatteryHolder_AA_Keystone_2460', 'Through-hole AA cell holder (Keystone 2460). Pins: 1 = +, 2 = -.', 'box', 16.0, color=0x2a2a2e, aliases={'+':'1','-':'2'})
add(BAT+'BatteryHolder_Keystone_2462_2xAA', 'BatteryHolder_2xAA_Keystone_2462', 'Through-hole 2xAA cell holder (Keystone 2462). Pins: 1 = +, 2 = -.', 'box', 16.0, color=0x2a2a2e, aliases={'+':'1','-':'2'})
COAX = 'Connector_Coaxial.pretty/'
add(COAX+'SMA_Amphenol_132134_Vertical', 'SMA_Vertical_Amphenol_132134', 'SMA RF jack, vertical through-hole (Amphenol 132134). Pin 1 = centre/signal, pin 2 = ground (4 legs). 50-ohm RF trace to pin 1.', 'cylinder', 9.0, color=0xd0b060, aliases={'SIG':'1','GND':'2'})
add(COAX+'SMA_Amphenol_901-144_Vertical', 'SMA_Vertical_Amphenol_901-144', 'SMA RF jack, vertical through-hole (Amphenol 901-144). Pin 1 = centre/signal, pin 2 = ground. 50-ohm RF trace to pin 1.', 'cylinder', 9.0, color=0xd0b060, aliases={'SIG':'1','GND':'2'})
add(COAX+'SMA_Molex_73251-2200_Horizontal', 'SMA_Horizontal_Molex_73251', 'SMA RF jack, right-angle through-hole (Molex 73251-2200). Pin 1 = centre/signal, pin 2 = ground. 50-ohm RF trace to pin 1.', 'box', 8.0, edge='bottom', color=0xd0b060, aliases={'SIG':'1','GND':'2'})
add(COAX+'SMA_Samtec_SMA-J-P-H-ST-EM1_EdgeMount', 'SMA_EdgeLaunch_Samtec', 'SMA edge-launch jack (Samtec SMA-J-P-H-ST-EM1). Pin 1 = centre/signal, pin 2 = ground. Only the top-side pads are modelled; add the bottom-side ground pads manually or via copper pour.', 'box', 8.0, edge='bottom', color=0xd0b060, aliases={'SIG':'1','GND':'2'})
BGA = 'Package_BGA.pretty/'
for src, fid, d in [
  ('Analog_BGA-49_6.25x6.25mm_Layout7x7_P0.8mm', 'BGA-49_7x7_P0.8', 'BGA-49 7x7 balls, 0.8mm pitch'),
  ('BGA-64_9.0x9.0mm_Layout10x10_P0.8mm', 'BGA-64_10x10_P0.8', 'BGA-64 (10x10 grid), 0.8mm pitch'),
  ('BGA-48_8.0x9.0mm_Layout6x8_P0.8mm', 'BGA-48_6x8_P0.8', 'BGA-48 6x8 balls, 0.8mm pitch (SPI/NOR flash, small NAND)'),
  ('LFBGA-100_10x10mm_Layout10x10_P0.8mm', 'LFBGA-100_10x10_P0.8', 'LFBGA-100 10x10mm, 0.8mm pitch (STM32)'),
  ('LFBGA-144_10x10mm_Layout12x12_P0.8mm', 'LFBGA-144_12x12_P0.8', 'LFBGA-144 10x10mm, 0.8mm pitch (STM32)'),
  ('BGA-144_7.0x7.0mm_Layout13x13_P0.5mm_Ball0.3mm_Pad0.25mm_NSMD', 'BGA-144_13x13_P0.5', 'BGA-144 7x7mm, 0.5mm pitch (needs HDI/microvias to escape)'),
  ('BGA-256_17.0x17.0mm_Layout16x16_P1.0mm_Ball0.5mm_Pad0.4mm_NSMD', 'BGA-256_16x16_P1.0', 'BGA-256 17x17mm, 1.0mm pitch (FPGA/MPU)'),
]:
    add(BGA+src, fid, d + '. Balls named by row letter + column number (A1 top-left). Needs 4+ layers; 0.5mm pitch parts need via-in-pad/HDI that most budget fabs do not offer.', 'qfn', 1.2)
add('RF_Module.pretty/ESP32-C6-MINI-1', 'ESP32-C6-MINI-1', 'ESP32-C6-MINI-1 module 13.2x16.6mm (Wi-Fi 6 + BLE 5 + 802.15.4, PCB antenna). Pins by number or by name (IO0..IO23, EN, 3V3, RXD0/TXD0 etc., see pad names). Antenna end must face the board edge; keep copper out of the antenna area.', 'module', 2.4, edge='top')

out = []
for (a, k) in M:
    src, fid, desc, kind, z = a
    try:
        out.append(convert(src, fid, desc, kind, z, **k))
        print('ok', fid, len(out[-1]['pads']), 'pads', file=sys.stderr)
    except Exception as e:
        print('FAIL', fid, e, file=sys.stderr)

# pin names from the matching KiCad symbols
def walk(n, acc):
    if isinstance(n, list):
        if n and n[0] == 'pin': acc.append(n)
        for c in n: walk(c, acc)

def apply_symbol(fp, lib, name):
    try:
        sym = parse(tokenize(fetch(SYM + f'{lib}.kicad_symdir/{name}.kicad_sym')))
    except Exception as e:
        print('symbol failed', fp['id'], e, file=sys.stderr); return
    acc = []; walk(sym, acc)
    pins = {}
    for pn in acc:
        nm = str(find(pn, 'name')[0][1]); num = str(find(pn, 'number')[0][1])
        if nm and nm != '~' and not nm.upper().startswith('NC') and nm != num: pins[num] = nm
    padnums = {p['pin'] for p in fp['pads']}
    pins = {k: v for k, v in pins.items() if k in padnums}
    by_name = {}
    for num, nm in pins.items(): by_name.setdefault(nm, []).append(num)
    for nm, nums in by_name.items():
        if len(nums) > 1:   # same-named pins (GND, shield...) are one electrical pin
            for pad in fp['pads']:
                if pad['pin'] in nums: pad['pin'] = nm
            fp.setdefault('bridgedPins', [])
            if nm not in fp['bridgedPins']: fp['bridgedPins'].append(nm)
    al = dict(fp.get('aliases') or {})
    for nm, nums in by_name.items():
        if len(nums) == 1:
            for part in nm.split('/'):
                if part: al.setdefault(part, nums[0])
    if al: fp['aliases'] = al
    cnt = {}
    for pd in fp['pads']:
        if pd['type'] != 'npth': cnt[pd['pin']] = cnt.get(pd['pin'], 0) + 1
    fp['bridgedPins'] = sorted(k for k, v in cnt.items() if v > 1)
    if not fp['bridgedPins']: del fp['bridgedPins']
    single = sorted(((n, v[0]) for v, n in [(v, k) for k, v in by_name.items()] if len(v) == 1 for v in [v]), key=lambda t: t[1]) if False else None
    items = []
    for nm, nums in by_name.items():
        items.append((nums[0] if len(nums) == 1 else '', nm))
    txt = ', '.join((f'{n}={nm}' if n else f'{nm} (several pads, one pin)') for n, nm in sorted(items, key=lambda t: (int(re.sub(r"\D", "", t[0]) or 9999), t[1])))
    fp['description'] += f' Pin functions: {txt}.'

for fp in out:
    sym = fp.pop('_sym', None)
    if sym: apply_symbol(fp, *sym)
    if fp['id'] == 'ESP32-C6-MINI-1': apply_symbol(fp, 'RF_Module', 'ESP32-C6-MINI-1')

ts = "// GENERATED by tools/import_kicad.py - do not edit by hand.\n// Footprint geometry from the official KiCad library (CC-BY-SA 4.0 with the library's design exception).\nimport type { FootprintDef } from './types';\n\nexport const KICAD_FOOTPRINTS: Omit<FootprintDef, 'pinCount'>[] = " + json.dumps(out, separators=(',', ':')) + ";\n"
open('src/footprints_kicad.ts', 'w').write(ts)
print('wrote', len(out), 'footprints', len(ts), 'bytes', file=sys.stderr)
