import { expect, it } from 'vitest';
import { pointInPolygon, Procession } from '@atlas/shared';
import type { Feature, Geometry } from 'geojson';
import { localFrame } from './geo';
import { bakeCrowdAreas } from './crowd-ground';
import { routeStreet, bakeMassSite } from './procession-ground';
type Point = [number, number];
type F = Feature<Geometry, Record<string, unknown>>;
const frame = localFrame([0, 0]);
const q = (x: number, y: number) => frame.toLngLat([x, y]);
const box = (w: number, s: number, e: number, n: number): Point[] => [
  q(w, s),
  q(e, s),
  q(e, n),
  q(w, n),
  q(w, s),
];
const feature = (id: string, cls: string, ring: Point[], extra = {}): F => ({
  type: 'Feature',
  properties: { id, class: cls, ...extra },
  geometry: { type: 'Polygon', coordinates: [ring] },
});
it('retains safe disconnected components and removes the complete separator', () => {
  const separator = box(-1, -20, 1, 20);
  const result = bakeCrowdAreas(frame, [[box(-20, -20, 20, 20)]], [separator]);
  expect(result.some((r) => pointInPolygon(q(-10, 0), [r]))).toBe(true);
  expect(result.some((r) => pointInPolygon(q(10, 0), [r]))).toBe(true);
  expect(result.some((r) => pointInPolygon(q(0, 0), [r]))).toBe(false);
});
it('proves exclusion-aware width and keeps tag-only sidewalks with derived verges', () => {
  const event = Procession.parse({
    id: 'procession/test',
    kind: 'procession',
    title: { en: 'Test' },
    story: { en: 'Test' },
    status: 'draft',
    route: { from: 'osm:node/1', to: 'osm:node/2' },
    schedule: {
      month: 9,
      weekday: 6,
      nth: 3,
      offset_days: 0,
      start: '12:00',
      duration_min: 10,
      timezone: 'Asia/Manila',
    },
  });
  if (event.kind !== 'procession') throw Error();
  const points: F[] = [
    {
      type: 'Feature',
      properties: { id: 'osm:node/1' },
      geometry: { type: 'Point', coordinates: q(0, 0) },
    },
    {
      type: 'Feature',
      properties: { id: 'osm:node/2' },
      geometry: { type: 'Point', coordinates: q(100, 0) },
    },
  ];
  const road: F = {
    type: 'Feature',
    properties: { id: 'osm:way/3', class: 'road_minor', highway: 'residential', width: 8 },
    geometry: { type: 'LineString', coordinates: [q(0, 0), q(100, 0)] },
  };
  const result = routeStreet(
    [...points, road, feature('osm:way/4', 'building', box(20, 2.5, 80, 10), { height: 5 })],
    event,
  );
  expect(result.segments.every((s) => s.sidewalk_m === 0)).toBe(true);
  expect(result.segments.some((s) => s.verge_m.right === 6)).toBe(true);
  expect(result.segments.some((s) => s.clear_m < 6)).toBe(true);
  expect(result.blocked.length).toBeGreaterThan(0);
  road.properties.width = 5;
  expect(routeStreet([...points, road], event).segments.every((s) => s.clear_m === 5)).toBe(true);
  road.properties.width = 3.4;
  expect(() => routeStreet([...points, road], event)).toThrow('no admissible roads');
});
it('a boundary replaces radius and ground restrictions while altar permission stays separate', () => {
  const church = feature('osm:way/1', 'building_worship', box(-3, -3, 3, 3), { height: 10 });
  const event = Procession.parse({
    id: 'procession/test',
    kind: 'mass',
    title: { en: 'Test' },
    story: { en: 'Test' },
    status: 'draft',
    site: 'osm:way/1',
    grounds: ['osm:way/2'],
    radius_m: 10,
    crowd_boundary: box(-40, -40, 40, 40),
    altar: { at: q(20, 0), radius_m: 5 },
    schedule: {
      month: 9,
      weekday: 6,
      nth: 3,
      offset_days: 0,
      start: '12:00',
      duration_min: 10,
      timezone: 'Asia/Manila',
    },
  });
  if (event.kind !== 'mass') throw Error();
  const site = bakeMassSite([church, feature('osm:way/2', 'park', box(4, 4, 10, 10))], event, 2);
  expect(site.grounds.some((r) => pointInPolygon(q(-20, 20), [r]))).toBe(true);
  expect(site.grounds.some((r) => pointInPolygon(q(20, 0), [r]))).toBe(false);
  expect(site.altar_ground?.some((r) => pointInPolygon(q(20, 0), [r]))).toBe(true);
  expect(site.altar?.images).toBe(2);
  expect(site.closure_zone).toEqual([event.crowd_boundary]);
});
