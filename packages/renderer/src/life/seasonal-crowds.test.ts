import { describe, expect, it, vi } from 'vitest';
import type { RuntimeSeasonConfig } from '@atlas/shared';
import {
  activityChanged,
  activityLevels,
  MAX_TILE_GATHERERS,
  PLACES,
  type Activity,
} from './config';
import { gathererShare } from './gatherer-share';
import { LifeBuilder, LifeLine } from './geometry';
import { LifeWorld, TileLife, type Gatherer } from './simulate';
import { MomentHost } from './moments-host';
import { SceneSpeechHost } from './scene-speech-host';
import { bodyHitsPolygon, bodiesOverlap } from './occupancy';
import { transformPolygon } from './terrain';
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

const zeroHours: Activity = { ...activityLevels(1), season: { visitors: 0, congregations: 0 } };
const fullHours: Activity = { ...zeroHours, season: { visitors: 1, congregations: 1 } };
function soloCrowdFixture(withSeasonal = true) {
  const builder = new LifeBuilder();
  builder.place({ x: 1000, y: 1000 }, 'worship', 50);
  const life = new TileLife(tile, builder.finish(), 1);
  const ordinary: Gatherer = { ...life.gatherers[0]!, x: 1000, y: 1000, rank: 0, pause: 0 };
  life.gatherers.splice(0, life.gatherers.length, ordinary);
  life.movers.length = life.stalls.length = life.parked.length = 0;
  if (withSeasonal) {
    // Enter the real crowd lifecycle before positioning its tagged owner for consumer checks.
    life.admitSeasonalGatherers(simulationSeasons([calendar])[0]!, () => false);
    life.gatherers.push({ ...ordinary, seasonal: 'visitors', x: 1200 });
  }
  return { builder, life, ordinary };
}

describe('seasonal crowds', () => {
  it('marks empty arrivals applied without constructing a crowd guard or attempting admission', () => {
    const { world, tiles, select } = setup({ ...calendar, congregations: undefined });
    select();
    const empty = {
      key: 'empty',
      tile: { ...tile, x: tile.x + 1 },
      life: new LifeBuilder().finish(),
    };
    world.sync([...tiles, empty]);
    const consumers = world as unknown as { groundGuard: (...args: unknown[]) => unknown };
    const guard = vi.spyOn(consumers, 'groundGuard');
    const admit = vi.spyOn(world.active('empty')!, 'admitSeasonalGatherers');
    select();
    select();
    expect(admit).not.toHaveBeenCalled();
    expect(guard.mock.calls.filter((args) => args[3] === true)).toEqual([]);
  });
  it('shares one all-body admission guard for visitors and cemetery stalls without overlapping them', () => {
    const b = new LifeBuilder();
    b.grave({ x: 1000, y: 1800 }, 'grave', 1);
    b.cemetery({ x: 2000, y: 2000 }, 100);
    for (const y of [800, 1600, 2400, 3200])
      b.line(
        [
          { x: 0, y },
          { x: 4095, y },
        ],
        LifeLine.path,
        8,
      );
    const world = new LifeWorld();
    world.setSeasons(
      simulationSeasons([
        {
          ...calendar,
          congregations: undefined,
          stalls: { label: 'Stalls', near: ['cemetery'], radius_m: 80, per_tile: 12 },
        },
      ]),
    );
    world.sync([{ key: 'combined', tile, life: b.finish() }]);
    const consumers = world as unknown as { groundGuard: (...args: unknown[]) => unknown };
    const guard = vi.spyOn(consumers, 'groundGuard');
    world.step(0, undefined, 19, undefined, undefined, { rain: 0, season: calendar.id });
    const life = world.active('combined')!;
    const visitors = life.gatherers.filter((g) => g.seasonal === 'visitors');
    expect(visitors.length).toBeGreaterThan(0);
    expect(life.seasonalStalls.length).toBeGreaterThan(0);
    expect(guard.mock.calls.filter((args) => args[3] === true)).toHaveLength(1);
    for (const visitor of visitors)
      for (const stall of life.seasonalStalls)
        for (const person of life.groundBodies(visitor))
          for (const cart of life.groundBodies(stall))
            expect(bodiesOverlap(person, cart)).toBe(false);
  });
  it('removes zero-hour crowds from standalone occupancy and bird disturbance with visible controls', () => {
    const { life, ordinary } = soloCrowdFixture();
    const tagged = life.gatherers[1]!;
    life.gatherers.splice(0, 1);
    const consumers = life as unknown as {
      standalonePedestrians: (
        shows?: unknown,
        near?: unknown,
        env?: { rain: number; levels: Activity },
      ) => { empty: boolean };
      disturbed: (flock: { species: 'maya'; x: number; y: number }, levels: Activity) => boolean;
    };
    expect(
      consumers.standalonePedestrians(undefined, undefined, { rain: 0, levels: zeroHours }).empty,
    ).toBe(true);
    expect(
      consumers.standalonePedestrians(undefined, undefined, { rain: 0, levels: fullHours }).empty,
    ).toBe(false);
    const flock = { species: 'maya' as const, x: tagged.x, y: tagged.y };
    expect(consumers.disturbed(flock, zeroHours)).toBe(false);
    expect(consumers.disturbed(flock, fullHours)).toBe(true);
    life.gatherers.splice(0, 1, { ...ordinary, x: tagged.x });
    expect(consumers.disturbed(flock, zeroHours)).toBe(true);
    expect(
      consumers.standalonePedestrians(undefined, undefined, { rain: 0, levels: zeroHours }).empty,
    ).toBe(false);
  });
  it('removes zero-hour crowds from world occupancy while retaining active hours and allBodies', () => {
    const { builder } = soloCrowdFixture(false);
    const world = new LifeWorld();
    world.sync([{ key: 'occupancy', tile, life: builder.finish() }]);
    const life = world.active('occupancy')!;
    const consumers = world as unknown as {
      groundGuard: (
        minimum?: number,
        fresh?: unknown,
        bounds?: unknown,
        allBodies?: boolean,
        region?: unknown,
        admitEvents?: boolean,
        eventBounds?: unknown,
        shows?: (kind: string) => boolean,
      ) => unknown;
    };
    consumers.groundGuard();
    const tagged: Gatherer = {
      ...life.gatherers[0]!,
      seasonal: 'visitors',
      rank: 0,
      x: 1000,
      y: 1000,
      pause: 0,
    };
    life.gatherers.splice(0, life.gatherers.length, tagged);
    const bodies = vi.spyOn(life, 'groundBodies');
    world.visible(20, zeroHours, [0, 0]);
    consumers.groundGuard();
    expect(bodies).not.toHaveBeenCalled();
    consumers.groundGuard(0, undefined, undefined, true);
    expect(bodies).toHaveBeenCalledOnce();
    bodies.mockClear();
    world.visible(20, fullHours, [0, 0]);
    consumers.groundGuard();
    expect(bodies).toHaveBeenCalledOnce();
    bodies.mockClear();
    consumers.groundGuard(0, undefined, undefined, false, undefined, false, undefined, () => false);
    expect(bodies).not.toHaveBeenCalled();
    consumers.groundGuard(0, undefined, undefined, true, undefined, false, undefined, () => false);
    expect(bodies).toHaveBeenCalledOnce();
    delete tagged.seasonal;
    bodies.mockClear();
    world.visible(20, zeroHours, [0, 0]);
    consumers.groundGuard();
    expect(bodies).toHaveBeenCalledOnce();
  });
  it.each([zeroHours, fullHours])(
    'excludes seasonal owners from moment candidates and speech scan counts at %j',
    (levels) => {
      const a = soloCrowdFixture(),
        b = soloCrowdFixture(false);
      const hostA = new MomentHost(a.life, 1),
        hostB = new MomentHost(b.life, 1);
      const step = vi.spyOn(hostA.moments, 'step');
      for (let i = 0; i < 10; i++) {
        const env = { rain: 0, levels, clock: i / 10 };
        hostA.step(0.1, 21, env, undefined, undefined, 0.2, 1.8);
        hostB.step(0.1, 21, env, undefined, undefined, 0.2, 1.8);
      }
      const context = step.mock.calls.at(-1)![1];
      expect(context.actors().map((actor) => actor.owner)).toEqual([a.ordinary]);
      expect(hostA.moments.stats).toEqual(hostB.moments.stats);
      const choice = {
        id: 'daily',
        kind: 'talk' as const,
        profile: 'daily-plans' as const,
        delivery: 'utterance' as const,
        turns: 1,
        speakers: [0],
      };
      const speechA = new SceneSpeechHost(a.life, 1, { dialogue: [choice] });
      const speechB = new SceneSpeechHost(b.life, 1, { dialogue: [choice] });
      const attemptA = vi
        .spyOn(speechA.speech.selector.memory, 'ambientAttempt')
        .mockReturnValue(false);
      const attemptB = vi
        .spyOn(speechB.speech.selector.memory, 'ambientAttempt')
        .mockReturnValue(false);
      for (let i = 0; i < 10; i++) {
        const env = { rain: 0, levels, clock: i / 10 };
        speechA.step(0.1, 21, env, undefined, []);
        speechB.step(0.1, 21, env, undefined, []);
      }
      expect(attemptA.mock.calls.length).toBeGreaterThan(0);
      expect(attemptA.mock.calls.length).toBe(attemptB.mock.calls.length);
      expect(attemptA.mock.calls.every(([owner]) => owner === a.ordinary)).toBe(true);
    },
  );
  it('binds the visitor ceiling with complete families clear of actual burial footprints', () => {
    const build = (cap: number) => {
      const builder = new LifeBuilder();
      for (let i = 0; i < 20; i++) {
        const x = 1000 + i * 60;
        builder.grave({ x, y: 1800 }, `grave/${i}`, i);
        if (i < 5)
          builder.area('blocked', [
            [
              { x: x - 15, y: 1785 },
              { x: x + 15, y: 1785 },
              { x: x + 15, y: 1815 },
              { x: x - 15, y: 1815 },
              { x: x - 15, y: 1785 },
            ],
          ]);
      }
      const geo = builder.finish(),
        world = new LifeWorld();
      world.setSeasons(
        simulationSeasons([
          {
            ...calendar,
            congregations: undefined,
            visitors: { ...calendar.visitors!, max_per_tile: cap },
          },
        ]),
      );
      world.sync([{ key: 'blocked-graves', tile, life: geo }]);
      world.step(0, undefined, 19, undefined, undefined, { rain: 0, season: calendar.id });
      const life = world.active('blocked-graves')!;
      return { life, geo, owners: life.gatherers.filter((g) => g.seasonal === 'visitors') };
    };
    const low = build(7),
      control = build(120);
    expect(low.owners.length).toBeGreaterThanOrEqual(2);
    expect(low.owners.length).toBeLessThanOrEqual(7);
    expect(control.owners.length).toBeGreaterThan(7);
    const families = new Map<string, number>();
    for (const g of low.owners) {
      const key = `${g.cx}/${g.cy}`;
      families.set(key, (families.get(key) ?? 0) + 1);
      for (const area of low.geo.areas ?? []) {
        const polygon = transformPolygon(area.rings, 0, 0, 1 / low.life.perMeter);
        expect(low.life.groundBodies(g).some((body) => bodyHitsPolygon(body, polygon))).toBe(false);
      }
    }
    expect([...families.values()].every((size) => size >= 2 && size <= 5)).toBe(true);
  });
  it('retains crowd-only calendars and admits visitors before selected church congregations', () => {
    const { life, select } = setup();
    select();
    const visitors = life.gatherers.filter((g) => g.seasonal === 'visitors');
    const churches = life.gatherers.filter((g) => g.seasonal === 'congregations');
    expect(visitors.length).toBeGreaterThan(1);
    expect(churches.length).toBeGreaterThan(0);
    expect(churches.every((g) => g.source === 1)).toBe(true);
    expect(churches.every((g) => (g.outer - g.inner) / life.perMeter > PLACES.worship.wander)).toBe(
      true,
    );
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
