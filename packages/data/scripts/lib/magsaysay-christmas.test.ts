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

it('keeps Magsaysay ground displays inside orange/red, outside access/parking, and lights only the adjacent house', () => {
  const season = Season.parse(city.life.seasons.find((s) => s.id === 'christmas'));
  const config = {
    ...season,
    grounds: season.grounds!.filter((g) => g.id === 'magsaysay-orange-display'),
    installations: season.installations!.filter((i) =>
      ['magsaysay-orange-garlands', 'magsaysay-house-lights', 'magsaysay-orange-border'].includes(
        i.id,
      ),
    ),
  };
  expect(config.installations).toHaveLength(3);
  expect(config.grounds).toHaveLength(1);
  expect(config.installations.every((i) => i.anchor === 'osm:way/23664053')).toBe(true);
  const features = reference.features as AtlasFeature[];
  const result = generateSeasonalInstallations(features, [config]);
  const red = polygon([reference.red]),
    yellow = polygon([reference.yellow]);
  const orange = polygon([config.grounds[0]!.ring]);
  const house = features.find((f) => f.properties.id === config.installations[0]!.anchor)!;
  if (house.geometry.type !== 'Polygon') throw new Error('expected complete house');
  const roof = polygon(house.geometry.coordinates);
  let trees = 0,
    groundStrings = 0,
    roofStrings = 0;
  const clear = (p: SeasonalPoint) => {
    expect(booleanPointInPolygon(p, orange)).toBe(true);
    expect(booleanPointInPolygon(p, red)).toBe(true);
    expect(booleanPointInPolygon(p, yellow)).toBe(false);
    expect(booleanPointInPolygon(p, roof)).toBe(false);
  };
  for (const record of result.records) {
    if (record.kind === 'christmas-tree') {
      trees++;
      // Include the full physical footprint and its pedestrian clearance, not only its center.
      for (let i = 0; i < 64; i++) {
        const angle = (i * Math.PI) / 32,
          radius = record.radius_m + 1;
        clear([
          record.at[0] +
            (Math.cos(angle) * radius) / (111320 * Math.cos((record.at[1] * Math.PI) / 180)),
          record.at[1] + (Math.sin(angle) * radius) / 111320,
        ]);
      }
    } else if (record.kind === 'light-string') {
      expect(record.bulb_spacing_m).toBeLessThanOrEqual(0.4);
      expect(record.palette).toBe(
        record.installation === 'magsaysay-orange-garlands' ? 'warm' : 'christmas',
      );
      if (record.mount === 'building') roofStrings++;
      else groundStrings++;
      for (let i = 0; i <= 100; i++) {
        const p: SeasonalPoint = [
          record.from[0] + ((record.to[0] - record.from[0]) * i) / 100,
          record.from[1] + ((record.to[1] - record.from[1]) * i) / 100,
        ];
        if (record.mount === 'building') expect(booleanPointInPolygon(p, roof)).toBe(true);
        else clear(p);
      }
    } else throw new Error('unexpected Magsaysay decoration');
  }
  expect(trees).toBe(0);
  expect(groundStrings).toBeGreaterThan(5);
  const canopy = config.installations.find((i) => i.id === 'magsaysay-orange-garlands')!;
  expect(canopy).toMatchObject({ layout: 'canopy', mount: 'canopy', spacing_m: 0.9 });
  expect(roofStrings).toBeGreaterThan(10);
  expect(generateSeasonalInstallations([...features].reverse(), [config])).toEqual(result);
  // The independently authored landscape tree occupies the orange patch. Hanging lights
  // must still bake identically without attempting to add a blocked physical tree.
  expect(
    generateSeasonalInstallations(
      [...features, ...(reference.integrationTrees as AtlasFeature[])],
      [config],
    ),
  ).toEqual(result);
});
it('lights all three latest yellow patches and places the red Christmas tree without restoring paths or parking', () => {
  const season = Season.parse(city.life.seasons.find((s) => s.id === 'christmas'));
  const config = {
    ...season,
    installations: season.installations!.filter((i) => i.id.startsWith('magsaysay-')),
  };
  const features = [...reference.features, ...reference.integrationTrees] as AtlasFeature[];
  const result = generateSeasonalInstallations(features, [config]);
  expect(config.installations.some((i) => i.kind === 'access-path')).toBe(false);
  expect(result.records.some((r) => r.kind === 'access-path')).toBe(false);
  expect(result.records.filter((r) => r.kind === 'christmas-tree')).toHaveLength(2);
  const tree = result.records.find(
    (r) => r.kind === 'christmas-tree' && r.installation === 'magsaysay-red-tree',
  );
  if (!tree || tree.kind !== 'christmas-tree') throw new Error('missing red tree');
  expect(tree.radius_m).toBe(1.8);
  const projection = localMetricProjection([123.19584784, 13.63244394]);
  expect(Math.hypot(...projection.to(tree.at))).toBeLessThan(1.1);
  const treeGrounds = polygon([config.grounds!.find((g) => g.id === 'magsaysay-red-tree')!.ring]);
  for (let i = 0; i < 64; i++) {
    const angle = (i * Math.PI) / 32;
    const offset = projection.to(tree.at);
    const footprint = projection.from([
      offset[0] + Math.cos(angle) * (tree.radius_m + 1),
      offset[1] + Math.sin(angle) * (tree.radius_m + 1),
    ]);
    expect(booleanPointInPolygon(footprint, treeGrounds)).toBe(true);
  }
  for (const patch of ['west', 'middle', 'east']) {
    const id = `magsaysay-yellow-${patch}-lights`;
    const installation = config.installations.find((i) => i.id === id)!;
    expect(installation).toMatchObject({
      kind: 'light-string',
      spacing_m: 0.75,
      bulb_spacing_m: 0.3,
      palette: 'christmas',
      mount: 'canopy',
    });
    const patchLights = result.records.filter(
      (r): r is SeasonalLightStringRecord => r.kind === 'light-string' && r.installation === id,
    );
    expect(patchLights.length).toBeGreaterThanOrEqual(3);
    const ground = polygon([config.grounds!.find((g) => g.id === installation.grounds)!.ring]);
    for (const light of patchLights)
      for (let n = 0; n <= 20; n++)
        expect(
          booleanPointInPolygon(
            [
              light.from[0] + ((light.to[0] - light.from[0]) * n) / 20,
              light.from[1] + ((light.to[1] - light.from[1]) * n) / 20,
            ],
            ground,
          ),
        ).toBe(true);
  }
  const lights = result.records.filter(
    (r): r is SeasonalLightStringRecord =>
      r.kind === 'light-string' && r.installation.includes('-island-'),
  );
  expect(lights.length).toBeGreaterThanOrEqual(5);
  for (const light of lights)
    for (let i = 0; i <= 100; i++) {
      const p: SeasonalPoint = [
        light.from[0] + ((light.to[0] - light.from[0]) * i) / 100,
        light.from[1] + ((light.to[1] - light.from[1]) * i) / 100,
      ];
      const grounds = config.grounds!.find(
        (g) =>
          g.id === config.installations.find((item) => item.id === light.installation)!.grounds,
      )!;
      expect(booleanPointInPolygon(p, polygon([grounds.ring]))).toBe(true);
    }
  for (const [id, count] of [
    ['magsaysay-orange-garlands', 7],
    ['magsaysay-orange-border', 9],
    ['magsaysay-house-lights', 21],
  ] as const)
    expect(
      result.records.filter((r) => r.kind !== 'bunting' && r.installation === id),
    ).toHaveLength(count);
  expect(generateSeasonalInstallations([...features].reverse(), [config])).toEqual(result);
});
