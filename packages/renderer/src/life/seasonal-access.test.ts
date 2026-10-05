import { expect, it } from 'vitest';
import { localMetricProjection, type SeasonalAccessRecord } from '@atlas/shared';
import { packAccess, AccessInk } from './seasonal-access';
import { mapGlyphs, themes } from '../theme';
import type { FixtureGrid } from './fixtures';

const projection = localMetricProjection([123, 13]);
const record: SeasonalAccessRecord = {
  version: 1,
  kind: 'access-path',
  id: 'parking',
  installation: 'parking',
  season: 'winter',
  anchor: 'osm:way/1',
  seed: 2,
  style: 'parking',
  width_m: 6,
  from: projection.from([0, 0]),
  to: projection.from([14, 0]),
};
const grid: FixtureGrid = {
  cols: 200,
  rows: 140,
  cellWidth: 5,
  cellHeight: 9,
  toCell: (lng, lat) => {
    const [x, y] = projection.to([lng, lat]);
    return [20 + x * 8, 70 - y * 5];
  },
};
function packed(r = record, shift = 0) {
  const out = new Map<string, { glyph: string; info: number }>();
  packAccess(
    r,
    {
      ...grid,
      toCell: (lng, lat) => {
        const p = grid.toCell(lng, lat);
        return [p[0] + shift, p[1]];
      },
    },
    (x, y, glyph, _part, info) => {
      out.set(`${Math.floor(x) - shift}/${Math.floor(y)}`, { glyph, info });
      return true;
    },
  );
  return out;
}
it('distinguishes textured walks, thin curbs and flat ends instead of solid blocks', () => {
  const cells = packed({ ...record, style: 'walkway', width_m: 1.2 });
  const values = [...cells.values()];
  expect(new Set(values.map((v) => v.info >> 2))).toEqual(
    new Set([AccessInk.paving, AccessInk.curb, AccessInk.joint]),
  );
  expect(values.some((v) => '░▒▓█'.includes(v.glyph))).toBe(false);
  expect(
    [...cells.keys()].every((k) => {
      const [x] = k.split('/').map(Number);
      return x! >= 20 && x! < 132;
    }),
  ).toBe(true);
  expect(packed({ ...record, style: 'walkway', width_m: 1.2 }, 8)).toEqual(cells);
});
it('marks two parallel bays separately from their clear access lane and remains anchored/clipped', () => {
  const cells = packed(),
    values = [...cells.values()];
  expect(values.filter((v) => v.glyph === 'P')).toHaveLength(2);
  expect(values.filter((v) => v.glyph === '→')).toHaveLength(1);
  expect(new Set(values.map((v) => v.info >> 2))).toEqual(
    new Set([AccessInk.paving, AccessInk.curb, AccessInk.marking]),
  );
  const glyphs = new Set(mapGlyphs(themes.dark));
  for (const v of values) expect(glyphs.has(v.glyph)).toBe(true);
  // Bay labels occupy the road-side row; the aisle arrow stays in the opposite clear half.
  const labels = [...cells]
    .filter(([, v]) => v.glyph === 'P')
    .map(([k]) => Number(k.split('/')[1]));
  const arrow = [...cells].find(([, v]) => v.glyph === '→')!;
  expect(labels.every((y) => y > Number(arrow[0].split('/')[1]))).toBe(true);
  expect(packed(record, 8)).toEqual(cells);
  const clipped = packed(record, -50);
  for (const [key, value] of clipped) expect(cells.get(key)).toEqual(value);
});
it('bounds offscreen bay work and rejects degenerate projections', () => {
  let writes = 0;
  let projections = 0;
  const countedGrid = {
    ...grid,
    toCell: (lng: number, lat: number) => {
      projections++;
      return grid.toCell(lng, lat);
    },
  };
  packAccess({ ...record, to: projection.from([1000000, 0]) }, countedGrid, (x, y) => {
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThan(grid.cols);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(y).toBeLessThan(grid.rows);
    writes++;
    return true;
  });
  expect(writes).toBeGreaterThan(0);
  expect(writes).toBeLessThan(grid.cols * grid.rows);
  expect(projections).toBeLessThan(30);
  expect(
    [...packed({ ...record, to: projection.from([0.5, 0]) }).values()].some((v) => v.glyph === 'P'),
  ).toBe(false);
  expect(
    packAccess(record, { ...grid, toCell: () => [1, 1] }, () => {
      throw new Error('unexpected write');
    }),
  ).toBe(false);
});
