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
