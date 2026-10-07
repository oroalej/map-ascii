import { expect, it } from 'vitest';
import type { MassRoute } from '@atlas/shared';
import { LifeWorld, type VisibleAgent } from './simulate';
import { LifeBuilder } from './geometry';
import { metersPerUnit, tileToLngLat, lngLatToTile } from '../raster/geometry';
import { snapshotOf, cellTerrainFrom } from './terrain-snapshot';
import { makeCellGuard } from './cell-guard';
import { groundsForRoutes } from './ground-events';
const tile = { z: 16, x: 55192, y: 30266 },
  pm = 1 / metersPerUnit(tile);
const square = (lo: number, hi: number) => [
  { x: lo, y: lo },
  { x: hi, y: lo },
  { x: hi, y: hi },
  { x: lo, y: hi },
  { x: lo, y: lo },
];
const q = (x: number, y: number) => tileToLngLat(tile, { x, y });
it('transfers selected seating permission without losing hard roofs or ordinary blocked ground', () => {
  const seating = square(1000, 3000),
    roof = square(1900, 2100),
    b = new LifeBuilder();
  b.area('blocked', [seating], false, undefined, true);
  b.area('blocked', [roof]);
  const world = new LifeWorld();
  const ring = seating.map((p) => q(p.x, p.y));
  const route: MassRoute = {
    id: 'mass',
    kind: 'mass',
    title: { en: 'Mass' },
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
    site: {
      id: 'osm:way/1',
      location: q(2000, 2000),
      anchor: q(1200, 1200),
      radius_m: 300,
      grounds: [],
      seated_grounds: [ring],
      blocked: [],
      roads: [],
      approaches: [[q(1000, 1000), q(1200, 1200)]],
    },
  };
  world.setProcessions([route]);
  world.sync([{ key: 'test', tile, life: b.finish() }]);
  const terrain = world.cellTerrain()!,
    received = cellTerrainFrom(structuredClone(snapshotOf(terrain).snapshot));
  const toCell = (lng: number, lat: number): [number, number] => {
    const p = lngLatToTile(tile, lng, lat);
    return [p.x / pm, p.y / pm];
  };
  const inline = world.groundCellGuard(toCell)!,
    worker = makeCellGuard(
      received.ref,
      received.access,
      received.trees,
      toCell,
      groundsForRoutes([route]),
      received.blocked,
      received.hardBlocked,
    );
  const agent: VisibleAgent = {
    kind: 'person',
    lng: 0,
    lat: 0,
    flap: 0,
    eventGround: route.id,
    eventRole: 'seated',
  };
  const seat = toCell(...q(1200, 1200)),
    hard = toCell(...q(2000, 2000));
  for (const guard of [inline, worker]) {
    expect(guard(agent, Math.floor(seat[0]), Math.floor(seat[1]))).toBe(true);
    expect(guard(agent, Math.floor(hard[0]), Math.floor(hard[1]))).toBe(false);
  }
  const body = { x: 1200 / pm, y: 1200 / pm, hx: 1, hy: 0, length: 0.9, width: 1 };
  expect(terrain.blocked.hits([body])).toBe(true);
  expect(received.blocked.hits([body])).toBe(true);
  expect(received.hardBlocked.hits([body])).toBe(false);
});
