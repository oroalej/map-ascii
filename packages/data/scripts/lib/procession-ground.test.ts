import { describe, expect, it } from 'vitest';
import { CityProcessions, Procession } from '@atlas/shared';
import type { Feature, Geometry } from 'geojson';
import { routeProcessions } from './procession';
import { requiredFormationWidth } from './procession-ground';

type F = Feature<Geometry, Record<string, unknown>>;
const point = (id: string, at: number[]): F => ({
  type: 'Feature',
  properties: { id, class: 'monument' },
  geometry: { type: 'Point', coordinates: at },
});
const road = (id: string, coordinates: number[][], extra: Record<string, unknown> = {}): F => ({
  type: 'Feature',
  properties: { id, class: 'road_minor', highway: 'residential', width: 8, ...extra },
  geometry: { type: 'LineString', coordinates },
});
const base = {
  id: 'procession/street',
  title: { en: 'Street' },
  story: { en: 'Illustrative' },
  status: 'draft',
  kind: 'procession',
  route: { from: 'osm:node/1', to: 'osm:node/2' },
  schedule: {
    month: 9,
    weekday: 6,
    nth: 3,
    offset_days: -8,
    start: '12:00',
    duration_min: 240,
    timezone: 'Asia/Manila',
  },
  season: 'fiesta',
  label: { en: 'Procession' },
};
const features = [
  point('osm:node/1', [0, 0]),
  point('osm:node/2', [0.002, 0]),
  road('osm:way/3', [
    [0, 0],
    [0.001, 0.001],
    [0.002, 0],
  ]),
  road(
    'osm:way/4',
    [
      [0, 0],
      [0.002, 0],
    ],
    { class: 'path', highway: 'steps', width: 8 },
  ),
];
describe('street event routing', () => {
  it('uses the admissible detour, preserves metadata and aligns samples and source widths', () => {
    const p = Procession.parse(base);
    const r = routeProcessions(features, [p]).routes[0]!;
    expect(r.kind).toBe('procession');
    if (r.kind !== 'procession') throw Error();
    expect(r.season).toBe('fiesta');
    expect(r.label?.en).toBe('Procession');
    expect(r.segments).toHaveLength(r.route.length - 1);
    expect(new Set(r.segments.map((e) => e.id))).toEqual(new Set(['osm:way/3']));
    expect(CityProcessions.safeParse({ processions: [r] }).success).toBe(true);
    for (let i = 1; i < r.route.length; i++)
      expect(
        Math.hypot(r.route[i]![0] - r.route[i - 1]![0], r.route[i]![1] - r.route[i - 1]![1]) *
          111320,
      ).toBeLessThanOrEqual(10.01);
  });
  it('rejects pinned steps, unknown path width, inaccessible vehicles and disconnected endpoints', () => {
    expect(() =>
      routeProcessions(features, [
        Procession.parse({ ...base, route: { ...base.route, via: ['osm:way/4'] } }),
      ]),
    ).toThrow('admissible');
    const path = road(
      'osm:way/4',
      [
        [0, 0],
        [0.002, 0],
      ],
      { class: 'path', highway: 'footway', width: undefined },
    );
    expect(() =>
      routeProcessions([features[0]!, features[1]!, path], [Procession.parse(base)]),
    ).toThrow('admissible');
    const parade = Procession.parse({
      ...base,
      kind: 'parade',
      formation: { vehicles: ['truck'] },
    });
    expect(() =>
      routeProcessions(
        [
          features[0]!,
          features[1]!,
          road(
            'osm:way/3',
            [
              [0, 0],
              [0.002, 0],
            ],
            { hgv: 'no' },
          ),
        ],
        [parade],
      ),
    ).toThrow('admissible');
    expect(() =>
      routeProcessions(
        [features[0]!, point('osm:node/2', [0.01, 0]), features[2]!],
        [Procession.parse(base)],
      ),
    ).toThrow('not near');
    const a = Procession.parse({ ...base, formation: { bearers: 4 } }),
      b = Procession.parse({ ...base, formation: { bearers: 24 } });
    if (a.kind !== 'procession' || b.kind !== 'procession') throw Error();
    expect(requiredFormationWidth(b)).toBeGreaterThan(requiredFormationWidth(a));
  });
  it('bakes connected outdoor Mass permissions without a building in the gathering', () => {
    const rect = (id: string, cls: string, w: number, s: number, e: number, n: number): F => ({
      type: 'Feature',
      properties: { id, class: cls, height: 5 },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [w, s],
            [e, s],
            [e, n],
            [w, n],
            [w, s],
          ],
        ],
      },
    });
    const mass = Procession.parse({
      id: 'procession/mass',
      title: { en: 'Mass' },
      story: { en: 'Illustrative' },
      status: 'draft',
      kind: 'mass',
      site: 'osm:way/10',
      grounds: ['osm:way/11'],
      radius_m: 60,
      schedule: { follows: base.id, duration_min: 90 },
    });
    const church = rect('osm:way/10', 'building_worship', -0.0001, -0.0001, 0.0001, 0.0001);
    const grounds = rect('osm:way/11', 'building_religious', -0.0004, -0.0004, 0.0004, 0.0004);
    delete grounds.properties.height; // Religious grounds use a building class without a standing roof.
    const bundle = routeProcessions([...features, church, grounds], [mass, Procession.parse(base)]);
    const r = bundle.routes[0]!;
    if (r.kind !== 'mass') throw Error();
    expect(r.schedule.start).toBe('16:00');
    expect(r.site.anchor).not.toEqual(r.site.location);
    expect(r.site.approaches.length).toBeGreaterThan(0);
    expect(r.site.grounds.length).toBeGreaterThan(5);
    expect(r.site.blocked).toContainEqual(
      (church.geometry as { coordinates: number[][][] }).coordinates[0],
    );
    expect(CityProcessions.safeParse({ processions: bundle.routes }).success).toBe(true);
  });
});
