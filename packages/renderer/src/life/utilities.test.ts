import { describe, expect, it, vi } from 'vitest';
import { offsetUtility, utilitySpanId, type UtilityPole, type UtilityRecord } from '@atlas/shared';
import {
  packFixtures,
  updateFixtureFlags,
  FixturePart,
  type FixtureGrid,
  type StreetFixture,
} from './fixtures';
import {
  clipUtilityLine,
  createUtilityFixtureCache,
  utilityFixtures,
  utilityViewportVisibility,
  createUtilityPackingScratch,
  packUtilityFixtures,
} from './utilities';
import { LampState } from './lights';

const origin: [number, number] = [123.18, 13.62];
const pole = (id: string, x: number, y: number): UtilityPole => ({
  id,
  road: 'r',
  component: 'r/0',
  at: offsetUtility(origin, x, y),
  heading: [1, 0],
  normal: [0, 1],
  transformer: false,
});
const a = pole('a', -20, 0),
  b = pole('b', 20, 0);
const span: UtilityRecord = {
  version: 1,
  kind: 'span',
  span: { id: utilitySpanId(a.id, b.id), kind: 'corridor', from: a, to: b, seed: 7 },
};
const grid: FixtureGrid = {
  cols: 100,
  rows: 60,
  cellWidth: 5,
  cellHeight: 9,
  toCell: (lng, lat) => [
    (lng - origin[0]) * 111319.49 * Math.cos((origin[1] * Math.PI) / 180) + 50.5,
    (lat - origin[1]) * 111319.49 + 30.5,
  ],
};
const glyphs: string[] = [];
const glyph = (s: string) => {
  if (!glyphs.includes(s)) glyphs.push(s);
  return glyphs.indexOf(s) + 300;
};
const pack = (fixtures: StreetFixture[], zoom = 20, g = grid) =>
  packFixtures(new Uint8Array(g.cols * g.rows * 4), g, fixtures, zoom, glyph, 0);

describe('utility fixture composition', () => {
  it('preserves poles and wires when animated flag cloth crosses their cells', () => {
    const base = offsetUtility(origin, -10, 14);
    const flag: StreetFixture = {
      kind: 'flagpole',
      flag: 'PH',
      base,
      tip: offsetUtility(base, 0, -1),
      forward: offsetUtility(base, 0, -1),
      right: offsetUtility(base, 1, 0),
      seed: 17,
    };
    const clothOnly = pack([flag]);
    const packed = pack([flag, ...utilityFixtures([span])]);
    expect(packed.utilityCells.length).toBeGreaterThan(0);
    expect(clothOnly.cloth.cells.some((at) => packed.utilityCells.includes(at / 4))).toBe(true);
    const snapshot = () =>
      packed.utilityCells.map((cell) => packed.texels.slice(cell * 4, cell * 4 + 4));
    const fixed = snapshot();
    for (const time of [0.2, 0.8, 1.4, 2.1]) {
      expect(updateFixtureFlags(packed, { time, strength: 1.5 })).toBe(true);
      expect(snapshot()).toEqual(fixed);
      expect(packed.cloth.cells.every((at) => !packed.utilityCells.includes(at / 4))).toBe(true);
    }
  });

  it('retains both supports from a span alone, deduplicates buffered copies and invalidates on eviction', () => {
    const cache = createUtilityFixtureCache();
    const group = [span];
    const first = cache([group]);
    expect(first).toHaveLength(3);
    expect(cache([group])).toBe(first);
    expect(cache([group, structuredClone(group)])).toEqual(first);
    expect(cache([])).toEqual([]);
    expect(cache([group])).not.toBe(first);
  });
  it('fades exactly at 18, 18.25 and 18.5, and reports only viewport marks', () => {
    for (const [zoom, alpha] of [
      [18, 0],
      [18.25, 128],
      [18.5, 255],
    ]) {
      const p = pack(utilityFixtures([span]), zoom);
      expect(Math.max(...p.texels.filter((_, i) => i % 4 === 3))).toBe(alpha);
      expect(p.visibility.utilities).toBe(alpha! > 0);
    }
    const p = pack(utilityFixtures([span]), 20, { ...grid, visible: () => false });
    expect(p.visibility.utilities).toBe(false);
    expect(utilityViewportVisibility(p.utilityCells, grid.cols, () => true)).toBe(true);
  });
  it('reuses merged fixtures across reordering but detects reference replacement and duplicate counts', () => {
    const cache = createUtilityFixtureCache();
    const one = [span],
      two = [{ version: 1, kind: 'pole', pole: a } satisfies UtilityRecord];
    const first = cache([one, two, one]);
    expect(cache([one, one, two])).toBe(first);
    const differentCounts = cache([one, two, two]);
    expect(differentCounts).not.toBe(first);
    expect(cache([structuredClone(one), two, two])).not.toBe(differentCounts);
  });
  it('reuses and clears utility scratch arrays, including resizing and inactive calls', () => {
    const scratch = createUtilityPackingScratch();
    const fixtures = utilityFixtures([span]);
    const run = (fixtures: ReturnType<typeof utilityFixtures>, g = grid, zoom = 19.5) => {
      const out = new Uint8Array(g.cols * g.rows * 4);
      packUtilityFixtures(out, g, fixtures, zoom, glyph, new Map(), scratch);
      return out;
    };
    run(fixtures);
    const { owners, cables } = scratch;
    const onlyPole = utilityFixtures([{ version: 1, kind: 'pole', pole: a }]);
    expect(run(onlyPole)).toEqual(pack(onlyPole, 19.5).texels);
    expect(scratch.owners).toBe(owners);
    expect(scratch.cables).toBe(cables);
    run(fixtures, { ...grid, cols: 120 });
    expect(scratch.owners).not.toBe(owners);
    expect(scratch.owners).toHaveLength(120 * grid.rows);
    const inactive = createUtilityPackingScratch();
    packUtilityFixtures(
      new Uint8Array(grid.cols * grid.rows * 4),
      grid,
      fixtures,
      18,
      glyph,
      new Map(),
      inactive,
    );
    expect(inactive.owners).toHaveLength(0);
    expect(inactive.cables).toHaveLength(0);
  });
  it('skips shared-base lookup when no utilities are drawable', () => {
    const support = vi.fn(() => 'matching');
    const lamp: StreetFixture = {
      kind: 'streetlight',
      base: a.at,
      tip: offsetUtility(a.at, 2, 0),
      forward: offsetUtility(a.at, 1, 0),
      right: offsetUtility(a.at, 0, 1),
      roadCenter: offsetUtility(a.at, 4, 0),
      state: LampState.working,
      seed: 1,
      get supportKey() {
        return support();
      },
    };
    pack([lamp]);
    pack([lamp, ...utilityFixtures([span])], 18);
    expect(support).not.toHaveBeenCalled();
    pack([lamp, ...utilityFixtures([span])], 18.5);
    expect(support).toHaveBeenCalled();
  });
  it('is commutative for crossings and cannot overwrite another hardware owner', () => {
    const c = pole('c', 0, -20),
      d = pole('d', 0, 20);
    const other: UtilityRecord = {
      version: 1,
      kind: 'span',
      span: { id: utilitySpanId(c.id, d.id), kind: 'corridor', from: c, to: d, seed: 9 },
    };
    const fixtures = utilityFixtures([span, other]);
    expect(pack(fixtures).texels).toEqual(pack(fixtures.slice().reverse()).texels);
    const lamp: StreetFixture = {
      kind: 'streetlight',
      base: a.at,
      tip: offsetUtility(a.at, 2, 0),
      forward: offsetUtility(a.at, 1, 0),
      right: offsetUtility(a.at, 0, 1),
      roadCenter: offsetUtility(a.at, 4, 0),
      state: LampState.working,
      seed: 1,
      supportKey: 'matching',
    };
    const base = pack([lamp]);
    const combined = pack([lamp, ...fixtures]);
    for (let i = 0; i < base.texels.length; i += 4)
      if (base.texels[i + 3])
        expect(combined.texels.slice(i, i + 4)).toEqual(base.texels.slice(i, i + 4));
    const shared = { ...a, sharedLamp: 'matching' };
    const matched = pack([lamp, { kind: 'utility-pole', pole: shared }]);
    const at = (30 * grid.cols + 30) * 4;
    expect(matched.texels[at + 1]! & 63).toBe(FixturePart.utilityCap);
    const wrong = pack([lamp, { kind: 'utility-pole', pole: { ...shared, sharedLamp: 'other' } }]);
    expect(wrong.texels[at + 1]! & 63).toBe(FixturePart.base);
  });
  it('clips large offscreen segments without a fixed step cap or changing direction', () => {
    const wide = clipUtilityLine([-10000, 5], [10000, 5], 2000, 10)!;
    expect(wide[0]).toEqual([0, 5]);
    expect(wide[1][0]).toBeCloseTo(2000, 4);
    expect(clipUtilityLine([-10, -10], [-1, -1], 20, 20)).toBeNull();
    const clipped = clipUtilityLine([10, -100], [10, 100], 20, 20)!;
    expect(clipped[0]).toEqual([10, 0]);
    expect(clipped[1][1]).toBeCloseTo(20, 4);
    expect(clipUtilityLine([1, 1], [1, 1], 20, 20)).toEqual([
      [1, 1],
      [1, 1],
    ]);
  });

  it('draws the full clipped span across a grid wider than 512 cells', () => {
    const from = pole('far-a', -10000, 0),
      to = pole('far-b', 10000, 0);
    const records: UtilityRecord[] = [
      {
        version: 1,
        kind: 'span',
        span: {
          id: utilitySpanId(from.id, to.id),
          from,
          to,
          seed: 1,
          kind: 'corridor',
        },
      },
    ];
    const wide = {
      ...grid,
      cols: 2000,
      rows: 10,
      toCell: (lng: number, lat: number): [number, number] => {
        const [x, y] = grid.toCell(lng, lat);
        return [x + 950, y - 25];
      },
    };
    const packed = pack(utilityFixtures(records), 18.5, wide);
    expect(packed.utilityCells).toHaveLength(2000);
    expect(packed.texels[5 * 2000 * 4 + 3]).toBe(255);
    expect(packed.texels[(5 * 2000 + 1999) * 4 + 3]).toBe(255);
  });
});
