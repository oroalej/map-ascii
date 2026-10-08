import { expect, it } from 'vitest';
import { carnivalRing, offsetUtility, pointInPolygon } from '@atlas/shared';
import { Season } from '@atlas/shared/schemas';
import city from '../../../content/cities/naga/city.json';
import reference from '../__fixtures__/sabang-carnival.json';
import type { AtlasFeature } from '../03-normalize';
import { generateSeasonalInstallations } from './seasonal-installations';

it('fits the owner-marked Sabang lot, preserves LCC trees and retains a clear entrance-to-rides aisle', () => {
  const season = Season.parse(city.life.seasons.find((s) => s.id === 'christmas'));
  const config = {
    ...season,
    installations: season.installations!.filter((i) => i.id === 'sabang-christmas-perya'),
  };
  const result = generateSeasonalInstallations(reference.features as AtlasFeature[], [config]);
  expect(result.records).toHaveLength(14);
  const fair = config.installations[0]!;
  if (fair.kind !== 'carnival') throw new Error('expected carnival');
  const ground = config.grounds!.find((g) => g.id === fair.grounds)!;
  const midway = fair.components.find((c) => c.style === 'midway')!;
  expect(fair.components.filter((c) => c.style === 'booth')).toHaveLength(10);
  const a = (midway.angle_deg * Math.PI) / 180;
  for (const c of fair.components)
    for (const p of carnivalRing(c)) expect(pointInPolygon(p, [ground.ring])).toBe(true);
  // The 3 m aisle, plus 1 m either side, must avoid every solid ride/booth at every height.
  for (let v = -48; v <= 48; v += 0.5)
    for (const u of [1.51, 2.5, 4, 5.5, 6.49]) {
      const p = offsetUtility(
        midway.at,
        u * Math.cos(a) - v * Math.sin(a),
        u * Math.sin(a) + v * Math.cos(a),
      );
      for (const c of fair.components.filter((c) => c.style !== 'midway'))
        expect(pointInPolygon(p, [carnivalRing(c)])).toBe(false);
    }
  expect(
    generateSeasonalInstallations([...reference.features].reverse() as AtlasFeature[], [config]),
  ).toEqual(result);
  expect(
    generateSeasonalInstallations(
      [...reference.features, ...reference.integrationTrees] as AtlasFeature[],
      [config],
    ),
  ).toEqual(result);
  expect(result.records.every((r) => r.season === 'christmas')).toBe(true);
});
