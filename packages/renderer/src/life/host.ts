import * as Comlink from 'comlink';
import type { ProcessionRoute, TrafficMix } from '@atlas/shared';
import type { MomentOptions } from './moments-host';
import type { FrameProfiler } from '../profile';
import { LifeWorld, type LifeTile, type ProcessionRun, type VisibleAgent } from './simulate';
import { runLifeFrame, type FrameInput, type LifeWorkerApi } from './worker-api';
import { cellTerrainFrom } from './terrain-snapshot';
import { makeCellGuard } from './cell-guard';

export type FrameView = {
  agents: VisibleAgent[];
  procession: ProcessionRun | undefined;
  signalClock: number;
  cellGuard: LifeWorld['groundCellGuard'];
};
export interface LifeHost {
  sync(tiles: readonly LifeTile[]): void;
  /** True when a step was accepted. Rejected requests leave dt accumulating on the caller. */
  request(input: FrameInput): boolean;
  latest(): FrameView | undefined;
  setLive(id: string | undefined, progress?: number): void;
  play(id: string): boolean;
  stop(): void;
  dispose(): void;
}

export function createInlineHost(world: LifeWorld, profiler?: FrameProfiler): LifeHost {
  let agents: VisibleAgent[] = [];
  return {
    sync: (tiles) => {
      world.sync(tiles);
      if (!tiles.length) agents = [];
    },
    request(input) {
      agents = runLifeFrame(world, input, profiler).agents;
      return true;
    },
    latest: () => ({
      agents,
      procession: world.procession(),
      signalClock: world.signalClock,
      cellGuard: (toCell) => world.groundCellGuard(toCell),
    }),
    setLive: (id, progress) => world.setLive(id, progress),
    play: (id) => world.play(id),
    stop: () => world.stop(),
    dispose: () => world.sync([]),
  };
}

export function createWorkerHost(
  options: { traffic?: TrafficMix; moments?: MomentOptions },
  processions: readonly ProcessionRoute[],
  profiler?: FrameProfiler,
): LifeHost {
  let worker: Worker;
  const inline = () => {
    const world = new LifeWorld(options.traffic, profiler, options.moments);
    world.setProcessions(processions);
    return createInlineHost(world, profiler);
  };
  try {
    worker = new Worker(new URL('./life.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return inline();
  }
  const remote = Comlink.wrap<LifeWorkerApi>(worker);
  let ready = false,
    inFlight = false,
    disposed = false,
    generation = 0,
    frames = 0,
    playedFrom = 0;
  let view: FrameView | undefined;
  let terrain: ReturnType<typeof cellTerrainFrom> | undefined;
  let fallback: LifeHost | undefined;
  let tiles: readonly LifeTile[] = [];
  let live: { id: string | undefined; progress?: number } = { id: undefined };
  let played: string | undefined;
  const sent = new Set<string>();
  const release = () => {
    remote[Comlink.releaseProxy]();
    worker.terminate();
  };
  const fail = () => {
    if (disposed || fallback) return;
    generation++;
    ready = false;
    release();
    fallback = inline();
    fallback.sync(tiles);
    fallback.setLive(live.id, live.progress);
    if (played) fallback.play(played);
  };
  worker.addEventListener('error', fail);
  worker.addEventListener('messageerror', fail);
  // Comlink posts messages in order; init and all synchronous sync/command calls precede frames.
  void remote
    .init({
      traffic: options.traffic,
      processions,
      profiling: !!profiler,
      dialogue: options.moments?.dialogue,
      periods: options.moments?.periods,
    })
    .then(() => {
      if (!disposed && !fallback) ready = true;
    }, fail);
  return {
    sync(next) {
      if (disposed) return;
      tiles = next;
      if (fallback) {
        fallback.sync(next);
        return;
      }
      if (!next.length) {
        generation++;
        terrain = undefined;
        if (view) view = { ...view, agents: [], cellGuard: () => undefined };
      }
      const keep = new Set(next.map((tile) => tile.key));
      const payload = next.map(({ key, tile, life }) => {
        const entry = sent.has(key) ? { key, tile } : { key, tile, life };
        sent.add(key);
        return entry;
      });
      for (const key of sent) if (!keep.has(key)) sent.delete(key);
      // Structured clone: lamps and fixtures still own these buffers on the main thread.
      const postStart = profiler?.time();
      void remote.sync(payload).catch(fail);
      if (postStart !== undefined) profiler!.record('syncPost', profiler!.time() - postStart);
    },
    request(input) {
      if (disposed) return false;
      if (fallback) return fallback.request(input);
      if (!ready || inFlight) return false;
      inFlight = true;
      const requestedGeneration = generation;
      const frame = ++frames;
      const posted = profiler?.time();
      void remote
        .frame(input)
        .then((result) => {
          if (disposed || generation !== requestedGeneration) return;
          if (posted !== undefined) profiler!.record('lifeLatency', profiler!.time() - posted);
          // Only frames posted after play() can show that its time-lapse has ended.
          const run = result.procession;
          if (played && frame > playedFrom && !(run && !run.live && run.id === played))
            played = undefined;
          if (result.terrain !== undefined) {
            const start = profiler?.time();
            terrain = result.terrain === null ? undefined : cellTerrainFrom(result.terrain);
            if (start !== undefined) profiler!.record('terrainSnapshot', profiler!.time() - start);
          }
          const cellTerrain = terrain;
          view = {
            agents: result.agents,
            procession: result.procession,
            signalClock: result.signalClock,
            cellGuard: (toCell) =>
              cellTerrain &&
              makeCellGuard(cellTerrain.ref, cellTerrain.access, cellTerrain.trees, toCell),
          };
          if (result.profile) profiler?.merge(result.profile);
        })
        .catch(fail)
        .finally(() => {
          inFlight = false;
        });
      return true;
    },
    latest: () => (fallback ? fallback.latest() : view),
    setLive(id, progress) {
      if (disposed) return;
      live = { id, progress };
      if (fallback) fallback.setLive(id, progress);
      else void remote.setLive(id, progress).catch(fail);
    },
    play(id) {
      if (disposed || !processions.some((route) => route.id === id)) return false;
      played = id;
      playedFrom = frames;
      if (fallback) return fallback.play(id);
      void remote.play(id).catch(fail);
      return true;
    },
    stop() {
      if (disposed) return;
      played = undefined;
      if (fallback) fallback.stop();
      else void remote.stop().catch(fail);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      generation++;
      worker.removeEventListener('error', fail);
      worker.removeEventListener('messageerror', fail);
      if (fallback) fallback.dispose();
      else release();
      view = undefined;
      terrain = undefined;
      tiles = [];
      sent.clear();
    },
  };
}
