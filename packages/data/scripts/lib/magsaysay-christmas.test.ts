import { expect, it } from 'vitest';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { polygon } from '@turf/helpers';
import {
  Season,
  localMetricProjection,
  type SeasonalPoint,
  type SeasonalLightStringRecord,
} from '@atlas/shared';
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

it('retains yard strings outside the roadside crown, with crown wraps and unchanged house lights', () => {
  expect(config.installations).toHaveLength(13);
  expect(config.grounds).toHaveLength(9);
  const yard = config.installations.filter(
    (i) => i.kind === 'light-string' && i.layout !== 'building-perimeter',
  );
  expect(yard).toHaveLength(9);
  expect(yard.every((i) => i.kind === 'light-string' && i.exclude_tree_crowns)).toBe(true);
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
  const yardStrings = result.records.filter(
    (r): r is SeasonalLightStringRecord =>
      r.kind === 'light-string' && r.installation !== 'magsaysay-house-lights',
  );
  expect(new Set(yardStrings.map((r) => r.installation))).toEqual(new Set(yard.map((i) => i.id)));
  const beforeClipping = generateSeasonalInstallations(features, [
    {
      ...config,
      installations: config.installations.map((i) =>
        i.kind === 'light-string' ? { ...i, exclude_tree_crowns: false } : i,
      ),
    },
  ]).records.filter(
    (r): r is SeasonalLightStringRecord =>
      r.kind === 'light-string' && r.installation !== 'magsaysay-house-lights',
  );
  const center = reference.integrationTrees[0]!.geometry.coordinates as SeasonalPoint;
  const frame = localMetricProjection(center);
  const nearest = (from: SeasonalPoint, to: SeasonalPoint) => {
    const a = frame.to(from),
      b = frame.to(to);
    const dx = b[0] - a[0],
      dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, -(a[0] * dx + a[1] * dy) / (dx * dx + dy * dy)));
    return Math.hypot(a[0] + dx * t, a[1] + dy * t);
  };
  expect(beforeClipping.some((r) => r.kind === 'light-string' && nearest(r.from, r.to) < 8.5)).toBe(
    true,
  );
  let unaffected = 0;
  for (const record of beforeClipping) {
    if (record.kind !== 'light-string') throw new Error('expected yard string');
    if (nearest(record.from, record.to) >= 8.5 + 1e-4) {
      expect(yardStrings.find((r) => r.id === record.id)).toEqual(record);
      unaffected++;
    }
  }
  expect(unaffected).toBeGreaterThan(10);
  for (const record of yardStrings) {
    if (record.kind !== 'light-string') throw new Error('expected yard string');
    expect(nearest(record.from, record.to)).toBeGreaterThanOrEqual(8.5 - 1e-4);
  }
  const strings = result.records.filter(
    (r): r is SeasonalLightStringRecord =>
      r.kind === 'light-string' && r.installation === 'magsaysay-house-lights',
  );
  expect(strings).toHaveLength(21);
  expect(
    strings.every((r) => r.installation === 'magsaysay-house-lights' && r.mount === 'building'),
  ).toBe(true);
  const house = features.find((f) => f.properties.id === anchor)!;
  if (house.geometry.type !== 'Polygon') throw new Error('expected complete house');
  const roof = polygon(house.geometry.coordinates);
  for (const string of strings) {
    if (string.kind !== 'light-string') throw new Error('expected house string');
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

it('keeps yard strings in their grounds, orange access clear and yellow patches dense', () => {
  const result = generateSeasonalInstallations(features, [config]);
  const red = polygon([reference.red]),
    yellow = polygon([reference.yellow]);
  const house = features.find((f) => f.properties.id === anchor)!;
  if (house.geometry.type !== 'Polygon') throw new Error('expected complete house');
  const roof = polygon(house.geometry.coordinates);
  for (const record of result.records) {
    if (record.kind !== 'light-string' || record.mount === 'building') continue;
    const installation = config.installations.find((i) => i.id === record.installation)!;
    const ground = polygon([config.grounds.find((g) => g.id === installation.grounds)!.ring]);
    for (let n = 0; n <= 100; n++) {
      const point: SeasonalPoint = [
        record.from[0] + ((record.to[0] - record.from[0]) * n) / 100,
        record.from[1] + ((record.to[1] - record.from[1]) * n) / 100,
      ];
      expect(booleanPointInPolygon(point, ground)).toBe(true);
      expect(booleanPointInPolygon(point, roof)).toBe(false);
      if (['magsaysay-orange-garlands', 'magsaysay-orange-border'].includes(installation.id)) {
        expect(booleanPointInPolygon(point, red)).toBe(true);
        expect(booleanPointInPolygon(point, yellow)).toBe(false);
      }
    }
  }
  expect(config.installations.find((i) => i.id === 'magsaysay-orange-garlands')).toMatchObject({
    layout: 'canopy',
    mount: 'canopy',
    spacing_m: 0.9,
  });
  for (const patch of ['west', 'middle', 'east']) {
    const id = `magsaysay-yellow-${patch}-lights`;
    expect(config.installations.find((i) => i.id === id)).toMatchObject({
      kind: 'light-string',
      spacing_m: 0.75,
      bulb_spacing_m: 0.3,
      palette: 'christmas',
      mount: 'canopy',
    });
    expect(
      result.records.filter((r) => r.kind === 'light-string' && r.installation === id).length,
    ).toBeGreaterThanOrEqual(3);
  }
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
