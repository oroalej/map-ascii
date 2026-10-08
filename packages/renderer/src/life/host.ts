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
import type { LifeWorld, LifeTile, ProcessionRun, VisibleAgent } from './simulate';
import type { FrameInput, LifeWorkerApi } from './worker-api';
import { cellTerrainFrom } from './terrain-snapshot';
import { makeCellGuard } from './cell-guard';
import type { LifeViewContext } from './births';
import { EMPTY_PUFFS } from './exhaust';
import { groundsForRoutes, trafficRings } from './ground-events';
import { PolygonIndex } from './occupancy';
import { eventBodySize } from './event-actors';
import { runtimeFolklore } from './folklore-config';
import { EMPTY_FOLKLORE, type FolklorePacket } from './folklore';
import { isEmergencyCraft } from './emergency';
import type { TapReceipt } from './tap';
import type { SignalOffsets } from './signals';
let nextGeneration = 0;
export const allocateLifeGeneration = () => ++nextGeneration;

/** Commands retain the previous ordinary snapshot while a fresh event frame is produced. */
export function retainOrdinary(
  view: FrameView | undefined,
  route?: ProcessionRoute,
): FrameView | undefined {
  if (!view) return;
  const rings = route ? trafficRings(route) : [];
  const projection =
    route &&
    rings.length > 0 &&
    localMetricProjection(route.kind === 'mass' ? route.site.location : route.route[0]!);
  const closure = projection && new PolygonIndex();
  if (closure && projection)
    for (const ring of rings)
      closure.add([
        ring.map((point) => {
          const [x, y] = projection.to(point);
          return { x, y };
        }),
      ]);
  return {
    ...view,
    folklore: EMPTY_FOLKLORE,
    puffs: EMPTY_PUFFS,
    procession: undefined,
    tapFrame: undefined,
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
  folklore: FolklorePacket;
  generation?: number;
  agents: VisibleAgent[];
  puffs: Float64Array;
  procession: ProcessionRun | undefined;
  /** Run and terrain accepted together; HUD may display a newer optimistic command. */
  throngRun?: ProcessionRun;
  signalClock: number;
  signalOffsets?: SignalOffsets;
  tapFrame?: number;
  tapReceipts?: readonly TapReceipt[];
  cellGuard: LifeWorld['groundCellGuard'];
};
export interface LifeHost {
  setEmergency(data?: EmergencyData): void;
  /** Drop replies produced under a previous season without resetting the population. */
  invalidateFrame(): void;
  /** Clear observer output while keeping compatible ordinary frames and pending replies. */
  invalidateFolklore(): void;
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

type InlineLoader = () => Promise<{
  createConfiguredInlineHost: (
    options: LifeHostOptions,
    processions: readonly ProcessionRoute[],
    profiler?: FrameProfiler,
  ) => LifeHost;
}>;

/** Frames are rejected while loading, so the caller retains dt and submits a fresh view. */
export function createInlineHostLazy(
  options: LifeHostOptions,
  routes: readonly ProcessionRoute[],
  profiler?: FrameProfiler,
  load: InlineLoader = () => import('./inline-host'),
): LifeHost {
  let host: LifeHost | undefined;
  let disposed = false;
  let initialOptions: LifeHostOptions | undefined = options;
  let initialRoutes: readonly ProcessionRoute[] = routes;
  let processions = routes;
  let pending: ProcessionRun | undefined;
  let commands: ((host: LifeHost) => void)[] = [];
  const send = (command: (host: LifeHost) => void) => {
    if (disposed) return;
    if (host) command(host);
    else commands.push(command);
  };
  // Always replay against the initial configuration, then apply replacements in call order.
  void Promise.resolve()
    .then(load)
    .then(({ createConfiguredInlineHost }) => {
      if (disposed) return;
      host = createConfiguredInlineHost(initialOptions!, initialRoutes, profiler);
      initialOptions = undefined;
      initialRoutes = [];
      for (const command of commands) command(host);
      commands = [];
      pending = undefined;
      processions = [];
    })
    .catch((error: unknown) => {
      if (disposed) return;
      disposed = true;
      commands = [];
      initialOptions = undefined;
      initialRoutes = [];
      processions = [];
      pending = undefined;
      host?.dispose();
      host = undefined;
      console.error('Unable to load inline Life simulation', error);
    });
  return {
    sync: (tiles, focus, view) => send((h) => h.sync(tiles, focus, view)),
    clearTiles: () => send((h) => h.clearTiles()),
    invalidateFrame: () => send((h) => h.invalidateFrame()),
    invalidateFolklore: () => send((h) => h.invalidateFolklore()),
    setEmergency: (data) => send((h) => h.setEmergency(data)),
    setLive: (id, progress, occurrence) => send((h) => h.setLive(id, progress, occurrence)),
    setProcessions(next) {
      if (disposed) return;
      processions = next;
      pending = undefined;
      send((h) => h.setProcessions(next));
    },
    play(id, timing) {
      if (disposed) return false;
      if (host) return host.play(id, timing);
      if (!processions.some((route) => route.id === id)) return false;
      pending = { id, progress: 0, live: false, ...(timing && { time: eventTime(timing, 0) }) };
      send((h) => {
        h.play(id, timing);
      });
      return true;
    },
    stop() {
      pending = undefined;
      send((h) => h.stop());
    },
    request: (input) => !disposed && !!host && host.request(input),
    latest: () => {
      if (disposed) return;
      if (host) return host.latest();
      if (pending)
        return {
          agents: [],
          folklore: EMPTY_FOLKLORE,
          puffs: EMPTY_PUFFS,
          signalClock: 0,
          cellGuard: () => undefined,
          procession: pending,
        };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      commands = [];
      initialOptions = undefined;
      initialRoutes = [];
      processions = [];
      pending = undefined;
      host?.dispose();
      host = undefined;
    },
  };
}

export type LifeHostOptions = {
  traffic?: TrafficMix;
  cityLife?: RuntimeCityLife;
  emergency?: EmergencyData;
  itemInspection?: boolean;
  emojiObserver?: boolean;
  moments?: MomentOptions;
};

export function createWorkerHost(
  options: LifeHostOptions,
  processions: readonly ProcessionRoute[],
  profiler?: FrameProfiler,
  loadInline?: InlineLoader,
): LifeHost {
  const seasons = simulationSeasons(options.cityLife?.seasons);
  let emergency = options.emergency;
  let eventGrounds = groundsForRoutes(processions);
  let worker: Worker;
  const inline = () =>
    createInlineHostLazy({ ...options, emergency }, processions, profiler, loadInline);
  try {
    worker = new Worker(new URL('./life.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return inline();
  }
  const remote = Comlink.wrap<LifeWorkerApi>(worker);
  let ready = false,
    inFlight = false,
    disposed = false,
    generation = allocateLifeGeneration(),
    agentEpoch = 0,
    folkloreEpoch = 0,
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
    generation = allocateLifeGeneration();
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
      folklore: runtimeFolklore(options.cityLife),
      itemInspection: options.itemInspection,
      tapTargets: true,
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
      if (view)
        view = {
          ...view,
          agents: [],
          folklore: EMPTY_FOLKLORE,
          tapReceipts: undefined,
          tapFrame: undefined,
          throngRun: undefined,
        };
    },
    invalidateFolklore() {
      folkloreEpoch++;
      if (fallback) fallback.invalidateFolklore();
      if (view) view = { ...view, folklore: EMPTY_FOLKLORE };
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
          generation = allocateLifeGeneration();
          terrain = undefined;
        }
        // Keep the last complete frame while nonempty geometry loads. It is never combined
        // with a different generation; the next valid reply replaces agents and guard together.
        if (!keep.size && view)
          view = {
            ...view,
            agents: [],
            folklore: EMPTY_FOLKLORE,
            puffs: EMPTY_PUFFS,
            cellGuard: () => undefined,
          };
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
      generation = allocateLifeGeneration();
      acceptedPost = undefined;
      profiler?.clearContinuity();
      terrain = undefined;
      sent.clear();
      if (view)
        view = {
          ...view,
          agents: [],
          throngRun: undefined,
          folklore: EMPTY_FOLKLORE,
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
      const requestedFolkloreEpoch = folkloreEpoch;
      const frame = ++frames;
      const posted = profiler?.time();
      void remote
        .frame({
          ...input,
          step: {
            ...input.step,
            ...(input.step.taps && {
              taps: input.step.taps.filter((tap) => tap.generation === generation),
            }),
          },
        })
        .then((result) => {
          if (disposed || generation !== requestedGeneration) return;
          if (result.terrain !== undefined) {
            const start = profiler?.time();
            terrain = result.terrain === null ? undefined : cellTerrainFrom(result.terrain);
            if (start !== undefined) profiler!.record('terrainSnapshot', profiler!.time() - start);
          }
          if (agentEpoch !== requestedAgentEpoch) {
            const cellTerrain = terrain;
            if (view || result.terrain !== undefined || result.tapReceipts?.length)
              view = {
                agents: view?.agents ?? [],
                folklore: EMPTY_FOLKLORE,
                puffs: EMPTY_PUFFS,
                generation,
                procession: view?.procession,
                signalClock: result.signalClock,
                ...(result.signalOffsets && { signalOffsets: result.signalOffsets }),
                // Retained agents are not the drawables for the rejected result's tapFrame.
                tapFrame: undefined,
                tapReceipts: result.tapReceipts,
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
            folklore:
              folkloreEpoch === requestedFolkloreEpoch
                ? (result.folklore ?? EMPTY_FOLKLORE)
                : EMPTY_FOLKLORE,
            puffs: result.puffs,
            generation,
            procession: result.procession,
            throngRun: result.procession,
            signalClock: result.signalClock,
            ...(result.signalOffsets && { signalOffsets: result.signalOffsets }),
            tapFrame: result.tapFrame,
            tapReceipts: result.tapReceipts,
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
          tapFrame: undefined,
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
        folklore: EMPTY_FOLKLORE,
        puffs: EMPTY_PUFFS,
        signalClock: view?.signalClock ?? 0,
        ...(view?.signalOffsets && { signalOffsets: view.signalOffsets }),
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
      generation = allocateLifeGeneration();
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
