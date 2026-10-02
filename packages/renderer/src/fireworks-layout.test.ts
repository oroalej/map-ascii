import { describe, expect, it } from 'vitest';
import { FIREWORK_VARIANTS, resolveSeason, epochDay, type SeasonConfig } from '@atlas/shared';
import city from '../../content/cities/naga/city.json';
import {
  FIREWORKS,
  FIREWORK_INSTANCE_COUNT,
  fireworkInstances,
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
    expect(FIREWORK_INSTANCE_COUNT).toBeLessThan(1600);
    expect(instances.byteLength).toBeLessThan(26_000);
    for (let i = 0; i < instances.length; i += 4) {
      expect(instances[i]).toBeGreaterThanOrEqual(0);
      expect(instances[i]).toBeLessThan(FIREWORKS.shells);
      expect(instances[i + 1]).toBeLessThan(instances[i + 3] ? FIREWORKS.smoke : FIREWORKS.stars);
      expect(instances[i + 2]).toBeLessThan(FIREWORKS.tails);
    }
    expect(instances[FIREWORKS.shells * FIREWORKS.smoke * 4 - 1]).toBe(1);
    expect(instances[FIREWORKS.shells * FIREWORKS.smoke * 4 + 3]).toBe(0);
    expect(fireworkInstances()).toEqual(instances);
  });
  it('keeps world anchors and seeds stable under fractional pans, with bounded radii at every DPR', () => {
    const placement = placeGrid(view, view.cellDev, 202, 92);
    const a = new Float32Array(36),
      b = new Float32Array(36);
    expect(fireworkShells(view, placement.grid, a)).toBe(9);
    expect(new Set(Array.from({ length: 9 }, (_, i) => a[i * 4 + 2]! & 3))).toEqual(
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
    for (let i = 0; i < a.length; i += 4) {
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
      for (let i = 0; i < b.length; i += 4) {
        expect([...b.slice(i, i + 4)].every(Number.isFinite)).toBe(true);
        expect(b[i + 3]! / dpr).toBeGreaterThanOrEqual(75);
        expect(b[i + 3]! / dpr).toBeLessThanOrEqual(139);
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
