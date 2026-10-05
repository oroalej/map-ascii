import { describe, expect, it } from 'vitest';
import type { RuntimeSeasonConfig } from '@atlas/shared';
import { activityChanged, activityLevels, MAX_TILE_GATHERERS } from './config';
import { gathererShare } from './gatherer-share';
import { LifeBuilder } from './geometry';
import { LifeWorld, TileLife } from './simulate';
import { simulationSeasons } from './seasonal-simulation';
import { worldTiles } from './testing/scenarios';
import { complete } from './cooperate';
import { createLifeWorkerApi, runLifeFrame, type FrameInput } from './worker-api';
import { tileToLngLat } from '../raster/geometry';

const tile = { z: 16, x: 55192, y: 30266 };
const calendar: RuntimeSeasonConfig = {
  id: 'memorial',
  title: { en: 'Memorial' },
  window: { from: { month: 11, day: 1 }, to: { month: 11, day: 2 } },
  visitors: {
    label: 'Families',
    share: 1,
    per_grave_family: [2, 5],
    max_per_tile: 120,
    hours: [
      [0, 0],
      [12, 1],
      [23, 0],
    ],
  },
  congregations: {
    label: 'Mass-goers',
    landmarks: ['landmark/church'],
    extra: 60,
    hours: [
      [0, 0],
      [12, 1],
      [23, 0],
    ],
  },
};
function setup(season = calendar) {
  const b = new LifeBuilder();
  b.place({ x: 500, y: 500 }, 'worship', 70);
  b.place({ x: 2800, y: 2800 }, 'worship', 200, true, NaN, 'landmark/church');
  b.place({ x: 3500, y: 800 }, 'worship', 70, false, NaN, 'landmark/other');
  for (let i = 0; i < 20; i++) b.grave({ x: 1000 + i * 60, y: 1800 }, `grave/${i}`, i);
  const geo = b.finish();
  const tiles = [{ key: 'crowds', tile, life: geo }];
  const world = new LifeWorld();
  world.setSeasons(simulationSeasons([season]));
  world.sync(tiles);
  const life = worldTiles(world).values().next().value!;
  const select = (id: string | null = season.id) =>
    world.step(0, undefined, 19, undefined, undefined, { rain: 0, season: id });
  return { geo, tiles, life, world, select };
}
describe('seasonal crowds', () => {
  it('retains crowd-only calendars and admits visitors before selected church congregations', () => {
    const { life, select } = setup();
    select();
    const visitors = life.gatherers.filter((g) => g.seasonal === 'visitors');
    const churches = life.gatherers.filter((g) => g.seasonal === 'congregations');
    expect(visitors.length).toBeGreaterThan(1);
    expect(churches.length).toBeGreaterThan(0);
    expect(churches.every((g) => g.source === 1)).toBe(true);
    expect(life.gatherers.length).toBeLessThanOrEqual(MAX_TILE_GATHERERS);
    for (const g of visitors) {
      expect(Math.hypot(g.x - g.cx, g.y - g.cy) / life.perMeter).toBeGreaterThanOrEqual(1);
      expect(Math.hypot(g.x - g.cx, g.y - g.cy) / life.perMeter).toBeLessThanOrEqual(2.5);
      expect(g.pause).toBeGreaterThanOrEqual(40);
    }
  });
  it('does not respawn unchanged inputs and removes both groups at season end', () => {
    const { life, select, world, tiles } = setup();
    select();
    const owners = [...life.gatherers];
    select();
    world.sync(tiles);
    select();
    expect(life.gatherers).toEqual(owners);
    select(null);
    expect(life.gatherers).toEqual(owners.filter((g) => !g.seasonal));
  });
  it.each(['visitors', 'congregations'] as const)('supports %s-only calendars', (kind) => {
    const config = {
      ...calendar,
      visitors: undefined,
      congregations: undefined,
      [kind]: calendar[kind],
    };
    expect(simulationSeasons([config])).toHaveLength(1);
    const { life, select } = setup(config);
    select();
    expect(life.gatherers.some((g) => g.seasonal === kind)).toBe(true);
    expect(life.gatherers.some((g) => g.seasonal && g.seasonal !== kind)).toBe(false);
  });
  it('counts suppressed ordinary owners and refuses a partial family below its minimum', () => {
    const { life, select } = setup();
    const ordinary = life.gatherers[0]!;
    while (life.gatherers.length < 149) life.gatherers.push({ ...ordinary });
    life.reconcileSeasonalActors(
      (g) => 'place' in g,
      () => false,
      true,
    );
    select();
    expect(life.gatherers.filter((g) => g.seasonal === 'visitors')).toHaveLength(0);
    expect(life.gatherers.filter((g) => g.seasonal === 'congregations').length).toBeLessThanOrEqual(
      1,
    );
  });
  it('clears suppressed seasonal owners without discarding ordinary owners', () => {
    const { life, select } = setup();
    select();
    const ordinary = life.gatherers.filter((g) => !g.seasonal);
    life.reconcileSeasonalActors(
      (g) => 'place' in g,
      () => false,
      true,
    );
    life.clearSeasonalGatherers();
    life.reconcileSeasonalActors(
      () => false,
      () => false,
      false,
    );
    expect(life.gatherers).toEqual(ordinary);
  });
  it('clears at retirement and reconciles the current season before revival', () => {
    const { world, tiles, life, select } = setup();
    select();
    world.sync([]);
    expect(life.gatherers.every((g) => !g.seasonal)).toBe(true);
    select(null);
    world.sync(tiles);
    select(null);
    expect(worldTiles(world).values().next().value).toBe(life);
    expect(life.gatherers.every((g) => !g.seasonal)).toBe(true);
    select();
    expect(life.gatherers.some((g) => g.seasonal)).toBe(true);
  });
  it('isolates ordinary admission, movement, pauses and rejected target retries with moments enabled', () => {
    const { geo } = setup();
    const a = new TileLife(tile, geo, 1),
      b = new TileLife(tile, geo, 1);
    a.admitSeasonalGatherers(simulationSeasons([calendar])[0]!, (g) => g.x > 800);
    const ordinary = () => a.gatherers.filter((g) => !g.seasonal);
    expect(ordinary()).toEqual(b.gatherers);
    for (let i = 0; i < 240; i++) {
      for (const g of ordinary()) g.pause = 0;
      for (const g of b.gatherers) g.pause = 0;
      const guard = (g: { x: number }) => g.x < 800 || g.x > 2500;
      a.step(0.1, undefined, undefined, undefined, { rain: 0, levels: activityLevels(1) }, guard);
      b.step(0.1, undefined, undefined, undefined, { rain: 0, levels: activityLevels(1) }, guard);
    }
    expect(ordinary()).toEqual(b.gatherers);
    a.clearSeasonalGatherers();
    a.settleGround((g) => g.x < 800 || g.x > 2500);
    b.settleGround((g) => g.x < 800 || g.x > 2500);
    expect(a.gatherers).toEqual(b.gatherers);
  });
  it('uses seasonal hours with zero absent defaults while preserving ordinary attendance', () => {
    const midnight = activityLevels(1, { minutes: 0, weekday: 1 }, calendar);
    const noon = activityLevels(1, { minutes: 720, weekday: 1 }, calendar);
    expect(midnight.season).toEqual({ visitors: 0, congregations: 0 });
    expect(noon.season).toEqual({ visitors: 1, congregations: 1 });
    expect(activityChanged(midnight, noon)).toBe(true);
    expect(gathererShare({ place: 'worship', seasonal: 'visitors' })).toBe(0);
    expect(gathererShare({ place: 'worship' })).toBe(1);
    expect(gathererShare({ place: 'worship' }, noon)).toBe(noon.places.worship);
    expect(activityLevels(1).season).toBeUndefined();
  });
  it('hides zero-hour crowds without using ordinary worship attendance', () => {
    const { world, select } = setup();
    select();
    const levels = activityLevels(1, { minutes: 720, weekday: 1 }, calendar);
    const places = Object.fromEntries(
      Object.keys(levels.places).map((key) => [key, 0]),
    ) as typeof levels.places;
    expect(world.visible(20, { ...levels, places }, [0, 0]).length).toBeGreaterThan(0);
    expect(
      world.visible(20, { ...levels, places, season: { visitors: 0, congregations: 0 } }, [0, 0]),
    ).toEqual([]);
  });
  it('reconciles privately prepared tiles against the calendar at activation', () => {
    const { tiles } = setup();
    const world = new LifeWorld();
    world.setSeasons(simulationSeasons([calendar]));
    const prepared = complete(world.prepareTile(tiles[0]!));
    world.step(0, undefined, 20, undefined, undefined, { rain: 0, season: null });
    world.sync(tiles, undefined, undefined, new Map([[tiles[0]!.key, prepared]]));
    world.step(0, undefined, 20, undefined, undefined, { rain: 0, season: calendar.id });
    expect(prepared.gatherers.some((g) => g.seasonal)).toBe(true);
    const owners = [...prepared.gatherers];
    world.step(0, undefined, 20, undefined, undefined, { rain: 0, season: calendar.id });
    expect(prepared.gatherers).toEqual(owners);
  });
  it('matches inline and worker admission, hours, season exit and tile revival', () => {
    const { tiles, world } = setup();
    const api = createLifeWorkerApi();
    api.init({ processions: [], seasons: simulationSeasons([calendar]) });
    api.sync(structuredClone(tiles));
    const center = tileToLngLat(tile, { x: 2048, y: 2048 });
    for (let frame = 0; frame < 8; frame++) {
      if (frame === 4) {
        world.sync([]);
        api.sync([]);
      }
      if (frame === 5) {
        world.sync(tiles);
        api.sync(structuredClone(tiles));
      }
      const input: FrameInput = {
        gust: {
          camera: { lng: center[0], lat: center[1], zoom: 20 },
          size: { width: 1920, height: 1080 },
          cssCell: { w: 5, h: 9 },
          time: frame / 30,
          wind: { dir: [1, 0], strength: 0 },
        },
        step: {
          dt: 0,
          zoom: 20,
          bounds: undefined,
          wind: undefined,
          weather: { rain: 0, season: frame === 3 || frame === 4 ? null : calendar.id },
          cellMeters: 0,
        },
        visible: [
          20,
          activityLevels(1, { minutes: 720, weekday: 1 }, calendar),
          center,
          { rain: 0, sunAltitude: 45 },
        ],
      };
      expect(api.frame(structuredClone(input)).agents).toEqual(runLifeFrame(world, input).agents);
    }
    api.clearTiles();
  });
});
