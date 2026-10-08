import { expect, it } from 'vitest';
import { type ProcessionRoute } from '@atlas/shared';
import { CityProcessions } from '@atlas/shared/schemas';
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
      crowd_ground: {
        grounds: [ring],
        blocked: [ring],
        water: [ring],
        bridges: [ring],
        closure_zone: [ring],
      },
    },
    {
      ...common,
      id: 'street',
      kind: 'procession',
      route: line,
      length_m: 123.123456789,
      segments: [
        {
          id: 'osm:way/1',
          width_m: 8.123456789,
          clear_m: 5.123456789,
          sidewalk_m: 1,
          verge_m: { left: 2.123456789, right: 0 },
        },
      ],
      crowd_grounds: [ring],
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
        closure_zone: [ring],
        seated_grounds: [ring],
        altar_ground: [ring],
        altar: { at: line[0]!, radius_m: 5, images: 2 },
      },
    },
  ];
  const output = quantizeGroundRoutes(routes),
    bundle = CityProcessions.parse({ processions: output });
  const river = bundle.processions[0]!;
  if (river.kind !== 'fluvial') throw Error('Wrong event kind');
  expect(river.route).toEqual(line);
  expect(river.banks).toEqual(routes[0]!.kind === 'fluvial' ? routes[0]!.banks : undefined);
  expect(river.crowd_ground!.grounds[0]![0]).toEqual([123.123457, 13.123457]);
  expect(river.crowd_ground!.closure_zone![0]![0]).toEqual([123.123457, 13.123457]);
  const street = bundle.processions[1]!,
    mass = bundle.processions[2]!;
  if (street.kind !== 'procession' || mass.kind !== 'mass') throw Error('Wrong event kind');
  expect(street.route[0]).toEqual([123.123457, 13.123457]);
  expect(street.length_m).toBe(123.123456789);
  expect(street.segments[0]!.width_m).toBe(8.123456789);
  expect(street.segments[0]!.clear_m).toBe(5.123456789);
  expect(street.segments[0]!.verge_m!.left).toBe(2.123456789);
  expect(street.crowd_grounds![0]![0]).toEqual(street.route[0]);
  expect(mass.site.altar!.at).toEqual(street.route[0]);
  for (const rings of [mass.site.closure_zone, mass.site.seated_grounds, mass.site.altar_ground])
    expect(rings![0]![0]).toEqual(street.route[0]);
  expect(mass.site.anchor).toEqual(street.route[1]);
  expect(mass.site.roads[0]!.width_m).toBe(8.123456789);
  expect(JSON.stringify(mass.site)).not.toContain('123.123456789');
  expect(routes[1]).not.toEqual(street);
});

it('removes only duplicate and exactly collinear vertices after quantization', () => {
  const ring: [number, number][] = [
    [0, 0],
    [0.000001, 0],
    [0.00000101, 0],
    [0.000002, 0],
    [0.000002, 0.000002],
    [0, 0.000002],
    [0, 0],
  ];
  const route: ProcessionRoute = {
    id: 'test',
    kind: 'procession',
    title: { en: 'Test' },
    status: 'draft',
    schedule: {
      month: 9,
      weekday: 6,
      nth: 3,
      offset_days: 0,
      start: '12:00',
      duration_min: 10,
      timezone: 'UTC',
    },
    route: [
      [0, 0],
      [0.001, 0],
    ],
    length_m: 100,
    segments: [{ id: 'osm:way/1', width_m: 5, sidewalk_m: 0 }],
    blocked: [ring],
  };
  const output = quantizeGroundRoutes([route])[0]!;
  if (output.kind !== 'procession') throw Error('Wrong kind');
  expect(output.blocked).toEqual([
    [
      [0, 0],
      [0.000002, 0],
      [0.000002, 0.000002],
      [0, 0.000002],
      [0, 0],
    ],
  ]);
  expect(route.blocked[0]).toHaveLength(7);
});
