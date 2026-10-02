import { expect, it } from 'vitest';
import { SeasonalRecordSchema, type SeasonConfig, type SeasonalPoint } from '@atlas/shared';
import type { AtlasFeature } from '../03-normalize';
import { generateSeasonalInstallations, seasonalRecordGeometry } from './seasonal-installations';
const area: AtlasFeature = {
  type: 'Feature',
  tippecanoe: { layer: 'landuse', minzoom: 16, maxzoom: 16 },
  properties: { id: 'osm:way/1', class: 'park' },
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [0, 0],
        [0.001, 0],
        [0.001, 0.001],
        [0, 0.001],
        [0, 0],
      ],
    ],
  },
};
const features: AtlasFeature[] = [
  area,
  {
    type: 'Feature',
    tippecanoe: { layer: 'landuse', minzoom: 16, maxzoom: 16 },
    properties: { id: 'osm:way/2', class: 'path', width: 4 },
    geometry: {
      type: 'LineString',
      coordinates: [
        [0, 0.0005],
        [0.001, 0.0005],
      ],
    },
  },
  {
    type: 'Feature',
    tippecanoe: { layer: 'landuse', minzoom: 16, maxzoom: 16 },
    properties: { id: 'osm:node/3', class: 'monument' },
    geometry: { type: 'Point', coordinates: [0.0005, 0.0005] },
  },
  {
    type: 'Feature',
    tippecanoe: { layer: 'landuse', minzoom: 16, maxzoom: 16 },
    properties: { id: 'osm:node/4', class: 'tree', crown: 8 },
    geometry: { type: 'Point', coordinates: [0.0002, 0.0002] },
  },
];
const shared = {
  anchor: 'osm:way/1',
  label: 'Decorations',
  sources: [{ title: 'Reference', url: 'https://example.com/' }],
};
const season: SeasonConfig = {
  id: 'winter',
  title: { en: 'Winter' },
  status: 'draft',
  note: 'TODO(verify)',
  window: { from: { month: 12, day: 1 }, to: { month: 1, day: 6 } },
  sources: shared.sources,
  installations: [
    { ...shared, id: 'tree', kind: 'christmas-tree', radius_m: 5 },
    { ...shared, id: 'smaller-tree', kind: 'christmas-tree', radius_m: 2 },
    { ...shared, id: 'paths', kind: 'light-string', layout: 'paths', spacing_m: 5 },
    { ...shared, id: 'edge', kind: 'light-string', layout: 'perimeter', spacing_m: 5 },
    { ...shared, id: 'crowns', kind: 'decorated-canopy' },
  ],
};
it('keeps deterministic tree footprints away from paths, monuments and each other; retains mapped crowns', () => {
  const a = generateSeasonalInstallations(features, [season]);
  expect(generateSeasonalInstallations([...features].reverse(), [season])).toEqual(a);
  const trees = a.records.filter((r) => r.kind === 'christmas-tree');
  expect(trees).toHaveLength(2);
  for (const tree of trees) {
    if (tree.kind !== 'christmas-tree') throw new Error('expected tree');
    expect(Math.abs(tree.at[1] - 0.0005) * 111320).toBeGreaterThan(tree.radius_m + 3);
    expect(Math.hypot(tree.at[0] - 0.0005, tree.at[1] - 0.0005) * 111320).toBeGreaterThan(
      tree.radius_m + 6,
    );
    const g = seasonalRecordGeometry(tree);
    expect(g.type).toBe('Polygon');
  }
  const first = trees[0]!,
    second = trees[1]!;
  if (first.kind !== 'christmas-tree' || second.kind !== 'christmas-tree')
    throw new Error('expected tree');
  expect(
    Math.hypot(first.at[0] - second.at[0], first.at[1] - second.at[1]) * 111320,
  ).toBeGreaterThan(first.radius_m + second.radius_m + 1);
  expect(a.records.find((r) => r.kind === 'decorated-canopy')).toMatchObject({
    at: [0.0002, 0.0002],
    radius_m: 4,
  });
  expect(a.records.filter((r) => r.kind === 'light-string').length).toBeGreaterThan(10);
});
it('fails loudly for missing anchors, impossible footprints and unavailable mapped trees', () => {
  const run = (change: Partial<SeasonConfig>) =>
    generateSeasonalInstallations(features, [{ ...season, ...change }]);
  expect(() =>
    run({
      installations: [
        { ...shared, id: 'missing', kind: 'christmas-tree', radius_m: 4, anchor: 'osm:way/999' },
      ],
    }),
  ).toThrow('missing public area');
  expect(() =>
    generateSeasonalInstallations(
      [area],
      [{ ...season, installations: [{ ...shared, id: 'crowns', kind: 'decorated-canopy' }] }],
    ),
  ).toThrow('no decorated-canopy');
  const tiny = {
    ...area,
    geometry: {
      type: 'Polygon' as const,
      coordinates: [
        [
          [0, 0],
          [0.00001, 0],
          [0.00001, 0.00001],
          [0, 0.00001],
          [0, 0],
        ],
      ],
    },
  };
  expect(() =>
    generateSeasonalInstallations(
      [tiny],
      [{ ...season, installations: [season.installations![0]!] }],
    ),
  ).toThrow('no clear');
  expect(generateSeasonalInstallations(features, undefined).records).toEqual([]);
});

it('closes display envelopes exactly even at the equator', () => {
  const geometry = seasonalRecordGeometry({
    version: 1,
    kind: 'christmas-tree',
    id: 'tree',
    season: 'winter',
    installation: 'tree',
    anchor: 'osm:way/1',
    at: [0, 0],
    radius_m: 5,
    seed: 1,
  });
  if (geometry.type !== 'Polygon') throw new Error('expected a display envelope');
  const ring = geometry.coordinates[0]!;
  expect(ring).toHaveLength(33);
  expect(ring.at(-1)).toEqual(ring[0]);
});

const roadPoint = (x: number, y = 0): SeasonalPoint => [x / 111320, y / 111320];
const road = (id: number, points: SeasonalPoint[]): AtlasFeature => ({
  type: 'Feature',
  properties: { id: `osm:way/${id}`, class: 'road_mid', width: 10 },
  geometry: { type: 'LineString', coordinates: points },
  tippecanoe: { layer: 'roads', minzoom: 12, maxzoom: 16 },
});
const frontage = (id: number, point: SeasonalPoint): AtlasFeature => ({
  type: 'Feature',
  properties: { id: `osm:node/${id}`, class: 'furniture' },
  geometry: { type: 'Point', coordinates: point },
  tippecanoe: { layer: 'poi', minzoom: 16, maxzoom: 16 },
});
const street: SeasonConfig = {
  ...season,
  installations: [
    {
      ...shared,
      id: 'street',
      anchor: 'osm:way/10',
      kind: 'light-string',
      layout: 'street',
      ways: ['osm:way/10', 'osm:way/11'],
      from: 'osm:node/12',
      to: 'osm:node/13',
      spacing_m: 3,
    },
  ],
};
const streetFeatures = [
  road(10, [roadPoint(0), roadPoint(10)]),
  road(11, [roadPoint(10, 40), roadPoint(10)]),
  frontage(12, roadPoint(4, -5)),
  frontage(13, roadPoint(15, 15)),
];
it('continues dense street lights across reversed ways and a bend, clipped to projected frontages', () => {
  const before = structuredClone(streetFeatures);
  const result = generateSeasonalInstallations(streetFeatures, [street]);
  expect(generateSeasonalInstallations([...streetFeatures].reverse(), [street])).toEqual(result);
  expect(streetFeatures).toEqual(before);
  // 6 m before the bend + 15 m after it: seven 3 m rows, excluding the far frontage.
  expect(result.stats).toEqual([
    { season: 'winter', installation: 'street', kind: 'light-string', records: 7 },
  ]);
  const centers = result.records
    .map((r) => {
      expect(SeasonalRecordSchema.safeParse(r).success).toBe(true);
      if (r.kind !== 'light-string') throw new Error('expected street light string');
      expect(r.anchor).toBe('osm:way/10');
      expect(Math.hypot(r.to[0] - r.from[0], r.to[1] - r.from[1]) * 111320).toBeCloseTo(11, 3);
      const x = ((r.from[0] + r.to[0]) / 2) * 111320;
      const y = ((r.from[1] + r.to[1]) / 2) * 111320;
      expect(x).toBeLessThanOrEqual(10.001);
      expect(y).toBeLessThan(15);
      if (x < 9.999) expect(r.to[0]).toBeCloseTo(r.from[0], 8);
      else expect(r.to[1]).toBeCloseTo(r.from[1], 8);
      return x + y;
    })
    .sort((a, b) => a - b);
  for (const [i, p] of centers.entries()) expect(p).toBeCloseTo(4 + i * 3, 3);
});
it('rejects missing street geometry, disconnected ways and unavailable frontage targets', () => {
  expect(() => generateSeasonalInstallations(streetFeatures.slice(1), [street])).toThrow(
    'missing road',
  );
  expect(() => generateSeasonalInstallations(streetFeatures.slice(0, -1), [street])).toThrow(
    'missing endpoint',
  );
  expect(() =>
    generateSeasonalInstallations(
      [streetFeatures[0]!, road(11, [roadPoint(50), roadPoint(70)]), ...streetFeatures.slice(2)],
      [street],
    ),
  ).toThrow('disconnected');
  expect(() =>
    generateSeasonalInstallations(
      [...streetFeatures.slice(0, -1), frontage(13, roadPoint(10, 500))],
      [street],
    ),
  ).toThrow('not near');
});

it('requires a selected street anchor and bounds the generated installation size', () => {
  const config = street.installations![0]!;
  if (config.kind !== 'light-string' || config.layout !== 'street')
    throw new Error('expected street');
  expect(() =>
    generateSeasonalInstallations(streetFeatures, [
      {
        ...street,
        installations: [{ ...config, anchor: 'osm:way/99' }],
      },
    ]),
  ).toThrow('street anchor is not selected');
  expect(() =>
    generateSeasonalInstallations(
      [road(10, [roadPoint(0), roadPoint(3006)]), road(11, [roadPoint(3006), roadPoint(3012)])],
      [{ ...street, installations: [{ ...config, from: undefined, to: undefined }] }],
    ),
  ).toThrow('too many records');
});
