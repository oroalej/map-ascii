import { describe, expect, it } from 'vitest';
import { glyphFragmentFor } from '../shaders/glyph';
import { sextantSplits } from '../glyphs/atlas';
import { unpackGlyph } from '../glyphs/select';
import { sextantSplit } from '../passes';
import { sextantGlyphs, themes } from '../theme';
import { buildLifeGlyphs, packLife, type LifeGrid } from './draw';
import { PackingOutcome } from './diagnostics';
import {
  createLifeParts,
  PartsFlag,
  partsTexel,
  sextantOf,
  SHADE_NIBBLE,
  withSextant,
  type LifePartsTarget,
} from './parts-layer';
import type { VisibleAgent } from './simulate';
import type { Sun } from './sun';
import { TURN_SIGNAL_BIT } from './turn-signals';
import { Paint, PART_GLYPHS, VehiclePart, VEHICLES, type CraftType } from './vehicles';

const glyphs = [...new Set([' ', ...Object.values(PART_GLYPHS), ...sextantGlyphs])];
const glyphIndex = (g: string) => Math.max(0, glyphs.indexOf(g));
const lifeGlyphs = buildLifeGlyphs(glyphIndex);
const COLS = 60;
const ROWS = 40;

/** `scale` cells per meter across, `aspect` times that many columns per row. */
function vehicleAt(
  vehicle: CraftType,
  x: number,
  y: number,
  heading: number,
  scale: number,
  extra: Partial<VisibleAgent> = {},
): VisibleAgent {
  const fx = Math.cos(heading),
    fy = Math.sin(heading);
  return {
    kind: 'vehicle',
    vehicle,
    lng: x,
    lat: y,
    paint: Paint.red,
    flap: 0,
    ahead: [x + fx * scale, y + (fy * scale * 5) / 9],
    side: [x - fy * scale, y + (fx * scale * 5) / 9],
    ...extra,
  } as VisibleAgent;
}

const grid = (extra: Partial<LifeGrid> = {}): LifeGrid => ({
  cols: COLS,
  rows: ROWS,
  cellWidth: 5,
  cellHeight: 9,
  toCell: (lng, lat) => [lng, lat],
  ...extra,
});

function pack(
  agents: VisibleAgent[],
  parts?: LifePartsTarget,
  extra: Partial<LifeGrid> = {},
  sun: Sun | null = null,
) {
  const out = new Uint8Array(COLS * ROWS * 4);
  const owners = new Uint32Array(COLS * ROWS);
  const outcomes = new Uint8Array(agents.length);
  const stamped = new Uint8Array(agents.length);
  const drawn = packLife(
    out,
    grid({ outcomes, stampedVehicles: stamped, ...extra }),
    agents,
    themes.dark,
    glyphIndex,
    sun,
    lifeGlyphs,
    { owners, parts },
  );
  return { out, owners, outcomes, stamped, drawn };
}

const cellsOf = (out: Uint8Array) => {
  const cells: number[] = [];
  for (let i = 0; i < COLS * ROWS; i++) if (out[i * 4 + 2]) cells.push(i);
  return cells;
};
const layer = () => createLifeParts(COLS * ROWS, ROWS);

describe('part layer codec', () => {
  it('round-trips six values in the sextant bit order', () => {
    let rgb = 0;
    const values = [1, 2 | SHADE_NIBBLE, 3, 4 | SHADE_NIBBLE, 5, 7];
    values.forEach((value, sextant) => (rgb = withSextant(rgb, sextant, value)));
    values.forEach((value, sextant) => expect(sextantOf(rgb, sextant)).toBe(value));
    const texel = partsTexel(rgb, PartsFlag.valid | PartsFlag.brake);
    expect(texel >>> 24).toBe(PartsFlag.valid | PartsFlag.brake);
    // The shader reads channel sextant >> 1, nibble sextant & 1.
    values.forEach((value, sextant) => {
      const channel = (texel >>> ((sextant >> 1) * 8)) & 255;
      expect((channel >> ((sextant & 1) * 4)) & 15).toBe(value);
    });
  });

  it('splits sextants where the atlas draws them', () => {
    for (const [w, h] of [
      [5, 9],
      [10, 18],
      [7, 13],
      [8, 15],
    ] as const) {
      const { xs, ys } = sextantSplits(w, h);
      expect(sextantSplit({ w, h })).toEqual([xs[1], ys[1], ys[2]]);
    }
  });

  it('keeps the glyph program within what WebGL2 guarantees', () => {
    const samplers = glyphFragmentFor().match(/uniform\s+(?:highp\s+)?u?sampler2D\s/g) ?? [];
    expect(samplers.length).toBeLessThanOrEqual(16);
  });
});

describe('stamping with the part layer', () => {
  const headings = [0, 0.3, 0.8, Math.PI / 2, 2.2, Math.PI, 4.1, 5.6];
  const scales = [0.6, 1.4, 2.8, 5.5];

  it('holds exactly the cells it holds without the layer', () => {
    for (const vehicle of ['car', 'jeepney', 'motorcycle', 'bus', 'bicycle'] as const)
      for (const heading of headings)
        for (const scale of scales) {
          const agent = vehicleAt(vehicle, 30.37, 20.61, heading, scale);
          const before = pack([agent]);
          const held = cellsOf(before.out);
          const parts = layer();
          const after = pack([agent], parts, {
            // Only held cells are checked against terrain, so this lists the core set.
            allowsGroundCell: (_agent, col, row) => {
              expect(held).toContain(row * COLS + col);
              return true;
            },
          });
          for (const cell of held) expect(after.out[cell * 4 + 2]).toBe(before.out[cell * 4 + 2]);
          expect(after.drawn).toBe(before.drawn);
        }
  });

  it('keeps every packing outcome on a crowded road', () => {
    const agents: VisibleAgent[] = [];
    for (let i = 0; i < 40; i++)
      agents.push(
        vehicleAt(
          (['car', 'jeepney', 'motorcycle', 'bus'] as const)[i % 4]!,
          5 + (i * 7.3) % 50,
          5 + (i * 4.1) % 30,
          i * 0.7,
          1 + (i % 3),
        ),
      );
    const before = pack(agents);
    const after = pack(agents, layer());
    expect([...after.outcomes]).toEqual([...before.outcomes]);
    expect([...after.stamped]).toEqual([...before.stamped]);
    expect(after.outcomes).toContain(PackingOutcome.collision);
  });

  it('rejects the whole vehicle the same way, leaving no edge cells or sextants', () => {
    const parked = vehicleAt('car', 30, 20, 0, 2.8, { parked: true });
    const rival = vehicleAt('car', 31, 20, 0, 2.8);
    const parts = layer();
    const { out, outcomes, owners } = pack([parked, rival], parts);
    expect(outcomes[1]).toBe(PackingOutcome.collision);
    expect([...owners]).not.toContain(2);
    const alone = layer();
    const single = pack([parked], alone);
    expect([...out]).toEqual([...single.out]);
    expect([...parts.texels]).toEqual([...alone.texels]);
  });

  it('fills an edge cell the center test misses, owned by the vehicle but held by nobody', () => {
    const agent = vehicleAt('car', 30.2, 20.2, 0.4, 2.8);
    const before = pack([agent]);
    const parts = layer();
    const after = pack([agent], parts);
    const extra = cellsOf(after.out).filter((cell) => !before.out[cell * 4 + 2]);
    expect(extra.length).toBeGreaterThan(0);
    for (const cell of extra) {
      expect(after.owners[cell]).toBe(1);
      expect(parts.texels[cell * 4 + 3]! & PartsFlag.valid).toBe(PartsFlag.valid);
    }
    // Another vehicle may take such a cell without any denial.
    const beside = vehicleAt('motorcycle', 0, 0, 0, 2.8);
    const cell = extra[0]!;
    const taker = {
      ...beside,
      lng: (cell % COLS) + 0.5,
      lat: Math.floor(cell / COLS) + 0.5,
      ahead: [(cell % COLS) + 0.5 + 2.8, Math.floor(cell / COLS) + 0.5],
      side: [(cell % COLS) + 0.5, Math.floor(cell / COLS) + 0.5 + 1.5],
    } as VisibleAgent;
    const both = pack([agent, taker], layer());
    const without = pack([agent, taker]);
    expect([...both.outcomes]).toEqual([...without.outcomes]);
  });

  it('shows several parts inside one cell, and moves in sub-cell steps', () => {
    const scale = 2.8;
    const shape = (x: number) => {
      const parts = layer();
      const { out } = pack([vehicleAt('car', x, 20.5, 0, scale)], parts);
      return { out, parts };
    };
    const { out, parts } = shape(30);
    let mixed = 0;
    for (const cell of cellsOf(out)) {
      const rgb =
        parts.texels[cell * 4]! |
        (parts.texels[cell * 4 + 1]! << 8) |
        (parts.texels[cell * 4 + 2]! << 16);
      const glyph = unpackGlyph(out[cell * 4]!, out[cell * 4 + 1]!).glyph;
      const mask = sextantGlyphs.indexOf(glyphs[glyph]!);
      const seen = new Set<number>();
      for (let s = 0; s < 6; s++) if (mask & (1 << s)) seen.add(sextantOf(rgb, s));
      if (seen.size > 1) mixed++;
    }
    expect(mixed).toBeGreaterThan(0);
    // A quarter cell's move changes which sixths show, though not which cells it holds.
    expect([...shape(30.3).out]).not.toEqual([...out]);
  });

  it('never leaves a gap in a vehicle thinner than a sixth', () => {
    const agent = vehicleAt('bicycle', 30.2, 20.17, 0, 1.2);
    const before = pack([agent]);
    const after = pack([agent], layer());
    for (const cell of cellsOf(before.out)) {
      const glyph = unpackGlyph(after.out[cell * 4]!, after.out[cell * 4 + 1]!).glyph;
      expect(glyph).toBeGreaterThan(0);
    }
  });

  it('keeps the paint true and moves the brake lamp to a flag', () => {
    const parts = layer();
    const { out } = pack([vehicleAt('car', 30, 20.5, 0, 2.8, { lamps: { kind: 'brake' } })], parts);
    const cells = cellsOf(out);
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) {
      expect(out[cell * 4 + 3]! & 15).toBe(Paint.red);
      expect(parts.texels[cell * 4 + 3]! & PartsFlag.brake).toBe(PartsFlag.brake);
    }
    const parked = layer();
    pack(
      [vehicleAt('car', 30, 20.5, 0, 2.8, { lamps: { kind: 'brake' }, parked: true })],
      parked,
    );
    for (const cell of cells) expect(parked.texels[cell * 4 + 3]! & PartsFlag.brake).toBe(0);
  });

  it('keeps a turn signal inside the cell it had', () => {
    const agent = vehicleAt('car', 30.2, 20.2, 0, 2.8, {
      turnSignal: { side: 'left', on: true },
    });
    const parts = layer();
    const { out } = pack([agent], parts);
    const lamps = cellsOf(out).filter((cell) => out[cell * 4 + 2]! & TURN_SIGNAL_BIT);
    expect(lamps.length).toBeGreaterThan(0);
    for (const cell of lamps)
      expect(parts.texels[cell * 4 + 3]! & PartsFlag.valid).toBe(PartsFlag.valid);
  });

  it('clears the rows it no longer uses', () => {
    const parts = layer();
    pack([vehicleAt('car', 30, 10, 0, 2.8)], parts);
    expect(parts.end).toBeGreaterThan(parts.first);
    const oldRow = parts.first;
    pack([vehicleAt('car', 30, 30, 0, 2.8)], parts);
    expect(parts.first).toBeGreaterThan(oldRow);
    const old = parts.texels.subarray(oldRow * COLS * 4, (oldRow + 1) * COLS * 4);
    expect(old.every((byte) => byte === 0)).toBe(true);
    pack([], parts);
    expect(parts.end).toBe(0);
    expect(parts.texels.every((byte) => byte === 0)).toBe(true);
  });

  it('draws every craft with a known part in every sextant', () => {
    for (const vehicle of Object.keys(VEHICLES) as CraftType[]) {
      const parts = layer();
      const { out } = pack([vehicleAt(vehicle, 30.2, 20.2, 0.5, 2.2)], parts);
      for (const cell of cellsOf(out)) {
        const rgb =
          parts.texels[cell * 4]! |
          (parts.texels[cell * 4 + 1]! << 8) |
          (parts.texels[cell * 4 + 2]! << 16);
        for (let s = 0; s < 6; s++)
          expect(sextantOf(rgb, s) & 7).toBeLessThanOrEqual(VehiclePart.mini);
      }
    }
  });
});

describe('sunlit bodies', () => {
  /** How many shaded sixths each end of a vehicle crossing the screen has. */
  const shadedEnds = (heading: number, azimuth: number, altitude = 25) => {
    const parts = layer();
    const { out } = pack([vehicleAt('bus', 30, 20.5, heading, 2.8)], parts, {}, {
      azimuth,
      altitude,
    });
    const ends = { low: 0, high: 0, left: 0, right: 0 };
    for (const cell of cellsOf(out)) {
      const rgb =
        parts.texels[cell * 4]! |
        (parts.texels[cell * 4 + 1]! << 8) |
        (parts.texels[cell * 4 + 2]! << 16);
      let count = 0;
      for (let s = 0; s < 6; s++) if (sextantOf(rgb, s) & SHADE_NIBBLE) count++;
      const col = cell % COLS,
        row = Math.floor(cell / COLS);
      if (col < 30) ends.left += count;
      else ends.right += count;
      if (row < 20) ends.low += count;
      else ends.high += count;
    }
    return ends;
  };

  it('shades the side away from the sun, whichever way the vehicle heads', () => {
    // The sun in the east shades the west (left) end, for either heading.
    for (const heading of [0, Math.PI]) {
      const east = shadedEnds(heading, 90);
      expect(east.left).toBeGreaterThan(east.right);
      const west = shadedEnds(heading, 270);
      expect(west.right).toBeGreaterThan(west.left);
    }
    // The sun in the north shades the south (lower on screen) side.
    const north = shadedEnds(0, 0);
    expect(north.high).toBeGreaterThan(north.low);
    const south = shadedEnds(0, 180);
    expect(south.low).toBeGreaterThan(south.high);
  });

  it('leaves less in shade with the sun overhead, and none at night', () => {
    const count = ({ left, right }: { left: number; right: number }) => left + right;
    expect(count(shadedEnds(0, 90, 80))).toBeLessThan(count(shadedEnds(0, 90, 15)));
    expect(count(shadedEnds(0, 90, -5))).toBe(0);
  });

  it('never shades lamps or glass', () => {
    const parts = layer();
    const { out } = pack([vehicleAt('car', 30, 20.5, 0, 5.5)], parts, {}, {
      azimuth: 270,
      altitude: 10,
    });
    let lit = 0;
    for (const cell of cellsOf(out)) {
      const rgb =
        parts.texels[cell * 4]! |
        (parts.texels[cell * 4 + 1]! << 8) |
        (parts.texels[cell * 4 + 2]! << 16);
      for (let s = 0; s < 6; s++) {
        const value = sextantOf(rgb, s);
        const part = value & 7;
        if (part === VehiclePart.glass || part === VehiclePart.taillight || part === VehiclePart.headlight) {
          expect(value & SHADE_NIBBLE).toBe(0);
          lit++;
        }
      }
    }
    expect(lit).toBeGreaterThan(0);
  });

  it('changes nothing without the layer', () => {
    const agent = vehicleAt('car', 30, 20.5, 0, 2.8);
    const plain = pack([agent]);
    const sunny = pack([agent], undefined, {}, { azimuth: 90, altitude: 40 });
    expect([...sunny.out]).toEqual([...plain.out]);
  });
});
