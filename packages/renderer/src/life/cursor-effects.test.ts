import { expect, it } from 'vitest';
import { CursorEffects } from './cursor-effects';
import { placeGrid } from '../grid';
it('retains four geographic rings, subtracts a large origin before upload and expires/clears them', () => {
  const effects = new CursorEffects(),
    view = {
      camera: { lng: 123, lat: 13, zoom: 21 },
      dpr: 2,
      width: 1920,
      height: 1080,
    };
  const grid = placeGrid(view, { w: 10, h: 18 }, 200, 80);
  for (let i = 0; i < 8; i++)
    effects.move([i * 20, 10], [123 + i / 1000000, 13], i * 10, { w: 5, h: 9 });
  const rings = effects.project(grid, 100);
  expect(rings).toHaveLength(4);
  expect(grid.grid.originCol).toBeGreaterThan(1e7);
  expect(Math.abs(rings[0]![0])).toBeLessThan(200);
  expect(effects.project(grid, 1600)).toEqual([]);
  effects.move([0, 0], [123, 13], 1700, { w: 5, h: 9 });
  effects.clear();
  expect(effects.project(grid, 1700)).toEqual([]);
});
it('seeds movement, averages CSS velocity, keeps rest on duplicates and rebases without a gust', () => {
  const e = new CursorEffects(),
    cell = { w: 5, h: 9 };
  e.move([0, 0], [123, 13], 0, cell);
  expect(e.gust(0, 1)).toBeUndefined();
  e.move([50, 90], [123, 13], 120, cell);
  const gust = e.gust(120, 1)!;
  expect(gust.strength).toBe(1);
  expect(gust.dir[1] / gust.dir[0]).toBeCloseTo(1.8);
  e.move([50, 90], [123, 13], 420, cell);
  expect(e.rest(420)).toBe(0.3);
  expect(e.gust(420, 1)!.strength).toBe(0.5);
  expect(e.gust(720, 1)).toBeUndefined();
  e.move([60, 90], [123, 13], 730, { w: 10, h: 18 });
  expect(e.gust(730, 1)).toBeUndefined();
  e.rebase();
  e.move([70, 90], [123, 13], 740, cell);
  expect(e.gust(740, 1)).toBeUndefined();
  e.clear();
  expect(e.rest(750)).toBeUndefined();
});

it('omits and clears disabled rings while retaining cursor wind and rest sampling', () => {
  const effects = new CursorEffects(),
    cell = { w: 5, h: 9 };
  effects.move([0, 0], [123, 13], 0, cell);
  expect(effects.active(0)).toBe(true);
  effects.move([50, 0], [123, 13], 120, cell, false);
  expect(effects.active(120)).toBe(false);
  expect(effects.gust(120, 1)!.strength).toBeGreaterThan(0);
  effects.move([50, 0], [123, 13], 220, cell, false);
  expect(effects.rest(220)).toBe(0.1);
});
