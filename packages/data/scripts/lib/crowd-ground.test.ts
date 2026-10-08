import { expect, it } from 'vitest';
import {
  pointInPolygon,
  Procession,
  localMetricProjection,
  processionAltarLayout,
  PROCESSION_GEOMETRY,
} from '@atlas/shared';
import type { Feature, Geometry } from 'geojson';
import { localFrame } from './geo';
import { bakeCrowdAreas, compactLattice } from './crowd-ground';
import { difference } from 'polyclip-ts';
import { routeStreet, bakeMassSite, bakeFluvialCrowd } from './procession-ground';
import { measureBanks } from './procession';
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
const mass = (extra = {}) =>
  Procession.parse({
    id: 'procession/mass',
    kind: 'mass',
    title: { en: 'Mass' },
    story: { en: 'Illustrative' },
    status: 'draft',
    site: 'osm:way/1',
    grounds: ['osm:way/2'],
    radius_m: 20,
    schedule: {
      month: 9,
      weekday: 6,
      nth: 3,
      offset_days: 0,
      start: '12:00',
      duration_min: 60,
      timezone: 'Asia/Manila',
    },
    ...extra,
  });
it('clips boundary-free seating before and after expansion', () => {
  const event = mass();
  if (event.kind !== 'mass') throw Error();
  const site = bakeMassSite(
    [
      feature('osm:way/1', 'building_worship', box(-1, -1, 1, 1), { height: 5 }),
      feature('osm:way/2', 'park', box(-20, -20, 20, 20)),
      feature('osm:way/3', 'seating', box(18, -3, 24, 3)),
      feature('osm:way/4', 'seating', box(100, -3, 108, 3)),
    ],
    event,
  );
  expect(site.seated_grounds!.length).toBeGreaterThan(0);
  for (const point of site.seated_grounds!.flat())
    expect(Math.max(...frame.toMeters(point).map(Math.abs))).toBeLessThanOrEqual(20 + 1e-6);
  expect(site.seated_grounds!.some((ring) => pointInPolygon(q(102, 0), [ring]))).toBe(false);
});
it.each([false, true])(
  'uses hard-only role exclusions with an authored boundary: %s',
  (boundary) => {
    const event = mass({
      radius_m: 40,
      ...(boundary && { crowd_boundary: box(-40, -40, 40, 40) }),
      altar: { at: q(25, 0), radius_m: 1 },
    });
    if (event.kind !== 'mass') throw Error();
    const site = bakeMassSite(
      [
        feature('osm:way/1', 'building_worship', box(-1, -1, 1, 1), { height: 5 }),
        feature('osm:way/2', 'park', box(-40, -40, 40, 40)),
        feature('osm:way/3', 'seating', box(-25, 3, -15, 6)),
        feature('osm:way/4', 'building', box(-21, 4, -19, 6), { height: 5 }),
        feature('osm:way/5', 'building', box(34, -2, 36, 0), { height: 5 }),
      ],
      event,
      3,
    );
    const inRings = (rings: Point[][], point: Point) =>
      rings.some((ring) => pointInPolygon(point, [ring]));
    expect(inRings(site.seated_grounds!, q(-23, 4))).toBe(true);
    expect(inRings(site.blocked, q(-23, 4))).toBe(false);
    expect(inRings(site.grounds, q(-23, 4))).toBe(false);
    expect(inRings(site.seated_grounds!, q(-20, 5))).toBe(false);
    expect(inRings(site.blocked, q(-20, 5))).toBe(true);
    expect(inRings(site.altar_ground!, q(25, 0))).toBe(true);
    expect(inRings(site.blocked, q(25, 0))).toBe(false);
    expect(inRings(site.grounds, q(25, 0))).toBe(false);
    expect(inRings(site.altar_ground!, q(35, -0.5))).toBe(false);
    expect(inRings(site.blocked, q(35, -0.5))).toBe(true);
  },
);
it.each([0, 1, 2, 3])(
  'covers complete fixed altar members for %s images at the minimum radius',
  (images) => {
    const event = mass({ radius_m: 40, altar: { at: q(25, 0), radius_m: 1 } });
    if (event.kind !== 'mass') throw Error();
    const site = bakeMassSite(
      [
        feature('osm:way/1', 'building_worship', box(-1, -1, 1, 1), { height: 5 }),
        feature('osm:way/2', 'park', box(-40, -40, 40, 40)),
      ],
      event,
      images,
    );
    for (const member of processionAltarLayout(images)) {
      const size = member.footprint ?? PROCESSION_GEOMETRY.person;
      for (const sx of [-1, 1])
        for (const sy of [-1, 1]) {
          const point = q(
            25 + member.x + sx * (size.width / 2 + PROCESSION_GEOMETRY.probePadding),
            member.y + sy * (size.length / 2 + PROCESSION_GEOMETRY.probePadding),
          );
          expect(site.altar_ground!.some((ring) => pointInPolygon(point, [ring]))).toBe(true);
        }
    }
  },
);
it('derives the Mass extent around the displaced altar and rejects unsupported extents', () => {
  const source = [
    feature('osm:way/1', 'building_worship', box(-1, -1, 1, 1), { height: 5 }),
    feature('osm:way/2', 'park', box(-40, -40, 40, 40)),
  ];
  const event = mass({
    crowd_boundary: box(-40, -40, 40, 40),
    altar: { at: q(20, 0), radius_m: 2 },
  });
  if (event.kind !== 'mass') throw Error();
  const site = bakeMassSite(source, event),
    fill = localMetricProjection(event.altar!.at);
  expect(site.radius_m).toBeGreaterThan(event.radius_m);
  for (const point of [...site.grounds, ...site.seated_grounds!].flat())
    expect(Math.hypot(...fill.to(point))).toBeLessThanOrEqual(site.radius_m);
  expect(() => bakeMassSite(source, { ...event, altar: { at: q(600, 0), radius_m: 2 } })).toThrow(
    'baked crowd extent',
  );
});
it('keeps fluvial spectators on the river sides, off the water, decks and inland streets', () => {
  const water = [
    feature('osm:way/1', 'water', box(-101, -5, -10, 5)),
    feature('osm:way/2', 'water', box(10, -5, 101, 5)),
  ];
  const route = Array.from({ length: 21 }, (_, i) => q(-100 + i * 10, 0));
  const waterPolygons = water.map((f) => {
    if (f.geometry.type !== 'Polygon') throw Error();
    return f.geometry.coordinates.map((r) => r.map((p) => frame.toMeters([p[0]!, p[1]!])));
  });
  const banks = measureBanks(route.map(frame.toMeters), waterPolygons)!;
  expect(banks).toHaveLength(route.length);
  expect(banks[10]).toEqual(banks[9]);
  const decks = [-60, 60].map((x, i): F => ({
    type: 'Feature',
    properties: { id: `osm:way/${i + 3}`, class: 'road_minor', width: 4, bridge: 'yes' },
    geometry: { type: 'LineString', coordinates: [q(x, -40), q(x, 40)] },
  }));
  const crowd = bakeFluvialCrowd([...water, ...decks], route, banks);
  expect(crowd.bridges).toEqual([]);
  const allows = (x: number, y: number) => {
    const point = q(x, y);
    return (
      crowd.grounds.some((ring) => pointInPolygon(point, [ring])) &&
      !crowd.blocked.some((ring) => pointInPolygon(point, [ring])) &&
      !crowd.water.some((ring) => pointInPolygon(point, [ring]))
    );
  };
  // Both banks, right at the water and up to 8 m inland.
  for (const y of [-6, 6, -12, 12]) expect(allows(-30, y)).toBe(true);
  // Never on the water, a bridge deck or the streets further inland.
  expect(allows(-30, 0)).toBe(false);
  expect(allows(0, 0)).toBe(false);
  expect(allows(-60, 8)).toBe(false);
  expect(allows(60, -8)).toBe(false);
  expect(allows(-30, 16)).toBe(false);
  expect(allows(-30, -25)).toBe(false);
});
it('losslessly compacts adjacent lattice rows while retaining holes and disconnected pieces', () => {
  const cells = new Map<string, Point>();
  for (let y = 0; y < 4; y++)
    for (const x of [0, 1, 2, 3, 4, 7])
      if (x !== 2 || y !== 1) cells.set(`${x}/${y}`, [x * 2, y * 2]);
  const rings = compactLattice(frame, cells);
  const expected = [[box(-1, -1, 9, 7), box(3, 1, 5, 3)], [box(13, -1, 15, 7)]];
  const actual = rings.map((ring) => [ring]);
  expect(rings).toHaveLength(5);
  expect(difference(expected, actual)).toHaveLength(0);
  expect(difference(actual, expected)).toHaveLength(0);
  expect(rings.some((ring) => pointInPolygon(q(4, 2), [ring]))).toBe(false);
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
