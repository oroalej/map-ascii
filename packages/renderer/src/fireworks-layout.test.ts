import { describe, expect, it } from 'vitest';
import { FIREWORK_VARIANTS, resolveSeason, epochDay, type SeasonConfig } from '@atlas/shared';
import city from '../../content/cities/naga/city.json';
import {
  FIREWORKS,
  FIREWORK_INSTANCE_COUNT,
  fireworkInstances,
  fireworkScale,
  fireworkShellCount,
  fireworkShells,
  fireworkTime,
  fireworkVariantCodes,
} from './fireworks-layout';
import { placeGrid, type View } from './grid';
import { mapGlyphs, themes } from './theme';

const view: View = {
  camera: { lng: 123.185, lat: 13.625, zoom: 19 },
  dpr: 1,
  width: 1000,
  height: 800,
  cellDev: { w: 5, h: 9 },
  labelDev: { w: 10, h: 18 },
  detailZoom: 19,
};
describe('bounded New Year shells', () => {
  it('uses a fixed particle cap with smoke underneath trails and tips', () => {
    const instances = fireworkInstances();
    expect(instances.length).toBe(FIREWORK_INSTANCE_COUNT * 4);
    expect(FIREWORK_INSTANCE_COUNT).toBeLessThan(9000);
    expect(instances.byteLength).toBeLessThan(150_000);
    for (let i = 0; i < instances.length; i += 4) {
      expect(instances[i]).toBeGreaterThanOrEqual(0);
      expect(instances[i]).toBeLessThan(FIREWORKS.shells);
      expect(instances[i + 1]).toBeLessThan(instances[i + 3] ? FIREWORKS.smoke : FIREWORKS.stars);
      expect(instances[i + 2]).toBeLessThan(FIREWORKS.tails);
    }
    expect(instances[FIREWORKS.shells * FIREWORKS.smoke * 4 - 1]).toBe(1);
    expect(instances[FIREWORKS.shells * FIREWORKS.smoke * 4 + 3]).toBe(0);
    const sparks = FIREWORKS.shells * FIREWORKS.smoke * 4;
    expect([...instances.slice(sparks, sparks + 4)]).toEqual([0, 0, FIREWORKS.tails - 1, 0]);
    const secondShell = sparks + FIREWORKS.stars * FIREWORKS.tails * 4;
    expect([...instances.slice(secondShell, secondShell + 4)]).toEqual([
      1,
      0,
      FIREWORKS.tails - 1,
      0,
    ]);
    expect(fireworkInstances()).toEqual(instances);
  });
  it('keeps world anchors and seeds stable under fractional pans, with bounded radii at every DPR', () => {
    const placement = placeGrid(view, view.cellDev, 202, 92);
    const a = new Float32Array(FIREWORKS.shells * 4),
      b = new Float32Array(FIREWORKS.shells * 4);
    const count = fireworkShells(view, placement.grid, a);
    expect(count).toBe(49);
    expect(new Set(Array.from({ length: count }, (_, i) => a[i * 4 + 2]! & 3))).toEqual(
      new Set([0, 1, 2]),
    );
    fireworkShells(
      view,
      {
        ...placement.grid,
        shiftX: placement.grid.shiftX + 0.5,
        shiftY: placement.grid.shiftY + 0.25,
      },
      b,
    );
    for (let i = 0; i < count * 4; i += 4) {
      expect(b[i]).toBeCloseTo(a[i]! - 0.5, 3);
      expect(b[i + 1]).toBeCloseTo(a[i + 1]! - 0.25, 3);
      expect(b[i + 2]).toBe(a[i + 2]);
      expect(b[i + 3]).toBe(a[i + 3]);
    }
    for (const dpr of [1, 1.25, 2, 3]) {
      const v = {
        ...view,
        dpr,
        width: view.width * dpr,
        height: view.height * dpr,
        cellDev: { w: 5 * dpr, h: 9 * dpr },
      };
      fireworkShells(v, placeGrid(v, v.cellDev, 202, 92).grid, b);
      for (let i = 0; i < count * 4; i += 4) {
        expect([...b.slice(i, i + 4)].every(Number.isFinite)).toBe(true);
        expect(b[i + 3]! / dpr).toBeGreaterThanOrEqual(120);
        expect(b[i + 3]! / dpr).toBeLessThanOrEqual(199);
      }
    }
  });
  it('bounds the GPU clock and holds reduced motion steady, without requiring new glyphs', () => {
    expect(fireworkTime(2, false)).not.toBe(fireworkTime(3, false));
    for (const time of [0, 1, 10000000, -5, NaN, Infinity]) {
      expect(fireworkTime(time, true)).toBe(0);
      expect(fireworkTime(time, false)).toBeGreaterThanOrEqual(0);
      expect(fireworkTime(time, false)).toBeLessThan(FIREWORKS.cycle * 256);
    }
    for (const theme of Object.values(themes))
      for (const glyph of ['·', '*', '+', '─', '╱', '│', '╲'])
        expect(mapGlyphs(theme)).toContain(glyph);
    expect(fireworkVariantCodes({ label: 'Display', variants: [...FIREWORK_VARIANTS] })).toEqual([
      0, 1, 2, 3,
    ]);
  });
  it('keeps shared burst centers, seeds and phases fixed through zoom and resize', () => {
    const sites = (v: View) => {
      const grid = placeGrid(v, v.cellDev, 202, 92).grid;
      const out = new Float32Array(FIREWORKS.shells * 4);
      const count = fireworkShells(v, grid, out);
      const scale = v.dpr * fireworkScale(v.camera.zoom);
      const left = grid.originCol * v.cellDev.w + grid.shiftX;
      const top = grid.originRow * v.cellDev.h + grid.shiftY;
      const result = new Map<number, number[]>();
      for (let i = 0; i < count * 4; i += 4)
        result.set(out[i + 2]!, [
          (out[i]! + left) / scale,
          (out[i + 1]! + top) / scale,
          out[i + 3]! / scale,
        ]);
      return result;
    };
    const initial = sites(view);
    for (const zoom of [19.01, 19.5, 20, 20.25]) {
      const next = sites({ ...view, camera: { ...view.camera, zoom } });
      const shared = [...initial.keys()].filter((seed) => next.has(seed));
      // A close view covers less ground and may select a finer lattice. Shared sites
      // retain identity; a small fractional zoom must retain most of the display.
      expect(shared.length, `shared sites at zoom ${zoom}`).toBeGreaterThanOrEqual(
        zoom === 19.01 ? 16 : 1,
      );
      for (const seed of shared)
        for (let dimension = 0; dimension < 3; dimension++)
          expect(next.get(seed)![dimension]).toBeCloseTo(initial.get(seed)![dimension]!, 3);
    }
    for (const [width, height, dpr] of [
      [1200, 900, 1],
      [1800, 1000, 1],
      [2000, 1600, 2],
    ] as const) {
      const next = sites({
        ...view,
        width,
        height,
        dpr,
        cellDev: { w: 5 * dpr, h: 9 * dpr },
      });
      const shared = [...initial.keys()].filter((seed) => next.has(seed));
      expect(shared.length).toBeGreaterThanOrEqual(3);
      for (const seed of shared)
        for (let dimension = 0; dimension < 3; dimension++)
          expect(next.get(seed)![dimension]).toBeCloseTo(initial.get(seed)![dimension]!, 3);
    }
  });
  it('adds exactly one large distant burst, thins close views and hides everything at z21', () => {
    const out = new Float32Array(FIREWORKS.shells * 4);
    for (const [zoom, count] of [
      [7, 50],
      [15.99, 50],
      [16, 50],
      [16.001, 49],
      [19.999, 49],
      [20, 4],
      [20.999, 4],
      [21, 0],
      [22, 0],
      [6, 0],
      [NaN, 0],
      [Infinity, 0],
    ] as const) {
      const v = { ...view, camera: { ...view.camera, zoom } };
      expect(fireworkShellCount(zoom)).toBe(count);
      expect(fireworkShells(v, placeGrid(v, v.cellDev, 202, 92).grid, out)).toBe(count);
      expect(out.slice(count * 4).every((value) => value === 0)).toBe(true);
      if (zoom >= 7 && zoom <= 16) {
        const large = 49 * 4;
        expect(out[large]).toBe(view.width / 2);
        expect(out[large + 1]).toBe(view.height / 2);
        expect(out[large + 3]).toBe(320);
        expect(
          Array.from({ length: 49 }, (_, i) => out[i * 4 + 3]!).every(
            (radius) => radius >= 72 && radius < 120,
          ),
        ).toBe(true);
      }
    }
    for (const dpr of [1, 2, 3]) {
      const v = {
        ...view,
        camera: { ...view.camera, zoom: 16 },
        dpr,
        width: 390 * dpr,
        height: 844 * dpr,
        cellDev: { w: 5 * dpr, h: 9 * dpr },
      };
      fireworkShells(v, placeGrid(v, v.cellDev, 202, 92).grid, out);
      expect(out[49 * 4 + 3]! / dpr).toBeCloseTo(390 * 0.45, 3);
    }
  });
  it('keeps several visible bursts overlapping throughout a complete display cycle', () => {
    const out = new Float32Array(FIREWORKS.shells * 4);
    const count = fireworkShells(view, placeGrid(view, view.cellDev, 202, 92).grid, out);
    let peak = 0;
    for (let time = 0; time < FIREWORKS.cycle; time += 0.1) {
      let active = 0;
      for (let i = 0; i < count * 4; i += 4) {
        if (out[i]! < 0 || out[i]! > view.width || out[i + 1]! < 0 || out[i + 1]! > view.height)
          continue;
        const age =
          ((time + ((out[i + 2]! % 4) / 3) * FIREWORKS.cycle) % FIREWORKS.cycle) - FIREWORKS.burst;
        if (age > 0.05 && age < FIREWORKS.sparkLife - 0.05) active++;
      }
      expect(active).toBeGreaterThanOrEqual(8);
      peak = Math.max(peak, active);
    }
    expect(peak).toBeGreaterThanOrEqual(12);
  });
  it('magnifies burst and smoke extent with continuous zoom rather than map-cell density', () => {
    const radii = (zoom: number, dpr: number, cell: number) => {
      const v = {
        ...view,
        camera: { ...view.camera, zoom },
        dpr,
        cellDev: { w: cell * dpr, h: cell * 1.8 * dpr },
      };
      const out = new Float32Array(FIREWORKS.shells * 4);
      const count = fireworkShells(v, placeGrid(v, v.cellDev, 202, 92).grid, out);
      return Array.from({ length: Math.min(count, 49) }, (_, i) => ({
        seed: out[i * 4 + 2]!,
        radius: out[i * 4 + 3]! / dpr,
      }));
    };
    for (const zoom of [7, 14, 15.5, 17, 18.5, 19, 19.5, 20, 20.5, 21]) {
      expect(fireworkScale(zoom)).toBeCloseTo(2 ** (zoom - 19));
      for (const dpr of [1, 1.25, 2, 3])
        for (const cell of [5, 6, 8])
          for (const { seed, radius } of radii(zoom, dpr, cell))
            expect(radius).toBeCloseTo(
              (FIREWORKS.radius + (seed % FIREWORKS.radiusVariation)) *
                Math.max(0.6, 2 ** (zoom - 19)),
              3,
            );
    }
    expect(fireworkScale(19.5) / fireworkScale(19)).toBeCloseTo(Math.SQRT2);
    expect(fireworkScale(20) / fireworkScale(19)).toBe(2);
    expect(fireworkScale(21) / fireworkScale(19)).toBe(4);
    for (const zoom of [-1000, 1000, NaN, Infinity]) {
      expect(Number.isFinite(fireworkScale(zoom))).toBe(true);
      expect(fireworkScale(zoom)).toBeGreaterThanOrEqual(1 / 4096);
      expect(fireworkScale(zoom)).toBeLessThanOrEqual(4);
    }
  });
  it('the real city pack selects New Year automatically and explicitly, without replacing Christmas previews', () => {
    const seasons = city.life.seasons as SeasonConfig[];
    expect(
      resolveSeason(seasons, 'auto', 2026, epochDay(2026, 12, 31))?.fireworks?.variants,
    ).toEqual(FIREWORK_VARIANTS);
    expect(resolveSeason(seasons, 'auto', 2027, epochDay(2027, 1, 1))?.id).toBe('new-year');
    expect(resolveSeason(seasons, 'auto', 2027, epochDay(2027, 1, 2))?.id).toBe('christmas');
    expect(resolveSeason(seasons, 'new-year', 2026, epochDay(2026, 7, 10))?.id).toBe('new-year');
    expect(resolveSeason(seasons, 'christmas', 2026, epochDay(2026, 12, 31))?.id).toBe('christmas');
  });
});
