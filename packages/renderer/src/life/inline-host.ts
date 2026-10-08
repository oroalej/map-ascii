import { LifeWorld } from './simulate';
import { configureLifeWorld, runLifeFrame } from './worker-api';
import { simulationSeasons } from './seasonal-simulation';
import { runtimeFolklore } from './folklore-config';
import { makeCellGuard } from './cell-guard';
import { spawnMargin } from './births';
import { LifePreparation } from './preparation';
import { EMPTY_PUFFS } from './exhaust';
import { EMPTY_FOLKLORE } from './folklore';
import { isEmergencyCraft } from './emergency';
import type { FrameProfiler } from '../profile';
import {
  allocateLifeGeneration,
  retainOrdinary,
  type FrameView,
  type LifeHost,
  type LifeHostOptions,
} from './host';
import type { ProcessionRoute } from '@atlas/shared';

export function createConfiguredInlineHost(
  options: LifeHostOptions,
  processions: readonly ProcessionRoute[],
  profiler?: FrameProfiler,
): LifeHost {
  const world = new LifeWorld(
    options.traffic,
    profiler,
    options.moments,
    options.itemInspection,
    options.emojiObserver,
  );
  configureLifeWorld(world, {
    processions,
    seasons: simulationSeasons(options.cityLife?.seasons),
    shopSchedule: options.cityLife?.schedules?.shops,
    peddlers: options.cityLife?.peddlers,
    folklore: runtimeFolklore(options.cityLife),
    emergencyConfig: options.cityLife?.emergency,
    emergency: options.emergency,
  });
  return createInlineHost(world, profiler);
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
  let generation = allocateLifeGeneration();
  let liveIdentity: { id?: string; occurrence?: string } = {};
  return {
    invalidateFrame() {
      if (view) view = { ...view, agents: [], throngRun: undefined, folklore: EMPTY_FOLKLORE };
      acceptedPost = undefined;
    },
    invalidateFolklore() {
      if (view) view = { ...view, folklore: EMPTY_FOLKLORE };
    },
    sync: (tiles, focus, context) => {
      if (disposed) return;
      preparation.sync(tiles, focus, context);
      if (!tiles.length) view = undefined;
    },
    clearTiles() {
      generation = allocateLifeGeneration();
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
        throngRun: result.procession,
        cellGuard: (toCell, terrainOnly) =>
          terrain &&
          makeCellGuard(
            terrain.ref,
            { roads: terrain.roads, forbidden: terrain.forbidden },
            terrain.trees,
            toCell,
            terrain.events,
            terrain.blocked,
            terrain.hardBlocked,
            terrainOnly,
          ),
      };
      preparation.schedule();
      return true;
    },
    latest: () => {
      if (acceptedPost !== undefined)
        profiler!.gauge('acceptedFrameAge', profiler!.time() - acceptedPost);
      return {
        folklore: EMPTY_FOLKLORE,
        agents: [],
        puffs: EMPTY_PUFFS,
        signalClock: world.signalClock,
        cellGuard: () => undefined,
        ...view,
        procession: world.procession(),
      };
    },
    setProcessions(routes) {
      if (disposed) return;
      world.setProcessions(routes);
      view = retainOrdinary(view);
      acceptedPost = undefined;
    },
    setEmergency(data) {
      if (disposed) return;
      world.setEmergency(data);
      if (view)
        view = {
          ...view,
          agents: view.agents.filter((agent) => !isEmergencyCraft(agent.vehicle)),
          puffs: EMPTY_PUFFS,
        };
      acceptedPost = undefined;
    },
    setLive: (id, progress, occurrence) => {
      const previous = world.procession();
      const occurrenceChanged = liveIdentity.id !== id || liveIdentity.occurrence !== occurrence;
      liveIdentity = { id, occurrence };
      world.setLive(id, progress, occurrence);
      const next = world.procession();
      if (
        previous?.id !== next?.id ||
        previous?.live !== next?.live ||
        (next?.live && occurrenceChanged)
      ) {
        view = retainOrdinary(view, world.processionRoute(next?.id));
        acceptedPost = undefined;
      }
    },
    play: (id, timing) => {
      if (!world.play(id, timing)) return false;
      view = retainOrdinary(view, world.processionRoute(id));
      return true;
    },
    stop: () => {
      world.stop();
      view = retainOrdinary(view, world.processionRoute(world.procession()?.id));
    },
    dispose: () => {
      disposed = true;
      world.clearTiles();
      preparation.clear();
      view = undefined;
    },
  };
}
