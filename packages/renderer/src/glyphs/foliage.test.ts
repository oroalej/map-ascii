import { describe, expect, it } from 'vitest';
import { themes } from '../theme';
import {
  canopyCell,
  canopyGrid,
  canopyShape,
  CANOPY,
  CanopyGlyph,
  crownClumps,
  crownShade,
  crownSun,
  crownTint,
  CROWN_LIGHT,
  foliageVariant,
  foliageShadowHeight,
  inShadow,
  selectGlyph,
  Tone,
} from './select';

const disc = Array.from(
  { length: 41 * 41 },
  (_, i) => [(i % 41) / 20 - 1, Math.floor(i / 41) / 20 - 1] as const,
).filter(([x, y]) => x * x + y * y < 1);
describe('leaf clumps', () => {
  it('is deterministic, has sparse seams and covers all quadrants without a grid bias', () => {
    const means = [0, 0, 0, 0];
    const counts = [0, 0, 0, 0];
    for (let seed = 0; seed < 32; seed++) {
      const values = disc.map(([x, y]) => crownClumps(x, y, seed));
      expect(values).toEqual(disc.map(([x, y]) => crownClumps(x, y, seed)));
      expect(values.filter((c) => c.crevice > 0.6).length / values.length).toBeLessThan(0.3);
      expect(values.filter((c) => c.top > 0.8).length).toBeGreaterThan(100);
      disc.forEach(([x, y], i) => {
        if (x === 0 || y === 0) return;
        const q = (x > 0 ? 1 : 0) + (y > 0 ? 2 : 0);
        means[q]! += values[i]!.top;
        counts[q]!++;
      });
      // Separate local maxima: central clump and six ring clumps survive the seed jitter.
      const tops = disc.filter(([x, y]) => crownClumps(x, y, seed).top > 0.995);
      const distinct: (readonly [number, number])[] = [];
      for (const p of tops)
        if (distinct.every((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.2)) distinct.push(p);
      expect(distinct.length).toBeGreaterThanOrEqual(4);
    }
    const averages = means.map((m, i) => m / counts[i]!);
    expect(Math.max(...averages) / Math.min(...averages)).toBeLessThan(1.1);
  });
  it('keeps bounds, dense sunward tops, sparse creases and flatter night lighting', () => {
    const sun = crownSun({ altitude: 60, azimuth: 270 });
    const noon = disc.map(([x, y]) => crownShade(x, y, crownClumps(x, y, 42), sun));
    const night = disc.map(([x, y]) => crownShade(x, y, crownClumps(x, y, 42), sun, true));
    for (const c of [...noon, ...night]) {
      expect(c.light).toBeGreaterThanOrEqual(CROWN_LIGHT.min);
      expect(c.light).toBeLessThanOrEqual(CROWN_LIGHT.max);
    }
    const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
    const tops = noon.filter((_, i) => crownClumps(...disc[i]!, 42).top > 0.8).map((c) => c.level);
    const seams = noon
      .filter((_, i) => crownClumps(...disc[i]!, 42).crevice > 0.6)
      .map((c) => c.level);
    expect(mean(tops) - mean(seams)).toBeGreaterThan(2);
    const range = (a: typeof noon) =>
      Math.max(...a.map((c) => c.light)) - Math.min(...a.map((c) => c.light));
    expect(range(night)).toBeLessThan(range(noon));
    expect(noon.filter((c) => c.level === 0).length / noon.length).toBeLessThan(0.5);
    const clump = { nx: 0, ny: 0, top: 1, crevice: 0 };
    expect(crownShade(-0.5, 0, clump, sun).light).toBeGreaterThan(
      crownShade(0.5, 0, clump, sun).light,
    );
    expect(crownShade(0.5, 0, clump, [-sun[0], sun[1], sun[2]]).light).toBeCloseTo(
      crownShade(-0.5, 0, clump, sun).light,
    );
  });
  it('uses unit sun vectors and a stable, relative tint per identity', () => {
    for (const altitude of [-10, 0, 1, 25, 60, 90])
      expect(Math.hypot(...crownSun({ altitude, azimuth: 190 }))).toBeCloseTo(1);
    expect(crownSun({ altitude: 1, azimuth: 90 })).toEqual(crownSun({ altitude: 25, azimuth: 90 }));
    expect(
      new Set(Array.from({ length: 100 }, (_, id) => JSON.stringify(crownTint(id)))).size,
    ).toBe(3);
  });
  it('flutters by at most one density step and reapplies rim and identity seam caps', () => {
    for (const [x, y] of disc)
      for (let time = 0; time < 3; time += 0.4) {
        const ctx = { local: [x, y] as const, id: 33 };
        const still = foliageVariant(500, 600, 0, 0, false, ctx);
        expect(foliageVariant(500, 600, 10, 0, false, ctx)).toBe(still);
        expect(Math.abs(foliageVariant(500, 600, time, 1, false, ctx) - still)).toBeLessThanOrEqual(
          1,
        );
        expect(foliageVariant(500, 600, time, 1, true, ctx)).toBeLessThanOrEqual(2);
        expect(
          foliageVariant(500, 600, time, 1, false, { ...ctx, boundary: true }),
        ).toBeLessThanOrEqual(1);
      }
    for (const theme of Object.values(themes)) {
      expect(theme.styles.tree_crown!.glyphs).toEqual(['.', ',', ':', '%', '&', '@']);
      const ctx = {
        x: 500,
        y: 600,
        height: 10,
        time: 0,
        wind: 0,
        local: [0, 0] as const,
        id: 33,
        neighbor: () => 'tree_crown' as const,
        neighborId: () => 34,
      };
      expect(['.', ',']).toContain(selectGlyph(theme, 'tree_crown', ctx));
    }
  });
});

describe('woods lattice', () => {
  const field = Array.from(
    { length: 4096 },
    (_, i) => [500000 + (i % 64), 800000 + Math.floor(i / 64)] as const,
  );
  it('keeps palm/conifer centers, density variation, and sparse creases', () => {
    const centers = field.filter(([x, y]) => canopyShape(x, y).center);
    expect(centers.length).toBeGreaterThan(field.length / 12);
    expect(centers.length).toBeLessThan(field.length / 6);
    for (const [x, y] of centers) {
      expect(canopyCell(x, y, 1).variant).toBe(CanopyGlyph.palm);
      expect([7, 8]).toContain(canopyCell(x, y, 2).variant);
    }
    const seams = field.filter(([x, y]) => canopyShape(x, y).crevice > 0.6);
    expect(seams.length / field.length).toBeGreaterThan(0.05);
    expect(seams.length / field.length).toBeLessThan(0.3);
    expect(new Set(field.map(([x, y]) => canopyCell(x, y).variant)).size).toBeGreaterThan(4);
  });
  it('moves continuously downwind and stays exact after whole-cell leans', () => {
    for (const [x, y] of field.slice(0, 100)) {
      const a = canopyShape(x + 3, y, [3, 0]),
        b = canopyShape(x, y);
      expect(a.seed).toBe(b.seed);
      expect(a.local).toEqual(b.local);
      expect(a.crevice).toBe(b.crevice);
    }
    const changed = field.filter(([x, y]) => {
      const a = canopyShape(x, y, [CANOPY.sway, 0]),
        b = canopyShape(x, y, [CANOPY.sway * 1.1, 0]);
      return a.seed !== b.seed || a.center !== b.center || a.clearing !== b.clearing;
    });
    expect(changed.length / field.length).toBeLessThan(0.25);
  });
  it('keeps crown identities across grid pans and smooth zoom changes', () => {
    const a = canopyGrid([9000000, 6000000], [0.7, 1.4]);
    const b = canopyGrid([9000020, 6000000], [0.7, 1.4]);
    expect(canopyShape(9000030, 6000030, [0, 0], a).seed).toBe(
      canopyShape(9000030, 6000030, [0, 0], b).seed,
    );
    const meterPoint = [6300021, 8400042] as const;
    const seeds = [0.7, 0.70001, 0.71].map(
      (m) =>
        canopyShape(
          meterPoint[0] / m,
          meterPoint[1] / (m * 2),
          [0, 0],
          canopyGrid([9000000, 6000000], [m, m * 2]),
        ).seed,
    );
    expect(new Set(seeds).size).toBe(1);
    expect(CANOPY.meters).toBe(9);
  });
  it('responds to the sun without reseeding its crowns', () => {
    const a = field.map(([x, y]) => canopyCell(x, y, 0, 0, 0, undefined, [-1, 0]));
    const b = field.map(([x, y]) => canopyCell(x, y, 0, 0, 0, undefined, [1, 0]));
    expect(a.filter((c, i) => c.variant !== b[i]!.variant).length).toBeGreaterThan(
      field.length / 10,
    );
    expect(a.some((c) => c.tone === Tone.light)).toBe(true);
  });
});

it('rounds and dapples crown shadows, suppresses crown self-shadow and retains later building casters', () => {
  expect(foliageShadowHeight(10, [0, 0])).toBe(10);
  expect(foliageShadowHeight(10, [1, 0])).toBeCloseTo(5.5);
  const caster = (local: readonly [number, number]) =>
    inShadow(0, (k) => (k === 1 ? 10 : 0), 7, 1, {
      id: 0,
      world: [0, 0],
      at: (k) => (k === 1 ? { id: 1, local } : null),
    });
  expect(caster([0, 0])).toBe(true);
  expect(caster([1, 0])).toBe(false);
  const ctx = {
    id: 42,
    world: [10, 20] as const,
    local: [0, 0] as const,
    at: () => ({ id: 42, local: [0, 0] as const }),
  };
  expect(inShadow(10, () => 30, 1, 1, ctx)).toBe(false);
  expect(
    inShadow(10, (k) => (k === 2 ? 30 : 20), 1, 1, {
      ...ctx,
      at: (k) => (k === 1 ? ctx.at() : null),
    }),
  ).toBe(true);
  const ratio =
    Array.from({ length: 1024 }, (_, x) =>
      inShadow(0, () => 10, 1, 1, { id: 0, world: [x, 0], at: () => ({ id: 1, local: [0, 0] }) }),
    ).filter(Boolean).length / 1024;
  expect(ratio).toBeGreaterThan(0.7);
  expect(ratio).toBeLessThan(0.8);
});
