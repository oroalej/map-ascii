import { expect, it } from 'vitest';
import { CityProcessions, type ProcessionRoute } from '@atlas/shared';
import { quantizeGroundRoutes } from './07-processions';

it('serializes compact ground geography while preserving fluvial geometry and physical numbers', () => {
  const line: [number, number][] = [
    [123.123456789, 13.123456789],
    [123.123956789, 13.123456789],
  ];
  const ring: [number, number][] = [...line, [123.123956789, 13.123956789], line[0]!];
  const common = {
    id: 'event',
    title: { en: 'Event' },
    status: 'draft' as const,
    schedule: {
      month: 9,
      weekday: 6,
      nth: 3,
      offset_days: 0,
      start: '12:00',
      duration_min: 90,
      timezone: 'Asia/Manila',
    },
  };
  const routes: ProcessionRoute[] = [
    {
      ...common,
      kind: 'fluvial',
      route: line,
      length_m: 123.123456789,
      banks: [
        [3.123456789, 4],
        [3, 4],
      ],
    },
    {
      ...common,
      id: 'street',
      kind: 'procession',
      route: line,
      length_m: 123.123456789,
      segments: [{ id: 'osm:way/1', width_m: 8.123456789, sidewalk_m: 1 }],
      blocked: [ring],
      water: [ring],
      bridges: [ring],
    },
    {
      ...common,
      id: 'mass',
      kind: 'mass',
      site: {
        id: 'osm:way/2',
        location: line[0]!,
        anchor: line[1]!,
        radius_m: 50,
        grounds: [ring],
        blocked: [ring],
        approaches: [line],
        roads: [{ line, width_m: 8.123456789 }],
      },
    },
  ];
  const output = quantizeGroundRoutes(routes),
    bundle = CityProcessions.parse({ processions: output });
  expect(bundle.processions[0]).toEqual(routes[0]);
  const street = bundle.processions[1]!,
    mass = bundle.processions[2]!;
  if (street.kind !== 'procession' || mass.kind !== 'mass') throw Error('Wrong event kind');
  expect(street.route[0]).toEqual([123.123457, 13.123457]);
  expect(street.length_m).toBe(123.123456789);
  expect(street.segments[0]!.width_m).toBe(8.123456789);
  expect(mass.site.anchor).toEqual(street.route[1]);
  expect(mass.site.roads[0]!.width_m).toBe(8.123456789);
  expect(JSON.stringify(mass.site)).not.toContain('123.123456789');
  expect(routes[1]).not.toEqual(street);
});
