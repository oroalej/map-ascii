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
