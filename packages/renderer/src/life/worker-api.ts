import type { SimulationSeason } from './seasonal-simulation';
import * as Comlink from 'comlink';
import type {
  CameraState,
  EmergencyConfig,
  EmergencyData,
  EventTiming,
  ProcessionRoute,
  ShopSchedule,
  TrafficMix,
} from '@atlas/shared';
import type { DialogueChoice, GreetingPeriods } from '@atlas/shared';
import { FrameProfiler, type ProfileSample } from '../profile';
import { placeGrid, metersPerCssPx } from '../grid';
import { treeGust } from '../glyphs/select';
import { LifeWorld, type LifeTile, type VisibleAgent, type ProcessionRun } from './simulate';
import type { LifeGeometry } from './geometry';
import type { WindNow } from './wind';
import { snapshotOf, type TerrainSnapshot } from './terrain-snapshot';
import { spawnMargin, type LifeViewContext } from './births';
import { LifePreparation } from './preparation';
import type { InspectionCommand } from './inspection';
import type { RuntimeFolklore } from './folklore-config';
import type { FolklorePacket } from './folklore';

type Step = Parameters<LifeWorld['step']>;
export type FrameInput = {
  inspection?: InspectionCommand;
  gust: {
    camera: CameraState;
    size: { width: number; height: number };
    cssCell: { w: number; h: number };
    time: number;
    wind: Pick<WindNow, 'dir' | 'strength'>;
  };
  step: {
    dt: Step[0];
    zoom: Step[2];
    bounds: Step[3];
    wind: Step[4];
    weather: Step[5];
    cellMeters: Step[6];
    /** Actual rounded render grid scale; movement still uses CSS clearance. */
    effectCellMeters?: number;
    /** Mouse hover in longitude/latitude; absent after hover clears. */
    pointer?: readonly [number, number];
    pointerRest?: Step[10];
    gust?: Step[11];
  };
  visible: Parameters<LifeWorld['visible']>;
};
export type FrameResult = {
  folklore: FolklorePacket;
  agents: VisibleAgent[];
  puffs: Float64Array;
  procession: ProcessionRun | undefined;
  signalClock: number;
  terrain?: TerrainSnapshot | null;
  profile?: ProfileSample;
};
export type LifeInit = {
  folklore?: RuntimeFolklore;
  emergencyConfig?: EmergencyConfig;
  emergency?: EmergencyData;
  seasons?: readonly SimulationSeason[];
  shopSchedule?: ShopSchedule;
  itemInspection?: boolean;
  /** Internal isolation switch; public emoji display preferences never reach it. */
  emojiObserver?: boolean;
  dialogue?: readonly DialogueChoice[];
  periods?: Readonly<GreetingPeriods>;
  traffic?: TrafficMix;
  processions: readonly ProcessionRoute[];
  profiling?: boolean;
};
export type SyncTile = Omit<LifeTile, 'life'> & { life?: LifeGeometry };

export function configureLifeWorld(
  world: LifeWorld,
  options: Pick<
    LifeInit,
    'processions' | 'seasons' | 'shopSchedule' | 'folklore' | 'emergencyConfig' | 'emergency'
  >,
) {
  world.setProcessions(options.processions);
  world.setSeasons(options.seasons ?? []);
  world.setShopSchedule(options.shopSchedule);
  world.setFolklore(options.folklore);
  world.configureEmergency(options.emergencyConfig, options.emergency);
}

/** Shared synchronous execution keeps the fallback's order and arguments identical. */
export function runLifeFrame(world: LifeWorld, input: FrameInput, profiler?: FrameProfiler) {
  const { gust, step } = input;
  if (input.inspection) world.inspection?.select(input.inspection, world.signalClock);
  const { grid, toCell } = placeGrid(
    { camera: gust.camera, dpr: 1, ...gust.size },
    gust.cssCell,
    1,
    1,
  );
  const start = profiler?.time();
  world.setEmojiView(input.visible);
  world.step(
    step.dt,
    (lng, lat) => {
      const [col, row] = toCell(lng, lat);
      const x = grid.originCol + Math.floor(col);
      const y = grid.originRow + Math.floor(row);
      const global = gust.wind.strength * treeGust(x, y, gust.time, gust.wind.dir);
      if (!step.gust) return global;
      const [cx, cy] = toCell(...step.gust.lngLat);
      const distance =
        Math.hypot(col - cx, ((row - cy) * gust.cssCell.h) / gust.cssCell.w) *
        (step.cellMeters ?? 0);
      return global + step.gust.strength * Math.max(0, 1 - distance / step.gust.radiusM);
    },
    step.zoom,
    step.bounds,
    step.wind,
    step.weather,
    step.cellMeters,
    gust.cssCell.h / gust.cssCell.w,
    step.effectCellMeters ?? metersPerCssPx(gust.camera) * Math.min(gust.cssCell.w, gust.cssCell.h),
    step.pointer,
    step.pointerRest,
    step.gust,
  );
  if (start !== undefined) profiler!.add('step', profiler!.time() - start);
  const visibleStart = profiler?.time();
  const agents = world.visible(...input.visible);
  if (visibleStart !== undefined) profiler!.add('visible', profiler!.time() - visibleStart);
  return {
    folklore: world.visibleFolklore(input.visible[0], input.visible[2]),
    agents,
    puffs: world.visiblePuffs,
    procession: world.procession(),
    signalClock: world.signalClock,
  };
}

/** Plain API for both Comlink and deterministic tests; no DOM or GL dependencies. */
export function createLifeWorkerApi(
  preparationClock?: () => number,
  worldFactory = (options: LifeInit, profiler?: FrameProfiler) =>
    new LifeWorld(
      options.traffic,
      profiler,
      {
        dialogue: options.dialogue,
        periods: options.periods,
      },
      options.itemInspection,
      options.emojiObserver,
    ),
) {
  let world: LifeWorld;
  let profiler: FrameProfiler | undefined;
  let preparation: LifePreparation;
  let lastTerrain: object | undefined;
  let terrainSent = false;
  const geometries = new Map<string, LifeGeometry>();
  return {
    init(options: LifeInit) {
      preparation?.clear();
      profiler = options.profiling ? new FrameProfiler() : undefined;
      world = worldFactory(options, profiler);
      preparation = new LifePreparation(world, profiler, preparationClock);
      configureLifeWorld(world, options);
      geometries.clear();
      lastTerrain = undefined;
      terrainSent = false;
    },
    sync(tiles: readonly SyncTile[], focus?: readonly [number, number], view?: LifeViewContext) {
      const keep = new Set(tiles.map((t) => t.key));
      const resolved = tiles.map(({ key, tile, life }) => {
        const geometry = life ?? geometries.get(key);
        if (!geometry) throw new Error(`Missing Life geometry for ${key}`);
        geometries.set(key, geometry);
        return { key, tile, life: geometry };
      });
      for (const key of geometries.keys()) if (!keep.has(key)) geometries.delete(key);
      // Sync happens between frame requests. Carry its timing into the next frame result.
      profiler?.begin(0);
      preparation.sync(resolved, focus, view);
      const sample = profiler?.drain();
      if (sample) profiler!.merge(sample);
      if (!tiles.length) terrainSent = false;
    },
    clearTiles() {
      world.clearTiles();
      preparation.clear();
      geometries.clear();
      lastTerrain = undefined;
      terrainSent = false;
    },
    frame(input: FrameInput): FrameResult {
      profiler?.begin(input.gust.time * 1000);
      preparation.camera(
        input.step.bounds,
        spawnMargin(input.step.cellMeters ?? 0, input.gust.cssCell.h / input.gust.cssCell.w),
      );
      preparation.commit();
      const result: FrameResult = runLifeFrame(world, input, profiler);
      for (const agent of result.agents) delete agent.consist;
      const terrain = world.cellTerrain();
      const buffers: ArrayBuffer[] = result.puffs.length
        ? [result.puffs.buffer as ArrayBuffer]
        : [];
      if (!terrainSent || terrain?.version !== lastTerrain) {
        terrainSent = true;
        lastTerrain = terrain?.version;
        if (terrain) {
          const start = profiler?.time();
          const encoded = snapshotOf(terrain);
          if (start !== undefined) profiler!.add('terrainEncode', profiler!.time() - start);
          result.terrain = encoded.snapshot;
          buffers.push(...encoded.transferables);
        } else result.terrain = null;
      }
      if (profiler) {
        // Profiling only: serialization plus deserialization bounds the reply's clone cost.
        const start = profiler.time();
        structuredClone({ agents: result.agents, procession: result.procession });
        profiler.add('replyClone', profiler.time() - start);
      }
      preparation.schedule();
      if (profiler) result.profile = profiler.drain();
      return Comlink.transfer(result, buffers);
    },
    setProcessions(routes: readonly ProcessionRoute[]) {
      world.setProcessions(routes);
    },
    setEmergency(data?: EmergencyData) {
      world.setEmergency(data);
    },
    setLive(id: string | undefined, progress?: number, occurrence?: string) {
      world.setLive(id, progress, occurrence);
    },
    play(id: string, timing?: EventTiming) {
      return world.play(id, timing);
    },
    stop() {
      world.stop();
    },
  };
}
export type LifeWorkerApi = ReturnType<typeof createLifeWorkerApi>;
