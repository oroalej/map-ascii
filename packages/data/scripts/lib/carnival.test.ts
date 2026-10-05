import { expect, it } from 'vitest';
import { Season, SeasonalRecordSchema, type SeasonConfig } from '@atlas/shared';
import type { AtlasFeature } from '../03-normalize';
import { generateSeasonalInstallations, seasonalRecordGeometry } from './seasonal-installations';

const source = [{ title: 'Illustrative reference', url: 'https://example.com/' }];
const road: AtlasFeature = {
  type: 'Feature',
  properties: { id: 'osm:way/1', class: 'road_minor', width: 6 },
  tippecanoe: { layer: 'roads', minzoom: 16, maxzoom: 16 },
  geometry: {
    type: 'LineString',
    coordinates: [
      [0, 0],
      [0, 0.001],
    ],
  },
};
const season: SeasonConfig = {
  id: 'winter',
  status: 'draft',
  title: { en: 'Winter' },
  note: 'TODO(verify)',
  window: { from: { month: 12, day: 1 }, to: { month: 1, day: 6 } },
  sources: source,
  grounds: [
    {
      id: 'lot',
      anchor: 'osm:way/1',
      sources: source,
      ring: [
        [0.0001, 0],
        [0.001, 0],
        [0.001, 0.001],
        [0.0001, 0.001],
        [0.0001, 0],
      ],
    },
  ],
  installations: [
    {
      id: 'fair',
      kind: 'carnival',
      anchor: 'osm:way/1',
      sources: source,
      label: 'Carnival',
      grounds: 'lot',
      components: [
        { id: 'midway', style: 'midway', at: [0.0005, 0.0005], size_m: [70, 90], angle_deg: 0 },
        {
          id: 'carousel',
          style: 'carousel',
          at: [0.0005, 0.0007],
          size_m: [18, 18],
          angle_deg: 20,
        },
        { id: 'booth', style: 'booth', at: [0.0007, 0.0003], size_m: [5, 6], angle_deg: 20 },
      ],
    },
  ],
};
it('bakes deterministic exact carnival records from a complete nearby road anchor', () => {
  expect(Season.parse(season)).toEqual(season);
  const { records } = generateSeasonalInstallations([road], [season]);
  expect(records).toHaveLength(3);
  expect(generateSeasonalInstallations([road], [structuredClone(season)]).records).toEqual(records);
  for (const r of records) {
    expect(SeasonalRecordSchema.parse(r)).toEqual(r);
    expect(seasonalRecordGeometry(r).type).toBe('Polygon');
  }
  const config = structuredClone(season);
  const fair = config.installations![0]!;
  if (fair.kind !== 'carnival') throw new Error('fixture');
  fair.components.push(fair.components[1]!);
  expect(Season.safeParse(config).success).toBe(false);
});
it('rejects entire out-of-bounds, road/building-occupied and overlapping ride footprints', () => {
  const change = (at: [number, number]) => {
    const config = structuredClone(season);
    const fair = config.installations![0]!;
    if (fair.kind !== 'carnival') throw new Error('fixture');
    fair.components = [{ ...fair.components[1]!, at }];
    return config;
  };
  expect(() => generateSeasonalInstallations([road], [change([0.0001, 0.0005])])).toThrow(
    'leaves grounds',
  );
  const drive = {
    ...road,
    properties: { ...road.properties, id: 'osm:way/2' },
    geometry: {
      type: 'LineString' as const,
      coordinates: [
        [0.0002, 0.0007],
        [0.0008, 0.0007],
      ],
    },
  };
  expect(() => generateSeasonalInstallations([road, drive], [change([0.0005, 0.0007])])).toThrow(
    'occupied footprint',
  );
  const building: AtlasFeature = {
    ...road,
    properties: { id: 'osm:way/3', class: 'building' },
    geometry: {
      type: 'Polygon' as const,
      coordinates: [
        [
          [0.00045, 0.00065],
          [0.00055, 0.00065],
          [0.00055, 0.00075],
          [0.00045, 0.00075],
          [0.00045, 0.00065],
        ],
      ],
    },
  };
  expect(() => generateSeasonalInstallations([road, building], [change([0.0005, 0.0007])])).toThrow(
    'occupied footprint',
  );
  const config = change([0.0005, 0.0007]);
  const fair = config.installations![0]!;
  if (fair.kind !== 'carnival') throw new Error('fixture');
  fair.components.push({ ...fair.components[0]!, id: 'second' });
  expect(() => generateSeasonalInstallations([road], [config])).toThrow(
    'overlapping carnival footprints',
  );
});
