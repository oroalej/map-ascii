import { describe, expect, it, vi } from 'vitest';
import { LifePreparation, PREPARATION } from './preparation';
import { complete } from './cooperate';
import { LifeWorld, TileLife, hashString } from './simulate';
import { scenarioTiles, scenarioState, worldTiles } from './testing/scenarios';
import { continuityTile, continuityMover, left, parent, right } from './testing/continuity';
import { tileToLngLat } from '../raster/geometry';
import type { LifeViewContext } from './births';
import { activityLevels } from './config';
import { FrameProfiler } from '../profile';
import { LifeBuilder, LifeLine } from './geometry';
import { prepareForageTerrain, prepareForageTerrainSteps } from './forage';

const context = (tile = left): LifeViewContext => {
  const [west, north] = tileToLngLat(tile, { x: 0, y: 0 });
  const [east, south] = tileToLngLat(tile, { x: 4096, y: 4096 });
  return { bounds: [west, south, east, north], spawnMarginM: 12 };
};
const finish = (jobs: LifePreparation) => {
  for (let i = 0; i < 20000; i++) {
    jobs.slice();
    jobs.commit();
    const state = jobs.stats();
    if (!state.running && !state.queued && !state.ready) return;
  }
  throw new Error('Preparation did not finish');
};

describe('cooperative life preparation', () => {
  it('uses a separate shared-clearance cache without copying buildings into world forage terrain', () => {
    const builder = new LifeBuilder();
    builder.roost({ x: 2000, y: 2000 });
    builder.area('blocked', [
      [
        { x: 2100, y: 2100 },
        { x: 2200, y: 2100 },
        { x: 2200, y: 2200 },
        { x: 2100, y: 2200 },
        { x: 2100, y: 2100 },
      ],
    ]);
    const entry = { key: 'forage-cache', tile: left, life: builder.finish() };
    const world = new LifeWorld();
    const prepared = complete(world.prepareTile(entry));
    const cached = prepareForageTerrainSteps(entry.life, prepared.perMeter, 'world').next();
    expect(cached.done).toBe(true);
    const shared = prepareForageTerrain(entry.life, prepared.perMeter, 'world');
    expect(shared.blocked.polygons).toHaveLength(0);
    const local = prepareForageTerrain(entry.life, prepared.perMeter);
    expect(local).not.toBe(shared);
    expect(local.blocked.polygons).toHaveLength(1);
    expect(prepareForageTerrain(entry.life, prepared.perMeter, 'world')).toBe(shared);
  });
  it('preserves complete generation and future RNG behavior across arbitrary yields', () => {
    for (const kind of ['crossroads', 'rain', 'sparse', 'transit'] as const) {
      const entry = scenarioTiles(kind, 1)[0]!;
      const eager = new TileLife(entry.tile, structuredClone(entry.life), hashString(entry.key));
      const staged = new TileLife(
        entry.tile,
        structuredClone(entry.life),
        hashString(entry.key),
        undefined,
        true,
      );
      const work = staged.prepare();
      let turns = 0;
      while (!work.next().done) turns++;
      expect(turns).toBeGreaterThan(10);
      const a = new LifeWorld(),
        b = new LifeWorld();
      a.sync([entry], undefined, undefined, new Map([[entry.key, eager]]));
      b.sync([entry], undefined, undefined, new Map([[entry.key, staged]]));
      for (let frame = 0; frame < 10; frame++) {
        a.step(1 / 30);
        b.step(1 / 30);
      }
      expect(scenarioState(b)).toEqual(scenarioState(a));
    }
  });

  it('bounds jobs, cancels obsolete work and preserves camera-only progress', () => {
    const world = new LifeWorld();
    let clock = 0;
    const jobs = new LifePreparation(world, undefined, () => clock++);
    const entries = scenarioTiles('crossroads', 25);
    jobs.sync(entries, undefined, context());
    expect(jobs.stats().queued).toBe(PREPARATION.queued);
    jobs.slice();
    expect(jobs.stats().running).toBe(true);
    jobs.sync(entries, [0, 0], context(right));
    expect(jobs.stats().running).toBe(true);
    jobs.sync([], undefined, context());
    expect(jobs.stats()).toEqual({ queued: 0, running: false, ready: 0 });
    jobs.sync(entries, undefined, context());
    jobs.slice();
    world.setTraffic({ road_major: { car: 1 } });
    jobs.slice();
    jobs.commit();
    expect(jobs.stats()).toEqual({ queued: 0, running: false, ready: 0 });
    expect(worldTiles(world).size).toBe(0);
  });

  it('commits individual ready tiles, retaining parent ownership until its children are ready', () => {
    const world = new LifeWorld();
    const old = continuityTile(parent);
    world.sync([old], undefined, context(parent));
    const owner = worldTiles(world).get(old.key)!;
    const child = continuityTile(left);
    const jobs = new LifePreparation(world, undefined, () => 0);
    jobs.sync([child], undefined, context());
    jobs.commit();
    expect(worldTiles(world).get(old.key)).toBe(owner);
    jobs.slice();
    expect(worldTiles(world).has(child.key)).toBe(false);
    jobs.commit();
    expect(worldTiles(world).has(child.key)).toBe(true);
    expect(worldTiles(world).has(old.key)).toBe(false);
    // Revival prepares the shared guard while preserving the frozen population.
    jobs.sync([old], undefined, context(parent));
    finish(jobs);
    expect(worldTiles(world).get(old.key) === owner).toBe(true);
    expect(jobs.stats().queued).toBe(0);
  });

  it('publishes the first visible tile promptly, then bounds ready batches independently of the desired set', () => {
    const world = new LifeWorld();
    const jobs = new LifePreparation(world, undefined, () => 0);
    const entries = [
      continuityTile(right),
      continuityTile(left),
      ...scenarioTiles('crossroads', 10),
    ];
    jobs.sync(entries, undefined, context());
    jobs.slice();
    expect(jobs.stats().ready).toBe(1);
    expect(worldTiles(world).size).toBe(0);
    jobs.commit();
    expect([...worldTiles(world).keys()][0]).toBe(continuityTile(left).key);
    expect(worldTiles(world).size).toBe(1);
    jobs.slice();
    expect(jobs.stats().ready).toBe(PREPARATION.ready);
    jobs.commit();
    expect(worldTiles(world).size).toBe(1 + PREPARATION.ready);
    finish(jobs);
    expect(worldTiles(world).size).toBe(entries.length);
    const resident = worldTiles(world).get(entries[0]!.key);
    jobs.sync(entries, undefined, context(right));
    finish(jobs);
    expect(worldTiles(world).get(entries[0]!.key)).toBe(resident);
    jobs.clear();
    expect(jobs.stats()).toEqual({ queued: 0, running: false, ready: 0 });
  });

  it('finishes private preparation between slow display frames without activating or advancing Life', async () => {
    vi.useFakeTimers();
    const world = new LifeWorld();
    const jobs = new LifePreparation(world, undefined, () => 0);
    try {
      jobs.sync([continuityTile(left)], undefined, context());
      jobs.schedule();
      await vi.runAllTimersAsync();
      expect(worldTiles(world).size).toBe(0);
      expect(world.signalClock).toBe(0);
      expect(jobs.stats().ready).toBe(1);
      jobs.commit();
      expect(worldTiles(world).size).toBe(1);
      jobs.sync([continuityTile(right)], undefined, context(right));
      jobs.schedule();
      jobs.clear();
      await vi.runAllTimersAsync();
      expect(worldTiles(world).size).toBe(1);
      expect(jobs.stats()).toEqual({ queued: 0, ready: 0, running: false });
    } finally {
      jobs.clear();
      vi.useRealTimers();
    }
  });

  it('yields inside long geometry rather than only between tiles', () => {
    const entry = continuityTile(left);
    const count = 5000;
    entry.life.coords = Float32Array.from({ length: count * 2 }, (_, i) => (i % 2 ? 2000 : i / 2));
    entry.life.starts = new Uint32Array([0, count]);
    const work = new LifeWorld().prepareTile(entry);
    let slices = 0;
    const tile = complete(
      (function* () {
        let next;
        while (!(next = work.next()).done) {
          slices++;
          yield;
        }
        return next.value;
      })(),
    );
    expect(slices).toBeGreaterThan(count / 128);
    expect(tile.geo).toBe(entry.life);
  });

  it('follows one original traveler through delayed children, a seam, retirement and zoom reversal', () => {
    const profiler = new FrameProfiler(),
      world = new LifeWorld({ road_major: { car: 1 } }, profiler);
    const coarse = continuityTile(parent),
      a = continuityTile(left),
      b = continuityTile(right);
    world.sync([coarse], undefined, context(parent));
    const owner = worldTiles(world).get(coarse.key)!;
    owner.movers.splice(0);
    const traveler = continuityMover(owner, 2047);
    owner.movers.push(traveler);
    profiler.registerPopulation(coarse.key, [traveler]);
    const id = profiler.identity(traveler);
    const jobs = new LifePreparation(world, profiler, () => 0);
    jobs.sync([a, b], undefined, context());
    jobs.commit();
    expect(owner.movers.includes(traveler)).toBe(true);
    jobs.slice();
    jobs.commit();
    expect(profiler.identity(traveler)).toBe(id);
    for (let frame = 0; frame < 30; frame++) {
      world.visible(18, activityLevels(1), [123, 13]);
      world.step(0.1);
      expect(
        [...worldTiles(world).values()].filter((life) => life.movers.includes(traveler)),
      ).toHaveLength(1);
    }
    expect(worldTiles(world).get(b.key)!.movers.includes(traveler)).toBe(true);
    jobs.sync([coarse], undefined, context(parent));
    finish(jobs);
    expect(worldTiles(world).get(coarse.key)!.movers.includes(traveler)).toBe(true);
    expect(profiler.identity(traveler)).toBe(id);
    expect(traveler.routing?.turns).toBe(7);
    const x = traveler.x;
    world.step(0.1);
    expect(traveler.x).toBeGreaterThan(x);
  });
});

it('regenerates partially admitted commerce after the activation set changes', () => {
  const entry = continuityTile(left, LifeLine.path);
  entry.life.commerce = new Float32Array([500, 2000, 1500, 2000, 2500, 2000, 3500, 2000]);
  const other = continuityTile({ ...left, x: left.x + 5 });
  const world = new LifeWorld();
  const bootstrap = continuityTile({ ...left, x: left.x + 10 });
  world.sync([bootstrap], undefined, context());
  let clock = 0,
    interrupted: TileLife | undefined;
  const jobs = new LifePreparation(world, undefined, () => clock++);
  // The wrapper explicitly supplies the original method receiver below.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const original = TileLife.prototype.admitCommerceSteps;
  const spy = vi.spyOn(TileLife.prototype, 'admitCommerceSteps').mockImplementation(function* (
    this: TileLife,
    guard,
  ) {
    const work = original.call(this, guard);
    const first = work.next();
    if (!first.done) {
      // Keep the exact private instance to verify it is discarded on cancellation.
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      interrupted = this;
      yield;
    }
    yield* work;
  });
  try {
    jobs.sync([entry, other], undefined, context());
    for (let i = 0; i < 10000 && !interrupted; i++) jobs.slice();
    expect(interrupted).toBeDefined();
    jobs.sync([entry], undefined, context());
    spy.mockRestore();
    finish(jobs);
    const actual = worldTiles(world).get(entry.key)!;
    expect(actual).not.toBe(interrupted);
    const control = new LifeWorld();
    control.sync([bootstrap], undefined, context());
    control.sync([entry], undefined, context());
    const expected = worldTiles(control).get(entry.key)!;
    expect(actual.stalls).toEqual(expected.stalls);
    expect(actual.movers).toEqual(expected.movers);
    expect(actual.stalls.length).toBeGreaterThan(0);
    const cache = (world as unknown as { preparedTerrain: WeakMap<TileLife, unknown> })
      .preparedTerrain;
    expect(cache.has(actual)).toBe(false);
  } finally {
    spy.mockRestore();
    jobs.clear();
  }
});

it('yields while building dense occupancy without publishing a partial guard', () => {
  const world = new LifeWorld(),
    entry = continuityTile(left);
  world.sync([entry]);
  const life = worldTiles(world).get(entry.key)!;
  life.movers.splice(
    0,
    life.movers.length,
    ...Array.from({ length: 600 }, (_, i) => continuityMover(life, 100 + i * 5)),
  );
  const internal = world as unknown as { groundGuardSteps(): Generator<void, unknown, void> };
  const work = internal.groundGuardSteps();
  let yields = 0,
    result = work.next();
  while (!result.done) {
    expect(result.value).toBeUndefined();
    yields++;
    result = work.next();
  }
  expect(yields).toBeGreaterThanOrEqual(600 / 32 - 1);
  expect(typeof result.value).toBe('function');
});
