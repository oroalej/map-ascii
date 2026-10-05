import * as Comlink from 'comlink';
import { simulationSeasons } from './seasonal-simulation';
import {
  eventTime,
  type EventTiming,
  type RuntimeCityLife,
  type ProcessionRoute,
  type TrafficMix,
} from '@atlas/shared';
import type { MomentOptions } from './moments-host';
import type { FrameProfiler } from '../profile';
import { LifeWorld, type LifeTile, type ProcessionRun, type VisibleAgent } from './simulate';
import {
  configureLifeWorld,
  runLifeFrame,
  type FrameInput,
  type LifeWorkerApi,
} from './worker-api';
import { cellTerrainFrom } from './terrain-snapshot';
import { makeCellGuard } from './cell-guard';
import { spawnMargin, type LifeViewContext } from './births';
import { LifePreparation } from './preparation';
import { EMPTY_PUFFS } from './exhaust';
let nextGeneration = 0;

export type FrameView = {
  generation?: number;
  agents: VisibleAgent[];
  puffs: Float64Array;
  procession: ProcessionRun | undefined;
  signalClock: number;
  cellGuard: LifeWorld['groundCellGuard'];
};
export interface LifeHost {
  /** Drop replies produced under a previous season without resetting the population. */
  invalidateFrame(): void;
  sync(tiles: readonly LifeTile[], focus?: readonly [number, number], view?: LifeViewContext): void;
  clearTiles(): void;
  /** True when a step was accepted. Rejected requests leave dt accumulating on the caller. */
  request(input: FrameInput): boolean;
  latest(): FrameView | undefined;
  setLive(id: string | undefined, progress?: number, occurrence?: string): void;
  play(id: string, timing?: EventTiming): boolean;
  stop(): void;
  dispose(): void;
}

export function createInlineHost(
  world: LifeWorld,
  profiler?: FrameProfiler,
  preparationClock?: () => number,
): LifeHost {
  let view: FrameView | undefined;
  const preparation = new LifePreparation(world, profiler, preparationClock);
  let disposed = false;
  let acceptedPost: number | undefined;
  let generation = ++nextGeneration;
  return {
    invalidateFrame() {
      if (view) view = { ...view, agents: [] };
      acceptedPost = undefined;
    },
    sync: (tiles, focus, context) => {
      if (disposed) return;
      preparation.sync(tiles, focus, context);
      if (!tiles.length) view = undefined;
    },
    clearTiles() {
      generation = ++nextGeneration;
      world.clearTiles();
      preparation.clear();
      view = undefined;
      acceptedPost = undefined;
    },
    request(input) {
      if (disposed) return false;
      acceptedPost = profiler?.time();
      preparation.camera(
        input.step.bounds,
        spawnMargin(input.step.cellMeters ?? 0, input.gust.cssCell.h / input.gust.cssCell.w),
      );
      preparation.commit();
      const result = runLifeFrame(world, input, profiler);
      const terrain = world.cellTerrain();
      view = {
        ...result,
        generation,
        cellGuard: (toCell) =>
          terrain &&
          makeCellGuard(
            terrain.ref,
            { roads: terrain.roads, forbidden: terrain.forbidden },
            terrain.trees,
            toCell,
          ),
      };
      preparation.schedule();
      return true;
    },
    latest: () => {
      if (acceptedPost !== undefined)
        profiler!.gauge('acceptedFrameAge', profiler!.time() - acceptedPost);
      return {
        agents: [],
        puffs: EMPTY_PUFFS,
        signalClock: world.signalClock,
        cellGuard: () => undefined,
        ...view,
        procession: world.procession(),
      };
    },
    setLive: (id, progress, occurrence) => world.setLive(id, progress, occurrence),
    play: (id, timing) => world.play(id, timing),
    stop: () => world.stop(),
    dispose: () => {
      disposed = true;
      world.clearTiles();
      preparation.clear();
      view = undefined;
    },
  };
}

export function createWorkerHost(
  options: {
    traffic?: TrafficMix;
    cityLife?: RuntimeCityLife;
    itemInspection?: boolean;
    moments?: MomentOptions;
  },
  processions: readonly ProcessionRoute[],
  profiler?: FrameProfiler,
): LifeHost {
  const seasons = simulationSeasons(options.cityLife?.seasons);
  let worker: Worker;
  const inline = () => {
    const world = new LifeWorld(options.traffic, profiler, options.moments, options.itemInspection);
    configureLifeWorld(world, {
      processions,
      seasons,
      shopSchedule: options.cityLife?.schedules?.shops,
    });
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
    generation = ++nextGeneration,
    agentEpoch = 0,
    frames = 0,
    playedFrom = 0;
  let view: FrameView | undefined;
  let acceptedPost: number | undefined;
  let terrain: ReturnType<typeof cellTerrainFrom> | undefined;
  let fallback: LifeHost | undefined;
  let tiles: readonly LifeTile[] = [];
  let focus: readonly [number, number] | undefined;
  let viewContext: LifeViewContext | undefined;
  let live: { id: string | undefined; progress?: number; occurrence?: string } = { id: undefined };
  let played: string | undefined;
  let playedTiming: EventTiming | undefined;
  const sent = new Set<string>();
  const release = () => {
    remote[Comlink.releaseProxy]();
    worker.terminate();
  };
  const fail = () => {
    if (disposed || fallback) return;
    generation = ++nextGeneration;
    ready = false;
    release();
    fallback = inline();
    fallback.sync(tiles, focus, viewContext);
    fallback.setLive(live.id, live.progress, live.occurrence);
    if (played) fallback.play(played, playedTiming);
  };
  worker.addEventListener('error', fail);
  worker.addEventListener('messageerror', fail);
  // Comlink posts messages in order; init and all synchronous sync/command calls precede frames.
  void remote
    .init({
      traffic: options.traffic,
      processions,
      profiling: !!profiler,
      seasons,
      shopSchedule: options.cityLife?.schedules?.shops,
      itemInspection: options.itemInspection,
      dialogue: options.moments?.dialogue,
      periods: options.moments?.periods,
    })
    .then(() => {
      if (!disposed && !fallback) ready = true;
    }, fail);
  return {
    invalidateFrame() {
      agentEpoch++;
      acceptedPost = undefined;
      if (fallback) fallback.invalidateFrame();
      if (view) view = { ...view, agents: [] };
    },
    sync(next, nextFocus, nextView) {
      if (disposed) return;
      tiles = next;
      focus = nextFocus;
      viewContext = nextView;
      if (fallback) {
        fallback.sync(next, nextFocus, nextView);
        return;
      }
      const keep = new Set(next.map((tile) => tile.key));
      if (keep.size !== sent.size || [...keep].some((key) => !sent.has(key))) {
        if (!nextView || !keep.size) {
          generation = ++nextGeneration;
          terrain = undefined;
        }
        // Keep the last complete frame while nonempty geometry loads. It is never combined
        // with a different generation; the next valid reply replaces agents and guard together.
        if (!keep.size && view)
          view = { ...view, agents: [], puffs: EMPTY_PUFFS, cellGuard: () => undefined };
      }
      const payload = next.map(({ key, tile, life }) => {
        const entry = sent.has(key) ? { key, tile } : { key, tile, life };
        sent.add(key);
        return entry;
      });
      for (const key of sent) if (!keep.has(key)) sent.delete(key);
      // Structured clone: lamps and fixtures still own these buffers on the main thread.
      const postStart = profiler?.time();
      void remote.sync(payload, nextFocus, nextView).catch(fail);
      if (postStart !== undefined) profiler!.record('syncPost', profiler!.time() - postStart);
    },
    clearTiles() {
      if (disposed) return;
      tiles = [];
      focus = undefined;
      viewContext = undefined;
      generation = ++nextGeneration;
      acceptedPost = undefined;
      profiler?.clearContinuity();
      terrain = undefined;
      sent.clear();
      if (view) view = { ...view, agents: [], puffs: EMPTY_PUFFS, cellGuard: () => undefined };
      if (fallback) fallback.clearTiles();
      else void remote.clearTiles().catch(fail);
    },
    request(input) {
      if (disposed) return false;
      if (fallback) return fallback.request(input);
      if (!ready || inFlight) return false;
      inFlight = true;
      const requestedGeneration = generation;
      const requestedAgentEpoch = agentEpoch;
      const frame = ++frames;
      const posted = profiler?.time();
      void remote
        .frame(input)
        .then((result) => {
          if (disposed || generation !== requestedGeneration) return;
          if (result.terrain !== undefined) {
            const start = profiler?.time();
            terrain = result.terrain === null ? undefined : cellTerrainFrom(result.terrain);
            if (start !== undefined) profiler!.record('terrainSnapshot', profiler!.time() - start);
          }
          if (agentEpoch !== requestedAgentEpoch) {
            const cellTerrain = terrain;
            if (view || result.terrain !== undefined)
              view = {
                agents: [],
                puffs: EMPTY_PUFFS,
                generation,
                procession: view?.procession,
                signalClock: view?.signalClock ?? 0,
                cellGuard: (toCell) =>
                  cellTerrain &&
                  makeCellGuard(cellTerrain.ref, cellTerrain.access, cellTerrain.trees, toCell),
              };
            return;
          }
          acceptedPost = posted;
          if (posted !== undefined) profiler!.record('lifeLatency', profiler!.time() - posted);
          // Only frames posted after play() can show that its time-lapse has ended.
          const run = result.procession;
          if (played && frame > playedFrom && !(run && !run.live && run.id === played))
            played = undefined;
          const cellTerrain = terrain;
          view = {
            agents: result.agents,
            puffs: result.puffs,
            generation,
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
    latest: () => {
      if (fallback) return fallback.latest();
      if (acceptedPost !== undefined)
        profiler!.gauge('acceptedFrameAge', profiler!.time() - acceptedPost);
      return view;
    },
    setLive(id, progress, occurrence) {
      if (disposed) return;
      live = { id, progress, occurrence };
      if (fallback) fallback.setLive(id, progress, occurrence);
      else void remote.setLive(id, progress, occurrence).catch(fail);
    },
    play(id, timing) {
      if (disposed || !processions.some((route) => route.id === id)) return false;
      agentEpoch++;
      played = id;
      playedTiming = timing;
      playedFrom = frames;
      const procession: ProcessionRun = {
        id,
        progress: 0,
        live: false,
        ...(timing && { time: eventTime(timing, 0) }),
      };
      view = {
        generation,
        agents: [],
        puffs: EMPTY_PUFFS,
        signalClock: view?.signalClock ?? 0,
        cellGuard: () => undefined,
        procession,
      };
      if (fallback) return fallback.play(id, timing);
      void remote.play(id, timing).catch(fail);
      return true;
    },
    stop() {
      if (disposed) return;
      agentEpoch++;
      played = undefined;
      playedTiming = undefined;
      if (view) view = { ...view, procession: undefined, agents: [], puffs: EMPTY_PUFFS };
      if (fallback) fallback.stop();
      else void remote.stop().catch(fail);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      generation = ++nextGeneration;
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
