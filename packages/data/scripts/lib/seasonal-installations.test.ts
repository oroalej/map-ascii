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

const at = (x: number, y: number): SeasonalPoint => [x / 111320, y / 111320];
const groundRing = [at(0, 0), at(40, 0), at(40, 40), at(0, 40), at(0, 0)];
const propertyAnchor: AtlasFeature = {
  ...area,
  properties: { id: 'osm:way/10', class: 'building' },
  geometry: {
    type: 'Polygon',
    coordinates: [[at(30, 0), at(40, 0), at(40, 40), at(30, 40), at(30, 0)]],
  },
};
const propertyFeatures: AtlasFeature[] = [
  propertyAnchor,
  {
    ...features[1]!,
    properties: { id: 'osm:way/11', class: 'road_minor', width: 6 },
    geometry: { type: 'LineString', coordinates: [at(5, -10), at(5, 50)] },
  },
  {
    ...features[1]!,
    properties: { id: 'osm:way/12', class: 'path', width: 2 },
    geometry: { type: 'LineString', coordinates: [at(0, 20), at(40, 20)] },
  },
];
const propertySeason: SeasonConfig = {
  ...season,
  grounds: [{ id: 'forecourt', anchor: 'osm:way/10', ring: groundRing, sources: shared.sources }],
  installations: [
    {
      ...shared,
      anchor: 'osm:way/10',
      grounds: 'forecourt',
      id: 'tree-a',
      kind: 'christmas-tree',
      radius_m: 3,
    },
    {
      ...shared,
      anchor: 'osm:way/10',
      grounds: 'forecourt',
      id: 'tree-b',
      kind: 'christmas-tree',
      radius_m: 3,
    },
    {
      ...shared,
      anchor: 'osm:way/10',
      grounds: 'forecourt',
      id: 'garlands',
      kind: 'light-string',
      layout: 'perimeter',
      spacing_m: 3,
    },
  ],
};
it('keeps property trees and entire garlands outside the anchor building and carriageways', () => {
  const before = structuredClone(propertyFeatures);
  const result = generateSeasonalInstallations(propertyFeatures, [propertySeason]);
  expect(generateSeasonalInstallations([...propertyFeatures].reverse(), [propertySeason])).toEqual(
    result,
  );
  expect(propertyFeatures).toEqual(before);
  const trees = result.records.filter((r) => r.kind === 'christmas-tree');
  expect(trees).toHaveLength(2);
  expect(result.records.some((r) => r.kind === 'light-string')).toBe(true);
  for (const record of result.records) {
    expect(SeasonalRecordSchema.safeParse(record).success).toBe(true);
    if (record.kind === 'christmas-tree') {
      const x = record.at[0] * 111320,
        y = record.at[1] * 111320;
      expect(x + record.radius_m + 1).toBeLessThanOrEqual(30.001);
      expect(Math.abs(x - 5)).toBeGreaterThanOrEqual(record.radius_m + 4 - 0.001);
      expect(Math.abs(y - 20)).toBeGreaterThanOrEqual(record.radius_m + 2 - 0.001);
    } else if (record.kind === 'light-string') {
      for (let i = 0; i <= 100; i++) {
        const x = (record.from[0] + ((record.to[0] - record.from[0]) * i) / 100) * 111320;
        const y = (record.from[1] + ((record.to[1] - record.from[1]) * i) / 100) * 111320;
        expect(x).toBeGreaterThan(0);
        expect(x).toBeLessThan(30);
        expect(y).toBeGreaterThan(0);
        expect(y).toBeLessThan(40);
        expect(Math.abs(x - 5)).toBeGreaterThanOrEqual(4 - 0.001);
      }
    }
  }
  const [a, b] = trees;
  if (a?.kind !== 'christmas-tree' || b?.kind !== 'christmas-tree')
    throw new Error('expected trees');
  expect(Math.hypot(a.at[0] - b.at[0], a.at[1] - b.at[1]) * 111320).toBeGreaterThanOrEqual(
    7 - 0.001,
  );
});
it('rejects complete light spans crossing a narrow concave notch between sample points', () => {
  const result = generateSeasonalInstallations(propertyFeatures, [
    {
      ...propertySeason,
      grounds: [
        {
          ...propertySeason.grounds![0]!,
          ring: [
            at(0, 0),
            at(40, 0),
            at(40, 18.1),
            at(18, 18.1),
            at(18, 18.2),
            at(40, 18.2),
            at(40, 40),
            at(0, 40),
            at(0, 0),
          ],
        },
      ],
      installations: [
        {
          ...propertySeason.installations![2]!,
          kind: 'light-string',
          layout: 'paths',
          spacing_m: 3,
        },
      ],
    },
  ]);
  expect(result.records.length).toBeGreaterThan(0);
  for (const record of result.records) {
    if (record.kind !== 'light-string') throw new Error('expected a light span');
    expect(record.from[0] * 111320).toBeLessThan(18);
    expect(record.from[1] * 111320).toBeLessThan(18.1);
    expect(record.to[1] * 111320).toBeGreaterThan(18.2);
  }
});
it('fails for missing or mismatched property grounds, distant grounds and unavailable anchor geometry', () => {
  expect(() =>
    generateSeasonalInstallations(propertyFeatures, [{ ...propertySeason, grounds: undefined }]),
  ).toThrow('grounds');
  expect(() =>
    generateSeasonalInstallations(propertyFeatures, [
      { ...propertySeason, grounds: [{ ...propertySeason.grounds![0]!, anchor: 'osm:way/99' }] },
    ]),
  ).toThrow('mismatched');
  expect(() => generateSeasonalInstallations(propertyFeatures.slice(1), [propertySeason])).toThrow(
    'missing',
  );
  expect(() =>
    generateSeasonalInstallations(propertyFeatures, [
      {
        ...propertySeason,
        grounds: [
          { ...propertySeason.grounds![0]!, ring: groundRing.map((p) => [p[0] + 0.01, p[1]]) },
        ],
      },
    ]),
  ).toThrow('not near');
});

const roofSeason: SeasonConfig = {
  ...season,
  installations: [
    {
      ...shared,
      anchor: propertyAnchor.properties.id,
      id: 'roof',
      kind: 'light-string',
      layout: 'building-perimeter',
      spacing_m: 3,
    },
  ],
};
it('mounts whole strings inside complete building outlines, with stable geometry under winding changes', () => {
  const building = { ...propertyAnchor, properties: { ...propertyAnchor.properties, height: 6 } };
  const result = generateSeasonalInstallations([building], [roofSeason]);
  expect(result.records.length).toBeGreaterThan(10);
  expect(generateSeasonalInstallations([building], [roofSeason])).toEqual(result);
  for (const record of result.records) {
    expect(SeasonalRecordSchema.safeParse(record).success).toBe(true);
    if (record.kind !== 'light-string') throw new Error('expected strings');
    expect(record.mount).toBe('building');
    for (const point of [record.from, record.to]) {
      expect(point[0] * 111320).toBeGreaterThan(30);
      expect(point[0] * 111320).toBeLessThan(40);
      expect(point[1] * 111320).toBeGreaterThan(0);
      expect(point[1] * 111320).toBeLessThan(40);
    }
    expect(seasonalRecordGeometry(record)).toEqual({
      type: 'LineString',
      coordinates: [record.from, record.to],
    });
  }
  if (building.geometry.type !== 'Polygon') throw new Error('expected building');
  const reversed = {
    ...building,
    geometry: {
      type: 'Polygon' as const,
      coordinates: building.geometry.coordinates.map((r) => [...r].reverse()),
    },
  };
  // Stable count and full containment, regardless of OSM ring direction.
  const backward = generateSeasonalInstallations([reversed], [roofSeason]);
  expect(backward.records).toHaveLength(result.records.length);
  for (const record of backward.records) {
    if (record.kind !== 'light-string') throw new Error('expected strings');
    expect(record.from[0] * 111320).toBeGreaterThan(30);
    expect(record.to[0] * 111320).toBeLessThan(40);
  }
});
it('rejects roof lights on heightless grounds, missing buildings and authored ground envelopes', () => {
  for (const anchor of [area, propertyAnchor])
    expect(() =>
      generateSeasonalInstallations(
        [{ ...anchor, properties: { ...anchor.properties, id: propertyAnchor.properties.id } }],
        [roofSeason],
      ),
    ).toThrow('missing public area');
  const invalid: SeasonConfig = {
    ...roofSeason,
    grounds: propertySeason.grounds,
    installations: [{ ...roofSeason.installations![0]!, grounds: 'forecourt' }],
  };
  expect(() => generateSeasonalInstallations([propertyAnchor], [invalid])).toThrow(
    'cannot use grounds',
  );
});
