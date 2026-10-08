import { type Procession } from '@atlas/shared';
import type { Feature, Geometry } from 'geojson';
import { describe, expect, it } from 'vitest';
import { featurePoint, routeProcessions } from './procession';

type F = Feature<Geometry, Record<string, unknown>>;
const river = (id: string, name: string | undefined, coordinates: [number, number][]): F => ({
  type: 'Feature',
  properties: { id, class: 'water_river', ...(name ? { name } : {}) },
  geometry: { type: 'LineString', coordinates },
});
const point = (id: string, coordinates: [number, number]): F => ({
  type: 'Feature',
  properties: { id, class: 'monument' },
  geometry: { type: 'Point', coordinates },
});

// A river flowing west through a confluence at x = 0.001, where a longer unnamed stream joins it
// from the north (0.001° ≈ 111 m at the equator).
const features: F[] = [
  river('osm:way/1', 'Naga River', [
    [0.003, 0],
    [0.001, 0],
  ]),
  river('osm:way/2', undefined, [
    [0.001, 0.004],
    [0.001, 0],
  ]),
  river('osm:way/3', 'Naga River', [
    [0.001, 0],
    [0, 0],
  ]),
  point('osm:node/10', [0.0002, 0.0001]),
  point('osm:node/11', [0.0025, -0.0001]),
  point('osm:node/12', [0.0002, 0.01]),
  // A landmark about 190 m north of the river (and further from the stream).
  point('osm:node/13', [0.0029, 0.0017]),
];

type Fluvial = Extract<Procession, { kind: 'fluvial' }>;
const procession = (route: Fluvial['route']): Fluvial => ({
  id: 'procession/test',
  title: { en: 'Test' },
  story: { en: 'TODO(verify)' },
  status: 'draft',
  kind: 'fluvial',
  route,
  schedule: {
    month: 9,
    weekday: 0,
    nth: 3,
    offset_days: -1,
    start: '15:00',
    duration_min: 180,
    timezone: 'Asia/Manila',
  },
});

describe('routeProcessions', () => {
  it('keeps the river beyond the landing on the same river, recording where the pagoda stops', () => {
    const { routes } = routeProcessions(features, [
      procession({ from: 'osm:node/13', to: 'osm:node/11', beyond_m: 300 }),
    ]);
    const route = routes[0]!;
    if (route.kind !== 'fluvial') throw Error();
    // Landing 0.0004° downstream of the start; then on west past the confluence on the Naga
    // River (not up the longer stream), until the river ends at x = 0.
    expect(route.landing_m).toBeCloseTo(0.0004 * 111_320, -1);
    expect(route.length_m).toBeCloseTo(0.0029 * 111_320, -1);
    expect(route.route.every(([, y]) => Math.abs(y) < 1e-6)).toBe(true);
    expect(route.route.at(-1)![0]).toBeCloseTo(0, 6);
    const short = routeProcessions(features, [
      procession({ from: 'osm:node/13', to: 'osm:node/11', beyond_m: 20 }),
    ]).routes[0]!;
    expect(short.length_m).toBe(Math.round(0.0004 * 111_320 + 20));
    // River kept behind the departure for the followers, upstream of a westward route.
    const behind = routeProcessions(features, [
      procession({ from: 'osm:node/11', to: 'osm:node/10', before_m: 30, beyond_m: 10 }),
    ]).routes[0]!;
    if (behind.kind !== 'fluvial') throw Error();
    expect(behind.departure_m).toBe(30);
    expect(behind.route[0]![0]).toBeCloseTo(0.0025 + 30 / 111_320, 6);
    expect(behind.landing_m).toBe(Math.round(30 + 0.0023 * 111_320));
    expect(behind.route.every(([, y]) => Math.abs(y) < 1e-6)).toBe(true);
  });
  it('resolves a following Mass first, retaining a nonzero offset and carrying midnight', () => {
    const parent = {
      ...procession({ to: 'osm:node/10', upstream_m: 200 }),
      schedule: {
        month: 9,
        weekday: 6,
        nth: 3,
        offset_days: -8,
        start: '23:30',
        duration_min: 90,
        timezone: 'Asia/Manila',
      },
    };
    const mass: Procession = {
      id: 'procession/mass',
      title: { en: 'Mass' },
      story: { en: 'Illustrative' },
      status: 'draft',
      kind: 'mass',
      site: 'osm:node/10',
      grounds: ['osm:way/20'],
      radius_m: 100,
      schedule: { follows: parent.id, duration_min: 60 },
    };
    const grounds: F = {
      type: 'Feature',
      properties: { id: 'osm:way/20', class: 'park' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [0.0001, 0.0001],
            [0.0007, 0.0001],
            [0.0007, 0.0007],
            [0.0001, 0.0007],
            [0.0001, 0.0001],
          ],
        ],
      },
    };
    const { routes, warnings } = routeProcessions([...features, grounds], [mass, parent]);
    expect(warnings).toEqual([]);
    expect(routes.find((route) => route.id === mass.id)?.schedule).toMatchObject({
      offset_days: -7,
      start: '01:00',
      timezone: 'Asia/Manila',
    });
  });
  it('walks upstream along the same river, then runs downstream to the landing', () => {
    const { routes, warnings } = routeProcessions(features, [
      procession({ to: 'osm:node/10', upstream_m: 200 }),
    ]);
    expect(warnings).toEqual([]);
    const [r] = routes;
    expect(r!.length_m).toBeCloseTo(200, -1);
    // It starts upstream on the named river (y = 0), not up the longer stream.
    expect(r!.route[0]![1]).toBeCloseTo(0, 6);
    expect(r!.route[0]![0]).toBeGreaterThan(0.0015);
    // It ends where the landing meets the river.
    expect(r!.route.at(-1)![0]).toBeCloseTo(0.0002, 5);
    expect(r!.route.at(-1)![1]).toBeCloseTo(0, 6);
  });

  it('follows the river between a start and the landing', () => {
    const { routes } = routeProcessions(features, [
      procession({ to: 'osm:node/10', from: 'osm:node/11' }),
    ]);
    const r = routes[0]!;
    expect(r.route[0]![0]).toBeCloseTo(0.0025, 5);
    expect(r.route.at(-1)![0]).toBeCloseTo(0.0002, 5);
    expect(r.length_m).toBeCloseTo(0.0023 * 111_320, -1);
  });

  it('ends at the river point nearest a landmark a short walk away, going upstream', () => {
    const { routes } = routeProcessions(features, [
      procession({ from: 'osm:node/10', to: 'osm:node/13' }),
    ]);
    const r = routes[0]!;
    expect(r.route[0]![0]).toBeCloseTo(0.0002, 5);
    expect(r.route.at(-1)).toEqual([0.0029, 0]);
  });

  it('measures the banks along the way, where the river is mapped as water', () => {
    const water: F = {
      type: 'Feature',
      properties: { id: 'osm:way/50', class: 'water_area' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-0.001, -0.0001],
            [0.004, -0.0001],
            [0.004, 0.00015],
            [-0.001, 0.00015],
            [-0.001, -0.0001],
          ],
        ],
      },
    };
    const trip = procession({ from: 'osm:node/10', to: 'osm:node/11' });
    const [r] = routeProcessions([...features, water], [trip]).routes;
    // Points at most 10 m apart, each with its banks.
    expect(r!.banks).toHaveLength(r!.route.length);
    for (let i = 1; i < r!.route.length; i++) {
      expect(Math.abs(r!.route[i]![0] - r!.route[i - 1]![0]) * 111_320).toBeLessThanOrEqual(10.01);
    }
    // Heading east: the north bank (about 16.6 m) on the left, the south (about 11 m) on the right.
    const [left, right] = r!.banks![5]!;
    expect(left).toBeCloseTo(16.5, 0);
    expect(right).toBeCloseTo(11, 0);
    // Without mapped water, no banks.
    expect(routeProcessions(features, [trip]).routes[0]!.banks).toBeUndefined();
  });

  it('warns when the river ends before the distance upstream', () => {
    const { routes, warnings } = routeProcessions(features, [
      procession({ to: 'osm:node/10', upstream_m: 5000 }),
    ]);
    expect(warnings).toHaveLength(1);
    expect(routes[0]!.route[0]).toEqual([0.003, 0]);
  });

  it('fails loudly for a landing far from any river, or one not in the data', () => {
    expect(() =>
      routeProcessions(features, [procession({ to: 'osm:node/12', upstream_m: 100 })]),
    ).toThrow(/from a river/);
    expect(() =>
      routeProcessions(features, [procession({ to: 'osm:node/99', upstream_m: 100 })]),
    ).toThrow(/not in the data/);
  });
});

describe('featurePoint', () => {
  it('uses a label anchor, else the vertices’ average', () => {
    const area: F = {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [2, 0],
            [2, 2],
            [0, 2],
          ],
        ],
      },
    };
    expect(featurePoint(area)).toEqual([1, 1]);
    expect(featurePoint({ ...area, properties: { label_lng: 5, label_lat: 6 } })).toEqual([5, 6]);
  });
});
