import { describe, expect, it } from 'vitest';
import { unpackGlyph } from '../glyphs/select';
import { drawProcedural } from '../glyphs/atlas';
import { glyphFragmentFor } from '../shaders/glyph';
import { mapGlyphs, sextantGlyphs, themes } from '../theme';
import { MAX_GLYPHS } from '../glyphs/select';
import { agentBit, CellBit } from './config';
import { buildLifeGlyphs, packLife, type LifeGrid } from './draw';
import { packAgents, unpackAgents } from './agent-frame';
import { createLifeParts, PartsFlag, sextantOf } from './parts-layer';
import {
  FLAP_PASSING,
  passingGlyph,
  PASSING_GLYPHS,
  walkFlap,
  FIGURE_HAIR,
  FIGURE_MASTERS,
  figureGlyph,
  figureInk,
  figurePixels,
  FIGURE_TONE,
  PersonPart,
} from './people';
import type { VisibleAgent } from './simulate';
import { FINE_PLANS, lookOf } from './vehicle-plans';
import {
  fineplanFor,
  FINE_PLAN_SEXTANTS,
  Paint,
  PART_GLYPHS,
  VehiclePart,
  VEHICLES,
  WHEEL_PART,
  type CraftType,
} from './vehicles';

const LETTERS = /^[BRGHTDALW.]+$/;
const glyphs = [...new Set([' ', ...Object.values(PART_GLYPHS), ...sextantGlyphs])];
const glyphIndex = (g: string) => Math.max(0, glyphs.indexOf(g));
const lifeGlyphs = buildLifeGlyphs(glyphIndex);
const COLS = 120;
const ROWS = 80;
const grid = (): LifeGrid => ({
  cols: COLS,
  rows: ROWS,
  cellWidth: 5,
  cellHeight: 9,
  toCell: (lng, lat) => [lng, lat],
});

const craftAt = (vehicle: CraftType, scale: number, extra: Partial<VisibleAgent> = {}) =>
  ({
    kind: 'vehicle',
    vehicle,
    lng: 60.2,
    lat: 40.2,
    paint: Paint.red,
    flap: 0,
    ahead: [60.2 + scale, 40.2],
    side: [60.2, 40.2 + (scale * 5) / 9],
    ...extra,
  }) as VisibleAgent;

function drawn(agent: VisibleAgent) {
  const out = new Uint8Array(COLS * ROWS * 4);
  const parts = createLifeParts(COLS * ROWS, ROWS);
  packLife(out, grid(), [agent], themes.dark, glyphIndex, null, lifeGlyphs, { parts });
  const values = new Set<number>();
  const layout: string[] = [];
  for (let cell = 0; cell < COLS * ROWS; cell++) {
    if (!out[cell * 4 + 2]) continue;
    const rgb =
      parts.texels[cell * 4]! |
      (parts.texels[cell * 4 + 1]! << 8) |
      (parts.texels[cell * 4 + 2]! << 16);
    const glyph = glyphs[unpackGlyph(out[cell * 4]!, out[cell * 4 + 1]!).glyph]!;
    const mask = sextantGlyphs.indexOf(glyph);
    for (let s = 0; s < 6; s++) if (mask & (1 << s)) values.add(sextantOf(rgb, s) & 7);
    layout.push(`${cell}:${glyph}:${rgb}`);
  }
  return { out, parts, values, layout: layout.join() };
}

describe('close-up plans', () => {
  it('gives every craft a rectangular plan of known letters, about twice as fine', () => {
    for (const craft of Object.keys(VEHICLES) as CraftType[]) {
      const spec = VEHICLES[craft];
      expect(spec.fine, craft).toBeDefined();
      for (const plan of spec.fine!) {
        const width = plan[0]!.length;
        for (const row of plan) {
          expect(row, craft).toMatch(LETTERS);
          expect(row.length, `${craft} ${row}`).toBe(width);
        }
        expect(width, craft).toBeGreaterThanOrEqual(spec.plan[0]!.length * 1.5);
        expect(plan.length, craft).toBeGreaterThanOrEqual(spec.plan.length * 1.3);
      }
    }
    expect(Object.keys(FINE_PLANS).sort()).toEqual(Object.keys(VEHICLES).sort());
  });

  it('takes over only when each letter is resolved', () => {
    const { car } = VEHICLES;
    const fine = car.fine![0]!;
    const along = (fine[0]!.length * FINE_PLAN_SEXTANTS) / car.length;
    const across = (fine.length * FINE_PLAN_SEXTANTS) / car.width;
    expect(fineplanFor(car, 0, along * 1.01, across * 1.01)).toBe(fine);
    expect(fineplanFor(car, 0, along * 0.99, across * 1.01)).toBeUndefined();
    expect(fineplanFor(car, 0, along * 1.01, across * 0.99)).toBeUndefined();
    // Around z19 a car stays on its coarse plan, and draws no wheels.
    expect(drawn(craftAt('car', 1.4)).values.has(WHEEL_PART)).toBe(false);
    // Around z21 it has wheels of dark rubber.
    expect(drawn(craftAt('car', 5.5)).values.has(WHEEL_PART)).toBe(true);
  });

  it('holds the same cells whichever plan it shows, and whichever look', () => {
    const held = (extra: Partial<VisibleAgent>) => {
      const allowed: number[] = [];
      const out = new Uint8Array(COLS * ROWS * 4);
      const parts = createLifeParts(COLS * ROWS, ROWS);
      packLife(
        out,
        {
          ...grid(),
          allowsGroundCell: (_agent, col, row) => {
            allowed.push(row * COLS + col);
            return true;
          },
        },
        [craftAt('car', 5.5, extra)],
        themes.dark,
        glyphIndex,
        null,
        lifeGlyphs,
        { parts },
      );
      return allowed.join();
    };
    const plain = held({});
    for (let id = 1; id < 40; id++) expect(held({ inspectionId: id })).toBe(plain);
  });
});

describe('individual looks', () => {
  it('keeps every craft variant at its dimensions', () => {
    for (const craft of Object.keys(VEHICLES) as CraftType[]) {
      const plans = VEHICLES[craft].fine!;
      for (const plan of plans) {
        expect(plan[0]!.length).toBe(plans[0]![0]!.length);
        expect(plan.length).toBe(plans[0]!.length);
      }
    }
  });

  it('varies cars, trucks, jeepneys and motorcycles from their identity', () => {
    for (const [craft, scale, count] of [
      ['car', 5.5, 4],
      ['truck', 5.5, 3],
      ['jeepney', 5.5, 2],
      ['motorcycle', 5.5, 2],
    ] as const) {
      const looks = new Set<string>();
      for (let id = 1; id < 200; id++)
        looks.add(drawn(craftAt(craft, scale, { inspectionId: id })).layout);
      expect(looks.size, craft).toBe(count);
    }
  });

  it('shows one look for an agent across frames and over the worker frame', () => {
    const agent = craftAt('car', 5.5, { inspectionId: 77 });
    const first = drawn(agent).layout;
    expect(drawn({ ...agent }).layout).toBe(first);
    const [unpacked] = unpackAgents(packAgents([agent]));
    expect(unpacked!.inspectionId).toBe(77);
    expect(drawn(unpacked!).layout).toBe(first);
    // Moving doesn't change it.
    expect(lookOf(77)).toBe(lookOf(77));
  });

  it('falls back to the plain plan without an identity', () => {
    const plain = drawn(craftAt('car', 5.5)).layout;
    expect(drawn(craftAt('car', 5.5, { inspectionId: undefined })).layout).toBe(plain);
  });
});

describe('figures in close-up', () => {
  const figures = ['adult', 'child', 'rower', 'seated'] as const;
  const inks = (rows: readonly string[]) => new Set(rows.join(''));

  it('has hair at every size', () => {
    for (const figure of figures)
      for (const rows of Object.values(FIGURE_MASTERS[figure]))
        expect(inks(rows).has('h'), figure).toBe(true);
    // Umbrellas and props have no hair of their own.
    for (const rows of Object.values(FIGURE_MASTERS.umbrella)) expect(inks(rows).has('h')).toBe(false);
  });

  it('draws a true large adult, not the small one doubled', () => {
    const rows = FIGURE_MASTERS.adult[20]!;
    expect(rows).toHaveLength(20);
    for (const row of rows) expect(row).toHaveLength(20);
    const doubledRows = FIGURE_MASTERS.adult[10]!.flatMap((row) => {
      const wide = [...row].map((c) => c + c).join('');
      return [wide, wide];
    });
    expect(rows.join('')).not.toBe(doubledRows.join(''));
    // Turned half round it is itself, as every walking figure is.
    expect([...rows].reverse().map((r) => [...r].reverse().join(''))).toEqual([...rows]);
  });

  it('puts hair in its own coverage band in the atlas', () => {
    const w = 10;
    const h = 18;
    const data = new Uint8Array(w * h * 4);
    const slot = { data, stride: w * 2, x0: 0, y0: 0, w, h };
    for (const at of [0, 1, 2, 3] as const)
      drawProcedural(
        { ...slot, x0: (at & 1) * w, y0: (at >> 1) * h, stride: w * 2 },
        figureGlyph('adult', false, 0, { slice: at }),
      );
    const seen = new Set(data);
    expect(seen.has(FIGURE_HAIR)).toBe(true);
    expect(seen.has(FIGURE_TONE)).toBe(true);
    expect(seen.has(255)).toBe(true);
    const pixel = figurePixels({ figure: 'adult', across: false, frame: 0 }, 20);
    expect(pixel(9, 9)).toBe('h');
  });

  it('colors one stamped cell with a shirt and skin together', () => {
    const scale = 7;
    const agent = {
      kind: 'person',
      lng: 60.2,
      lat: 40.2,
      paint: Paint.red,
      flap: 0,
      ahead: [60.2 + scale, 40.2],
    } as VisibleAgent;
    const { values, parts, out } = drawn(agent);
    expect(values.has(PersonPart.figure)).toBe(true);
    expect(values.has(PersonPart.skin) || values.has(PersonPart.hair)).toBe(true);
    let mixed = 0;
    for (let cell = 0; cell < COLS * ROWS; cell++) {
      if (!out[cell * 4 + 2]) continue;
      expect(parts.texels[cell * 4 + 3]! & PartsFlag.valid).toBe(PartsFlag.valid);
      const rgb =
        parts.texels[cell * 4]! |
        (parts.texels[cell * 4 + 1]! << 8) |
        (parts.texels[cell * 4 + 2]! << 16);
      const glyph = glyphs[unpackGlyph(out[cell * 4]!, out[cell * 4 + 1]!).glyph]!;
      const mask = sextantGlyphs.indexOf(glyph);
      const seen = new Set<number>();
      for (let s = 0; s < 6; s++) if (mask & (1 << s)) seen.add(sextantOf(rgb, s));
      if (seen.size > 1) mixed++;
    }
    expect(mixed).toBeGreaterThan(0);
  });

  it('keeps hair as skin without the layer', () => {
    const agent = {
      kind: 'person',
      lng: 60.2,
      lat: 40.2,
      paint: Paint.red,
      flap: 0,
      ahead: [60.2 + 7, 40.2],
    } as VisibleAgent;
    const out = new Uint8Array(COLS * ROWS * 4);
    packLife(out, grid(), [agent], themes.dark, glyphIndex, null, lifeGlyphs);
    let any = false;
    for (let cell = 0; cell < COLS * ROWS; cell++) {
      if (out[cell * 4 + 2] === 0) continue;
      any = true;
      expect((out[cell * 4 + 3]! >> 4) & 7).not.toBe(PersonPart.hair);
    }
    expect(any).toBe(true);
  });

  it('reads the same ink through figureInk as the master holds', () => {
    expect(figureInk('adult', 0, 0.5, 0.5, 10)).toBe('h');
  });

  it('keeps stamped pets and birds in the layer, with bits unchanged', () => {
    const dog = {
      kind: 'dog',
      lng: 60.2,
      lat: 40.2,
      paint: Paint.cream,
      flap: 0,
      ahead: [60.2 + 12, 40.2],
    } as VisibleAgent;
    const { parts, out } = drawn(dog);
    expect(parts.end).toBeGreaterThan(parts.first);
    for (let cell = 0; cell < COLS * ROWS; cell++)
      if (out[cell * 4 + 2]) expect(out[cell * 4 + 2]).toBe(agentBit.dog);
    expect(agentBit.dog).toBe(CellBit.person);
  });
});

describe('the atlas and the shader', () => {
  it('stays within the glyph table in both themes', () => {
    for (const theme of Object.values(themes))
      expect(mapGlyphs(theme).length).toBeLessThanOrEqual(MAX_GLYPHS);
  });

  it('colors a wheel only from the part layer', () => {
    const shader = glyphFragmentFor();
    expect(shader).toContain(`wheel = painted && (value & 7) == ${WHEEL_PART}`);
    expect(shader).toContain('vec3 hairColor(int index)');
    expect(VehiclePart.mini).toBe(WHEEL_PART);
  });
});

describe('walk cycle', () => {
  const stride = 0.7;
  const glyphsWithWalk = [...glyphs, ...PASSING_GLYPHS];
  const walkIndex = (g: string) => {
    const known = glyphsWithWalk.indexOf(g);
    if (known >= 0) return known;
    glyphsWithWalk.push(g);
    return glyphsWithWalk.length - 1;
  };

  it('goes through four phases, flipping feet where it always did', () => {
    const phases: number[] = [];
    for (let walked = 0; walked < stride * 4; walked += stride / 2)
      phases.push(walkFlap(walked + 0.001, stride));
    expect(phases.slice(0, 4)).toEqual([0, 2, 1, 3]);
    expect(phases.slice(4)).toEqual([0, 2, 1, 3]);
    for (let walked = 0; walked < 10; walked += 0.013) {
      const before = Math.floor(walked / stride) & 1;
      expect(walkFlap(walked, stride) & 1).toBe(before);
      const started = (Math.floor(walked / stride) + 1) & 1;
      expect(walkFlap(walked, stride, 1) & 1).toBe(started);
    }
  });

  const walker = (scale: number, flap: number): VisibleAgent =>
    ({
      kind: 'person',
      lng: 60.5,
      lat: 40.5,
      paint: Paint.red,
      flap: 0,
      ahead: [60.5 + scale, 40.5],
      people: [{ figure: 'adult', paint: Paint.red, lateral: 0, back: 0, flap }],
    }) as VisibleAgent;
  const pack = (agent: VisibleAgent, withLayer = true) => {
    const out = new Uint8Array(COLS * ROWS * 4);
    const parts = withLayer ? createLifeParts(COLS * ROWS, ROWS) : undefined;
    packLife(out, grid(), [agent], themes.dark, walkIndex, null, buildLifeGlyphs(walkIndex), {
      parts,
    });
    return out;
  };

  it('keeps the one-cell figures on their two steps', () => {
    const scale = 1.5;
    for (const frame of [0, 1])
      expect([...pack(walker(scale, frame | FLAP_PASSING))]).toEqual([...pack(walker(scale, frame))]);
  });

  it('draws passing poses at 2×2 and stamped, only with the layer', () => {
    const big = 3.5;
    expect([...pack(walker(big, FLAP_PASSING))]).not.toEqual([...pack(walker(big, 0))]);
    const cellGlyph = (out: Uint8Array) => {
      const found = new Set<string>();
      for (let i = 0; i < COLS * ROWS; i++)
        if (out[i * 4 + 2])
          found.add(glyphsWithWalk[unpackGlyph(out[i * 4]!, out[i * 4 + 1]!).glyph]!);
      return found;
    };
    const glyphSet = cellGlyph(pack(walker(big, FLAP_PASSING)));
    expect(glyphSet.has(passingGlyph(true, 0))).toBe(true);
    // Low keeps two steps.
    expect([...pack(walker(big, FLAP_PASSING), false)]).toEqual([...pack(walker(big, 0), false)]);
    const stamped = 7;
    expect([...pack(walker(stamped, FLAP_PASSING))]).not.toEqual([...pack(walker(stamped, 0))]);
  });

  it('keeps posed figures still', () => {
    const posed = walker(3.5, FLAP_PASSING);
    posed.people![0] = { ...posed.people![0]!, pose: 'attentive' };
    const still = walker(3.5, 0);
    still.people![0] = { ...still.people![0]!, pose: 'attentive' };
    expect([...pack(posed)]).toEqual([...pack(still)]);
  });

  it('has passing masters at every size of a walker, without a stray arm', () => {
    expect(figureInk('adult', 0, 0.5, 0.5, 10, 0, undefined, true)).toBe('h');
    expect(figureInk('adult', 0, 0.85, 0.05, 10, 0, undefined, true)).toBe('.');
    expect(figureInk('adult', 0, 0.85, 0.05, 10, 0, undefined, false)).toBe('o');
  });
});
