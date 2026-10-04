import { expect, it } from 'vitest';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { polygon } from '@turf/helpers';
import { Season, localMetricProjection, type SeasonalPoint } from '@atlas/shared';
import city from '../../../content/cities/naga/city.json';
import reference from '../__fixtures__/magsaysay-christmas.json';
import type { AtlasFeature } from '../03-normalize';
import { generateSeasonalInstallations } from './seasonal-installations';

const anchor = 'osm:way/23664053';
const season = Season.parse(city.life.seasons.find((s) => s.id === 'christmas'));
const config = {
  ...season,
  grounds: season.grounds!.filter((g) => g.anchor === anchor),
  installations: season.installations!.filter((i) => i.anchor === anchor),
};
const features = [...reference.features, ...reference.integrationTrees] as AtlasFeature[];

it('wraps the existing roadside crown and retains house lights without yard strings, paths or parking', () => {
  expect(config.installations).toHaveLength(4);
  expect(config.grounds).toHaveLength(3);
  expect(config.installations.filter((i) => i.kind === 'light-string')).toMatchObject([
    { id: 'magsaysay-house-lights', layout: 'building-perimeter' },
  ]);
  expect(config.installations.find((i) => i.id === 'magsaysay-tree-lights')).toMatchObject({
    kind: 'decorated-canopy',
    grounds: 'magsaysay-tree-display',
    trees: 'overlapping',
  });
  const before = structuredClone(features);
  const result = generateSeasonalInstallations(features, [config]);
  expect(features).toEqual(before);
  expect(generateSeasonalInstallations([...features].reverse(), [config])).toEqual(result);
  expect(result.records.some((r) => r.kind === 'access-path')).toBe(false);
  const crowns = result.records.filter((r) => r.kind === 'decorated-canopy');
  expect(crowns).toHaveLength(1);
  expect(crowns[0]).toMatchObject({
    installation: 'magsaysay-tree-lights',
    at: reference.integrationTrees[0]!.geometry.coordinates,
    radius_m: 8.5,
  });
  expect(new Set(result.records.map((r) => r.id)).size).toBe(result.records.length);
  const strings = result.records.filter((r) => r.kind === 'light-string');
  expect(strings).toHaveLength(21);
  expect(
    strings.every((r) => r.installation === 'magsaysay-house-lights' && r.mount === 'building'),
  ).toBe(true);
  const house = features.find((f) => f.properties.id === anchor)!;
  if (house.geometry.type !== 'Polygon') throw new Error('expected complete house');
  const roof = polygon(house.geometry.coordinates);
  for (const string of strings) {
    expect(string.palette).toBe('christmas');
    expect(string.bulb_spacing_m).toBe(0.4);
    for (let n = 0; n <= 20; n++) {
      const point: SeasonalPoint = [
        string.from[0] + ((string.to[0] - string.from[0]) * n) / 20,
        string.from[1] + ((string.to[1] - string.from[1]) * n) / 20,
      ];
      expect(booleanPointInPolygon(point, roof)).toBe(true);
    }
  }
  expect(
    generateSeasonalInstallations(features, [
      {
        ...config,
        installations: config.installations.filter((i) => i.id === 'magsaysay-house-lights'),
      },
    ]).records,
  ).toEqual(strings);
});

it('preserves both Christmas tree identities, footprints and exact positions', () => {
  const result = generateSeasonalInstallations(features, [config]);
  const trees = result.records.filter((r) => r.kind === 'christmas-tree');
  expect(trees).toEqual([
    {
      version: 1,
      id: 'season:christmas/magsaysay-island-tree-1/tree',
      season: 'christmas',
      installation: 'magsaysay-island-tree-1',
      anchor,
      seed: 1725857888,
      kind: 'christmas-tree',
      at: [123.19588264988285, 13.63237500422925],
      radius_m: 1,
    },
    {
      version: 1,
      id: 'season:christmas/magsaysay-red-tree/tree',
      season: 'christmas',
      installation: 'magsaysay-red-tree',
      anchor,
      seed: 2445793126,
      kind: 'christmas-tree',
      at: [123.19584599056593, 13.632442139335248],
      radius_m: 1.8,
    },
  ]);
  for (const tree of trees) {
    if (tree.kind !== 'christmas-tree') throw new Error('expected Christmas tree');
    const installation = config.installations.find((i) => i.id === tree.installation)!;
    const ground = polygon([config.grounds.find((g) => g.id === installation.grounds)!.ring]);
    const projection = localMetricProjection(tree.at);
    for (let i = 0; i < 64; i++) {
      const angle = (i * Math.PI) / 32;
      expect(
        booleanPointInPolygon(
          projection.from([
            Math.cos(angle) * (tree.radius_m + 1),
            Math.sin(angle) * (tree.radius_m + 1),
          ]),
          ground,
        ),
      ).toBe(true);
    }
  }
});
