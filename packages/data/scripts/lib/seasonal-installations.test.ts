import { expect, it } from 'vitest';
import type { SeasonConfig } from '@atlas/shared';
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
