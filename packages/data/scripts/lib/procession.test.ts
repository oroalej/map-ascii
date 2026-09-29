import type { Procession } from '@atlas/shared';
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
];

const procession = (route: Procession['route']): Procession => ({
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
