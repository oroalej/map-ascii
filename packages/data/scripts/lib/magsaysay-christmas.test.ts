import { expect, it } from 'vitest';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { polygon } from '@turf/helpers';
import { Season, type SeasonalPoint } from '@atlas/shared';
import city from '../../../content/cities/naga/city.json';
import reference from '../__fixtures__/magsaysay-christmas.json';
import type { AtlasFeature } from '../03-normalize';
import { generateSeasonalInstallations } from './seasonal-installations';

it('keeps Magsaysay ground displays inside orange/red, outside access/parking, and lights only the adjacent house', () => {
  const season = Season.parse(city.life.seasons.find((s) => s.id === 'christmas'));
  const config = {
    ...season,
    installations: season.installations!.filter((i) => i.id.startsWith('magsaysay-')),
  };
  expect(config.installations).toHaveLength(4);
  expect(config.grounds).toHaveLength(3);
  expect(config.installations.every((i) => i.anchor === 'osm:way/23664053')).toBe(true);
  const features = reference.features as AtlasFeature[];
  const result = generateSeasonalInstallations(features, [config]);
  const red = polygon([reference.red]),
    yellow = polygon([reference.yellow]);
  const orange = polygon([config.grounds![0]!.ring]);
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
  expect(groundStrings).toBeGreaterThan(0);
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
