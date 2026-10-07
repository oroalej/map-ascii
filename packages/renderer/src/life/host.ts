import * as Comlink from 'comlink';
import { simulationSeasons } from './seasonal-simulation';
import {
  eventTime,
  localMetricProjection,
  type EventTiming,
  type RuntimeCityLife,
  type ProcessionRoute,
  type TrafficMix,
  type EmergencyData,
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
import { groundsForRoutes, trafficRings } from './ground-events';
import { PolygonIndex } from './occupancy';
import { eventBodySize } from './event-actors';
import { isEmergencyCraft } from './emergency';
let nextGeneration = 0;

/** Commands retain the previous ordinary snapshot while a fresh event frame is produced. */
function retainOrdinary(
  view: FrameView | undefined,
  route?: ProcessionRoute,
): FrameView | undefined {
  if (!view) return;
  const street = route && route.kind !== 'fluvial' ? route : undefined;
  const projection =
    street &&
    localMetricProjection(street.kind === 'mass' ? street.site.location : street.route[0]!);
  const closure = projection && new PolygonIndex();
  if (closure && street && projection)
    for (const ring of trafficRings(street))
      closure.add([
        ring.map((point) => {
          const [x, y] = projection.to(point);
          return { x, y };
        }),
      ]);
  return {
    ...view,
    puffs: EMPTY_PUFFS,
    procession: undefined,
    throngRun: undefined,
    agents: view.agents.filter((agent) => {
      if (agent.event || agent.eventGround || agent.prop === 'event') return false;
      if (route?.kind === 'fluvial' && (agent.kind === 'boat' || agent.aboard)) return false;
      if (!agent.vehicle || !closure || !projection) return true;
      const [x, y] = projection.to([agent.lng, agent.lat]);
      const [ax, ay] = projection.to(agent.ahead ?? [agent.lng, agent.lat]);
      const dx = ax - x,
        dy = ay - y,
        distance = Math.hypot(dx, dy) || 1;
      const { length, width } = eventBodySize(agent);
      return !closure.hits([
        {
          x,
          y,
          hx: distance === 1 && !dx && !dy ? 1 : dx / distance,
          hy: dy / distance,
          length,
          width,
        },
      ]);
    }),
  };
}

export type FrameView = {
  generation?: number;
  agents: VisibleAgent[];
  puffs: Float64Array;
  procession: ProcessionRun | undefined;
  /** Run and terrain accepted together; HUD may display a newer optimistic command. */
  throngRun?: ProcessionRun;
  signalClock: number;
  cellGuard: LifeWorld['groundCellGuard'];
};
export interface LifeHost {
  setEmergency(data?: EmergencyData): void;
  /** Drop replies produced under a previous season without resetting the population. */
  invalidateFrame(): void;
  sync(tiles: readonly LifeTile[], focus?: readonly [number, number], view?: LifeViewContext): void;
  clearTiles(): void;
  /** True when a step was accepted. Rejected requests leave dt accumulating on the caller. */
  request(input: FrameInput): boolean;
  latest(): FrameView | undefined;
  /** Replace event geography without changing tile residency or ordinary population. */
  setProcessions(routes: readonly ProcessionRoute[]): void;
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
  let liveIdentity: { id?: string; occurrence?: string } = {};
  return {
    invalidateFrame() {
      if (view) view = { ...view, agents: [], throngRun: undefined };
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

export function createWorkerHost(
  options: {
    traffic?: TrafficMix;
    cityLife?: RuntimeCityLife;
    emergency?: EmergencyData;
    itemInspection?: boolean;
    emojiObserver?: boolean;
    moments?: MomentOptions;
  },
  processions: readonly ProcessionRoute[],
  profiler?: FrameProfiler,
): LifeHost {
  const seasons = simulationSeasons(options.cityLife?.seasons);
  let emergency = options.emergency;
  let eventGrounds = groundsForRoutes(processions);
  let worker: Worker;
  const inline = () => {
    const world = new LifeWorld(
      options.traffic,
      profiler,
      options.moments,
      options.itemInspection,
      options.emojiObserver,
    );
    configureLifeWorld(world, {
      processions,
      seasons,
      shopSchedule: options.cityLife?.schedules?.shops,
      emergencyConfig: options.cityLife?.emergency,
      emergency,
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
      emojiObserver: options.emojiObserver,
      dialogue: options.moments?.dialogue,
      periods: options.moments?.periods,
      emergencyConfig: options.cityLife?.emergency,
      emergency,
    })
    .then(() => {
      if (!disposed && !fallback) ready = true;
    }, fail);
  return {
    invalidateFrame() {
      agentEpoch++;
      acceptedPost = undefined;
      if (fallback) fallback.invalidateFrame();
      if (view) view = { ...view, agents: [], throngRun: undefined };
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
      if (view)
        view = {
          ...view,
          agents: [],
          throngRun: undefined,
          puffs: EMPTY_PUFFS,
          cellGuard: () => undefined,
        };
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
                agents: view?.agents ?? [],
                puffs: EMPTY_PUFFS,
                generation,
                procession: view?.procession,
                signalClock: view?.signalClock ?? 0,
                cellGuard: (toCell, terrainOnly) =>
                  cellTerrain &&
                  makeCellGuard(
                    cellTerrain.ref,
                    cellTerrain.access,
                    cellTerrain.trees,
                    toCell,
                    eventGrounds,
                    cellTerrain.blocked,
                    cellTerrain.hardBlocked,
                    terrainOnly,
                  ),
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
            throngRun: result.procession,
            signalClock: result.signalClock,
            cellGuard: (toCell, terrainOnly) =>
              cellTerrain &&
              makeCellGuard(
                cellTerrain.ref,
                cellTerrain.access,
                cellTerrain.trees,
                toCell,
                eventGrounds,
                cellTerrain.blocked,
                cellTerrain.hardBlocked,
                terrainOnly,
              ),
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
    setProcessions(routes) {
      if (disposed) return;
      processions = routes;
      eventGrounds = groundsForRoutes(routes);
      agentEpoch++;
      played = undefined;
      playedTiming = undefined;
      live = { id: undefined };
      acceptedPost = undefined;
      view = retainOrdinary(view);
      if (fallback) fallback.setProcessions(routes);
      else void remote.setProcessions(routes).catch(fail);
    },
    setLive(id, progress, occurrence) {
      if (disposed) return;
      if (!played && (live.id !== id || live.occurrence !== occurrence)) {
        agentEpoch++;
        view = retainOrdinary(
          view,
          processions.find((route) => route.id === id),
        );
      }
      live = { id, progress, occurrence };
      if (fallback) fallback.setLive(id, progress, occurrence);
      else void remote.setLive(id, progress, occurrence).catch(fail);
    },
    setEmergency(data) {
      // Reject stale agents while retaining valid terrain from an in-flight reply.
      if (disposed) return;
      emergency = data;
      agentEpoch++;
      acceptedPost = undefined;
      if (view)
        view = {
          ...view,
          agents: view.agents.filter((agent) => !isEmergencyCraft(agent.vehicle)),
          puffs: EMPTY_PUFFS,
        };
      if (fallback) fallback.setEmergency(data);
      else void remote.setEmergency(data).catch(fail);
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
      const retained = retainOrdinary(
        view,
        processions.find((route) => route.id === id),
      );
      view = {
        ...retained,
        generation,
        agents: retained?.agents ?? [],
        puffs: EMPTY_PUFFS,
        signalClock: view?.signalClock ?? 0,
        cellGuard: retained?.cellGuard ?? (() => undefined),
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
      view = retainOrdinary(
        view,
        processions.find((route) => route.id === live.id),
      );
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
