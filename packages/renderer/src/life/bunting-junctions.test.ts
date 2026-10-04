import { expect, it, vi } from 'vitest';
import { buntingWidth, selectBuntingRows } from './bunting-junctions';
import { packSeasonalFixtures, type SeasonalFixture } from './seasonal';
import type { FixtureGrid } from './fixtures';
import { mapGlyphs, themes } from '../theme';
import { project, unproject } from '../camera';

type Point = [number, number];
type Row = Extract<SeasonalFixture, { kind: 'season-bunting' }>;
const grid: FixtureGrid = {
  cols: 100,
  rows: 100,
  cellWidth: 5,
  cellHeight: 9,
  toCell: (x, y) => [x, y],
};
// Specify the actual hanging span, undoing the offset applied by projection.
function row(id: string, from: Point, to: Point, width = 9, corridor = 0, road = 'osm:way/1'): Row {
  const dx = to[0] - from[0],
    dy = to[1] - from[1],
    length = Math.hypot(dx, dy);
  const ox = (-dy / length) * 1.5,
    oy = (dx / length) * 1.5;
  return {
    kind: 'season-bunting',
    id,
    from: [from[0] - ox, from[1] - oy],
    to: [to[0] - ox, to[1] - oy],
    seed: 0,
    style: 'red-yellow-rectangles',
    priority: { width, corridor, road },
  };
}
const ids = (rows: readonly Row[], target = grid) =>
  [...selectBuntingRows(rows, target).keys()].map((r) => r.id);
const horizontal = () => row('horizontal', [10, 40], [70, 40]);
const vertical = () => row('vertical', [40, 10], [40, 70]);

it('reuses spatial candidates across fractional zoom while checking actual near-junction clearance', () => {
  const [px, py] = project(123.1863, 13.6248, 18);
  const geo = ([x, y]: Point): Point => unproject(px + x * 5, py + y * 9, 18);
  const rows = [row('a', [0, 0], [10, 0], 14.5), row('b', [10.97, 0.97], [10.97, 5], 10.5, 1)].map(
    (r) => ({ ...r, from: geo(r.from), to: geo(r.to) }),
  );
  const base = vi.fn((lng: number, lat: number): Point => {
    const [x, y] = project(lng, lat, 17.5);
    return [x / 5, y / 9];
  });
  const at = (zoom: number): FixtureGrid => {
    const toCell = (lng: number, lat: number): Point => {
      const [x, y] = project(lng, lat, zoom);
      return [x / 5, y / 9];
    };
    return {
      ...grid,
      toCell,
      buntingProjection: {
        scale: String(zoom),
        toCell,
        base: { key: '5/9', scale: 2 ** (zoom - 17.5), toCell: base },
      },
    };
  };
  expect(ids(rows, at(18.04))).toEqual(['a', 'b']);
  expect(ids(rows, at(18.001))).toEqual(['a']);
  expect(ids(rows, at(18.04))).toEqual(['a', 'b']);
  expect(base).toHaveBeenCalledTimes(4);
  for (const zoom of [17.5, 17.75, 18.001, 18.04, 19.8, 22]) {
    const target = at(zoom);
    expect(ids(rows, target)).toEqual(ids(rows, { ...target, buntingProjection: undefined }));
  }
  expect(base).toHaveBeenCalledTimes(4);
});

it('caches admission across pans, invalidates scale/input changes and retains only the latest scale', () => {
  const rows = [vertical(), horizontal()];
  const canonical = vi.fn((x: number, y: number): Point => [x, y]);
  const projected = vi.fn((x: number, y: number): Point => [x - 200, y - 200]);
  const target = {
    ...grid,
    toCell: projected,
    buntingProjection: { scale: '1', toCell: canonical },
  };
  expect(ids(rows, target)).toEqual(['horizontal']);
  expect(canonical).toHaveBeenCalledTimes(4);
  expect(projected).toHaveBeenCalledTimes(2);
  projected.mockImplementation((x, y) => [x - 400, y - 400]);
  expect(ids(rows, target)).toEqual(['horizontal']);
  expect(canonical).toHaveBeenCalledTimes(4);
  expect(projected).toHaveBeenCalledTimes(4);
  const scaled = { ...target, buntingProjection: { scale: '2', toCell: canonical } };
  ids(rows, scaled);
  expect(canonical).toHaveBeenCalledTimes(8);
  ids(rows, target);
  expect(canonical).toHaveBeenCalledTimes(12);
  ids([...rows], target);
  expect(canonical).toHaveBeenCalledTimes(16);
});

it('keeps a complete dense direction ahead of a wider sparse crossing, independent of input order', () => {
  const dense = horizontal(),
    sparse = vertical();
  sparse.style = undefined;
  sparse.priority!.width = 20;
  expect(ids([sparse, dense])).toEqual(['horizontal']);
  expect(ids([dense, sparse])).toEqual(['horizontal']);
});

it('breaks dense junction ties by physical width, corridor order, road identity and row identity', () => {
  for (const key of ['width', 'corridor', 'road', 'id'] as const) {
    const a = horizontal(),
      b = vertical();
    if (key === 'width') a.priority!.width = 10;
    if (key === 'corridor') b.priority!.corridor = 1;
    if (key === 'road') b.priority!.road = 'osm:way/2';
    expect(ids([b, a]), key).toEqual(['horizontal']);
    expect(ids([a, b]), key).toEqual(['horizontal']);
  }
  const mx = 111320 * Math.cos((13 * Math.PI) / 180);
  expect(buntingWidth([123, 13], [123 + 9 / mx, 13])).toBe(9);
  expect(buntingWidth([123, 13], [123, 13 + 9 / 111320])).toBe(9);
});

it('retains closely spaced parallel rows and checks the one-cell envelope at near misses and T joins', () => {
  const a = row('a', [0, 0], [10, 0]);
  const parallel = row('b', [0, 0.1], [10, 0.1]);
  expect(ids([a, parallel])).toEqual(['a', 'b']);
  expect(ids([a, row('b', [10.5, 1], [10.5, 5])])).toEqual(['a']);
  expect(ids([a, row('b', [11.5, 1.5], [11.5, 5])])).toEqual(['a', 'b']);
  expect(ids([a, row('b', [10, 0], [10, 5])])).toEqual(['a']);
});

it('uses full unclipped hanging spans, including junctions outside the visible grid', () => {
  const rows = [vertical(), horizontal()];
  for (const scale of [1, 2 ** 1.5])
    for (const pan of [0, 45, 200])
      expect(ids(rows, { ...grid, toCell: (x, y) => [x * scale - pan, y * scale - pan] })).toEqual([
        'horizontal',
      ]);
  const projected = selectBuntingRows(rows, grid).get(rows[1]!);
  expect(projected).toEqual({ from: [10, 40], to: [70, 40] });
});

it('rejects the entire losing row before packing and preserves hardware and flag ownership', () => {
  const rows = [vertical(), horizontal()];
  const out = new Uint8Array(40000),
    owners = new Int32Array(10000).fill(-1);
  owners[40 * 100 + 20] = 2;
  out.set([7, 8, 9, 255], (40 * 100 + 20) * 4);
  const glyphs = mapGlyphs(themes.dark);
  expect(
    packSeasonalFixtures(out, grid, rows, 19.5, (g) => glyphs.indexOf(g), owners).bunting,
  ).toBe(true);
  expect(out.slice((40 * 100 + 20) * 4, (40 * 100 + 20) * 4 + 4)).toEqual(
    new Uint8Array([7, 8, 9, 255]),
  );
  for (let y = 10; y <= 70; y++) if (y !== 40) expect(out[(y * 100 + 40) * 4 + 3]).toBe(0);
  expect(owners[40 * 100 + 21]).toBe(-3);
  expect(owners[40 * 100 + 20]).toBe(2);
});

it('keeps ordinary calendars unchanged and safely skips invalid projected spans', () => {
  const a = horizontal(),
    b = vertical();
  delete a.priority;
  delete b.priority;
  expect(ids([a, b])).toEqual(['horizontal', 'vertical']);
  expect(ids([a, b], { ...grid, toCell: () => [NaN, Infinity] })).toEqual([]);
});

it('projects large separated row sets once per endpoint without scanning every pair', () => {
  const rows = Array.from({ length: 4000 }, (_, i) =>
    row(`row-${i}`, [i * 20, 0], [i * 20 + 9, 0]),
  );
  let projections = 0;
  const accepted = selectBuntingRows(rows, {
    ...grid,
    toCell: (x, y) => {
      projections++;
      return [x, y];
    },
  });
  expect(accepted.size).toBe(4000);
  expect(projections).toBe(8000);
});
