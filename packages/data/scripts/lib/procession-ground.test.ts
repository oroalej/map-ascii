import { describe, expect, it } from 'vitest';
import { CityProcessions, Procession } from '@atlas/shared';
import type { Feature, Geometry } from 'geojson';
import { routeProcessions } from './procession';
import { requiredFormationWidth } from './procession-ground';
import { localFrame } from './geo';
import { intersection } from 'polyclip-ts';
import { seatingFootprint } from './footprints';

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
const area = (id: string, cls: string, w: number, s: number, e: number, n: number): F => ({
  type: 'Feature',
  properties: { id, class: cls, ...(cls.startsWith('building') && { height: 5 }) },
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
  it('uses an exterior Mass anchor and excludes complete cells and approaches from a thin diagonal church footprint', () => {
    const frame = localFrame([0, 0]);
    const church: F = {
      type: 'Feature',
      properties: { id: 'osm:way/10', class: 'building_worship', height: 5 },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-10, -10.2],
            [10.2, 10],
            [10, 10.2],
            [-10.2, -10],
            [-10, -10.2],
          ].map((q) => frame.toLngLat(q as [number, number])),
        ],
      },
    };
    const ground = area('osm:way/11', 'park', -0.0002, -0.0002, 0.0002, 0.0002);
    const event = Procession.parse({
      title: base.title,
      story: base.story,
      status: base.status,
      schedule: base.schedule,
      id: 'procession/exterior',
      kind: 'mass',
      site: 'osm:way/10',
      grounds: ['osm:way/11'],
      radius_m: 25,
      gathering_anchor: frame.toLngLat([-8, 0]),
    });
    const route = routeProcessions([church, ground], [event]).routes[0]!;
    if (route.kind !== 'mass' || church.geometry.type !== 'Polygon') throw Error();
    const roof = church.geometry.coordinates.map((ring) =>
      ring.map((q): [number, number] => [q[0]!, q[1]!]),
    );
    expect(
      Math.hypot(...frame.toMeters(route.site.anchor).map((v, i) => v - [-8, 0][i]!)),
    ).toBeLessThanOrEqual(2);
    for (const ring of route.site.grounds) expect(intersection([ring], roof).length).toBe(0);
    for (const line of route.site.approaches)
      for (let i = 1; i < line.length; i++)
        expect(
          intersection(
            seatingFootprint([line[i - 1]!, line[i]!], 1.1).coordinates as [number, number][][][],
            roof,
          ).length,
        ).toBe(0);
    expect(() =>
      routeProcessions(
        [church, ground],
        [Procession.parse({ ...event, gathering_anchor: [0, 0] })],
      ),
    ).toThrow('safe exterior');
  });
  it.each([
    { kind: 'procession', formation: { bearers: 4 } },
    { kind: 'procession', formation: { bearers: 8 } },
    { kind: 'procession', formation: { bearers: 24 } },
    ...['car', 'truck', 'motorcycle'].map((vehicle) => ({
      kind: 'parade',
      formation: { vehicles: [vehicle] },
    })),
  ])('admits exactly sufficient physical clearance for %j', (formation) => {
    const event = Procession.parse({ ...base, ...formation });
    if (event.kind !== 'procession' && event.kind !== 'parade') throw Error();
    const minimum = requiredFormationWidth(event),
      way = road(
        'osm:way/3',
        [
          [0, 0],
          [0.002, 0],
        ],
        { width: minimum, sidewalk: 'none' },
      );
    expect(routeProcessions([features[0]!, features[1]!, way], [event]).routes).toHaveLength(1);
    way.properties.width = minimum - 0.01;
    expect(() => routeProcessions([features[0]!, features[1]!, way], [event])).toThrow(
      'admissible',
    );
  });
  it('keeps an explicitly sized footway at its mapped width without invented sidewalks', () => {
    const route = routeProcessions(
      [
        features[0]!,
        features[1]!,
        road(
          'osm:way/3',
          [
            [0, 0],
            [0.002, 0],
          ],
          { class: 'path', highway: 'footway', width: undefined, event_path_width: 6 },
        ),
        area('osm:way/9', 'water_area', 0.0008, 0.000029, 0.0012, 0.00004),
      ],
      [Procession.parse(base)],
    ).routes[0]!;
    if (route.kind !== 'procession') throw Error();
    expect(
      route.segments.every((segment) => segment.width_m === 6 && segment.sidewalk_m === 0),
    ).toBe(true);
    expect(route.water).toEqual([]);
  });
  it('follows pinned via ways despite a shorter admissible road', () => {
    const r = routeProcessions(
      [
        ...features.slice(0, 3),
        road('osm:way/4', [
          [0, 0],
          [0.002, 0],
        ]),
      ],
      [Procession.parse({ ...base, route: { ...base.route, via: ['osm:way/3'] } })],
    ).routes[0]!;
    if (r.kind !== 'procession') throw Error();
    expect(new Set(r.segments.map((s) => s.id))).toEqual(new Set(['osm:way/3']));
    expect(r.length_m).toBeGreaterThan(300);
  });
  it('reroutes around a roof and never drops the roof exclusion wholesale', () => {
    const r = routeProcessions(
      [
        features[0]!,
        features[1]!,
        features[2]!,
        road('osm:way/4', [
          [0, 0],
          [0.002, 0],
        ]),
        area('osm:way/9', 'building', 0.0008, -0.0001, 0.0012, 0.0001),
      ],
      [Procession.parse(base)],
    ).routes[0]!;
    if (r.kind !== 'procession') throw Error();
    expect(new Set(r.segments.map((s) => s.id))).toEqual(new Set(['osm:way/3']));
  });
  it('bakes only local bridge permission and trims water to the event corridor', () => {
    const source = [
      features[0]!,
      features[1]!,
      road(
        'osm:way/4',
        [
          [0, 0],
          [0.002, 0],
        ],
        { bridge: 'yes' },
      ),
      area('osm:way/9', 'water_area', 0.0008, -0.01, 0.0012, 0.01),
    ];
    const r = routeProcessions(source, [Procession.parse(base)]).routes[0]!;
    if (r.kind !== 'procession') throw Error();
    expect(r.bridges!.length).toBeGreaterThan(0);
    expect(r.water!.length).toBeGreaterThan(0);
    expect(r.water!.flat().every((q) => Math.abs(q[1]) < 0.0001)).toBe(true);
    expect(CityProcessions.safeParse({ processions: [r] }).success).toBe(true);
    source[2]!.properties.bridge = 'no';
    expect(() => routeProcessions(source, [Procession.parse(base)])).toThrow('not near');
  });
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
    // Bearers form two longitudinal columns, so adding rows doesn't widen their footprint.
    expect(requiredFormationWidth(b)).toBe(requiredFormationWidth(a));
  });
  it.each([{ access: 'no' }, { vehicle: 'no' }])(
    'keeps a pedestrian exemption separate from parade vehicles (%s)',
    (restriction) => {
      const source = [
        features[0]!,
        features[1]!,
        road(
          'osm:way/3',
          [
            [0, 0],
            [0.002, 0],
          ],
          { foot: 'yes', ...restriction },
        ),
      ];
      expect(routeProcessions(source, [Procession.parse(base)]).routes).toHaveLength(1);
      expect(() =>
        routeProcessions(source, [
          Procession.parse({ ...base, kind: 'parade', formation: { vehicles: ['car'] } }),
        ]),
      ).toThrow('admissible');
    },
  );
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
    const water = rect('osm:way/12', 'water_area', -0.01, -0.01, -0.00025, 0.01);
    const bundle = routeProcessions(
      [...features, church, grounds, water],
      [mass, Procession.parse(base)],
    );
    const r = bundle.routes[0]!;
    if (r.kind !== 'mass') throw Error();
    expect(r.schedule.start).toBe('16:00');
    expect(r.site.anchor).not.toEqual(r.site.location);
    expect(r.site.approaches.length).toBeGreaterThan(0);
    expect(r.site.grounds.length).toBeGreaterThan(5);
    const frame = localFrame(r.site.location);
    for (const q of r.site.blocked.flat())
      expect(Math.max(...frame.toMeters(q).map(Math.abs))).toBeLessThanOrEqual(
        r.site.radius_m + 1e-6,
      );
    for (const q of r.site.grounds.flat())
      expect(Math.hypot(...frame.toMeters(q))).toBeLessThanOrEqual(r.site.radius_m + 1e-6);
    expect(r.site.grounds.flat().every((q) => q[0] > -0.00025)).toBe(true);
    expect(r.site.blocked).toContainEqual(
      (church.geometry as { coordinates: number[][][] }).coordinates[0],
    );
    expect(CityProcessions.safeParse({ processions: bundle.routes }).success).toBe(true);
  });
});
