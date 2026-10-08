import { expect, it } from 'vitest';
import { expandBuntingRun, type SeasonConfig, type SeasonalPoint } from '@atlas/shared';
import type { AtlasFeature } from '../03-normalize';
import { generateSeasonalBunting } from './seasonal';
const mx = 111320 * Math.cos((13 * Math.PI) / 180);
const at = (x: number, y = 0): SeasonalPoint => [123 + x / mx, 13 + y / 111320];
const road = (id: number, points: SeasonalPoint[], extra = {}): AtlasFeature => ({
  type: 'Feature',
  geometry: { type: 'LineString', coordinates: points },
  properties: { id: `osm:way/${id}`, class: 'road_mid', width: 8, ...extra },
  tippecanoe: { layer: 'roads', minzoom: 12, maxzoom: 16 },
});
const season = (ways = ['osm:way/1', 'osm:way/2'], ends = {}): SeasonConfig => ({
  id: 'feast',
  title: { en: 'Feast' },
  sources: [],
  window: { from: { month: 9, day: 1 }, to: { month: 9, day: 20 } },
  bunting: {
    label: 'Banderitas',
    near: ['worship'],
    radius_m: 400,
    spacing_m: 30,
    corridors: [{ id: 'route', ways, spacing_m: 6, style: 'red-yellow-rectangles', ...ends }],
  },
});
/** Shipped runs, decoded into their hanging rows. */
const rows = (result: ReturnType<typeof generateSeasonalBunting>) =>
  result.records.flatMap(expandBuntingRun);
const center = (r: { from: SeasonalPoint; to: SeasonalPoint }) => [
  ((r.from[0] + r.to[0]) / 2 - 123) * mx,
  ((r.from[1] + r.to[1]) / 2 - 13) * 111320,
];

it.each([3, 6])(
  'continues %i m spacing through reversed fragments and a bend, with curb-to-curb rows',
  (spacing) => {
    const features = [road(1, [at(0), at(10)]), road(2, [at(10, 14), at(10)])];
    const s = season();
    s.bunting!.corridors![0]!.spacing_m = spacing;
    const result = generateSeasonalBunting(features, [s]);
    const positions = rows(result)
      .map(center)
      .sort((a, b) => a[0]! + a[1]! - b[0]! - b[1]!);
    expect(positions).toHaveLength(24 / spacing);
    for (const [i, p] of positions.entries()) expect(p[0]! + p[1]!).toBeCloseTo(i * spacing, 2);
    for (const r of rows(result)) {
      expect(Math.hypot((r.to[0] - r.from[0]) * mx, (r.to[1] - r.from[1]) * 111320)).toBeCloseTo(
        9,
        2,
      );
      const a = r.segment[0],
        b = r.segment[1];
      expect(
        (b[0] - a[0]) * mx * ((r.to[0] - r.from[0]) * mx) +
          (b[1] - a[1]) * 111320 * ((r.to[1] - r.from[1]) * 111320),
      ).toBeCloseTo(0, 3);
    }
    expect(result).toEqual(generateSeasonalBunting(features.slice().reverse(), [s]));
  },
);
it('clips both frontages and retains exact endpoints and separate season identities', () => {
  const features: AtlasFeature[] = [
    road(1, [at(0), at(30)]),
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: at(5, 10) },
      properties: { id: 'osm:node/3', class: 'monument' },
      tippecanoe: { layer: 'poi', minzoom: 15, maxzoom: 16 },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: at(23, -10) },
      properties: { id: 'osm:node/4', class: 'monument' },
      tippecanoe: { layer: 'poi', minzoom: 15, maxzoom: 16 },
    },
  ];
  const s = season(['osm:way/1'], { from: 'osm:node/3', to: 'osm:node/4' });
  const a = generateSeasonalBunting(features, [s]);
  expect(
    rows(a)
      .map(center)
      .map((p) => Math.round(p[0]!)),
  ).toEqual([5, 11, 17]);
  for (const r of rows(a)) {
    expect((r.segment[0][0] - 123) * mx).toBeCloseTo(5, 4);
    expect((r.segment[1][0] - 123) * mx).toBeCloseTo(23, 4);
  }
  const b = generateSeasonalBunting(features, [{ ...s, id: 'other' }]);
  expect(b.records.every((r) => !a.records.some((v) => v.id === r.id))).toBe(true);
  s.bunting!.corridors![0]!.spacing_m = 3;
  expect(
    rows(generateSeasonalBunting(features, [s]))
      .map(center)
      .map((p) => Math.round(p[0]!)),
  ).toEqual([5, 8, 11, 14, 17, 20]);
});
it('covers divided terminal branches without duplicating shared junction rows', () => {
  const result = generateSeasonalBunting(
    [road(1, [at(0), at(12)]), road(2, [at(12), at(24, 5)]), road(3, [at(12), at(24, -5)])],
    [season(['osm:way/1', 'osm:way/2', 'osm:way/3'])],
  );
  expect(new Set(result.records.map((r) => r.road))).toEqual(
    new Set(['osm:way/1', 'osm:way/2', 'osm:way/3']),
  );
  const hung = rows(result);
  expect(new Set(hung.map((r) => r.id)).size).toBe(hung.length);
  expect(
    new Set(
      hung.map((r) =>
        center(r)
          .map((v) => v.toFixed(3))
          .join(),
      ),
    ).size,
  ).toBe(hung.length);
  // One record per edge carries all of its rows.
  expect(result.records.length).toBeLessThan(hung.length);
});
it('rejects missing/non-road/region-only targets, disconnected routes and wrong frontages', () => {
  const a = road(1, [at(0), at(10)]),
    b = road(2, [at(30), at(50)]);
  expect(() => generateSeasonalBunting([a], [season()])).toThrow('missing road');
  expect(() =>
    generateSeasonalBunting(
      [a, { ...b, properties: { ...b.properties, region: true } }],
      [season()],
    ),
  ).toThrow('missing road');
  expect(() => generateSeasonalBunting([a, b], [season()])).toThrow('disconnected');
  expect(() =>
    generateSeasonalBunting([a], [season(['osm:way/1'], { to: 'osm:node/99' })]),
  ).toThrow('missing endpoint');
  const distant: AtlasFeature = {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: at(5, 500) },
    properties: { id: 'osm:node/3', class: 'monument' },
    tippecanoe: { layer: 'poi', minzoom: 15, maxzoom: 16 },
  };
  expect(() =>
    generateSeasonalBunting([a, distant], [season(['osm:way/1'], { to: 'osm:node/3' })]),
  ).toThrow('not near');
});
it('leaves geometry untouched and generates no layer for ordinary calendars', () => {
  const features = [road(1, [at(0), at(30)])],
    before = structuredClone(features);
  const s = season(['osm:way/1']);
  delete s.bunting!.corridors;
  expect(generateSeasonalBunting(features, [s])).toEqual({ records: [], stats: [] });
  generateSeasonalBunting(features, [season(['osm:way/1'])]);
  expect(features).toEqual(before);
  const invalid = season(['osm:way/1']);
  invalid.bunting!.corridors![0]!.spacing_m = 0;
  expect(() => generateSeasonalBunting(features, [invalid])).toThrow('invalid spacing');
  invalid.bunting!.corridors![0]!.spacing_m = 2.99;
  expect(() => generateSeasonalBunting(features, [invalid])).toThrow('invalid spacing');
});
