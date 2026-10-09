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
  PeddlerConfig,
} from '@atlas/shared';
import type { DialogueChoice, GreetingPeriods } from '@atlas/shared';
import { FrameProfiler, type ProfileSample } from '../profile';
import { placeGrid, metersPerCssPx } from '../grid';
import { treeGust } from '../glyphs/select';
import { LifeWorld, type LifeTile, type VisibleAgent, type ProcessionRun } from './simulate';
import type { LifeGeometry } from './geometry';
import type { WindNow } from './wind';
import { snapshotOf, type TerrainSnapshot } from './terrain-snapshot';
import { packAgents, packedTransferables, unpackAgents, type PackedAgents } from './agent-frame';
import { RecentKeys } from './recent-keys';
import { spawnMargin, type LifeViewContext } from './births';
import { LifePreparation } from './preparation';
import type { InspectionCommand } from './inspection';
import type { SignalOffsets } from './signals';
import type { RuntimeFolklore } from './folklore-config';
import type { FolklorePacket } from './folklore';
import type { LifeTap, TapReceipt } from './tap';
import type { TapPointer } from './feed';

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
    taps?: readonly LifeTap[];
    tapPointer?: TapPointer;
  };
  visible: Parameters<LifeWorld['visible']>;
};
export type FrameResult = {
  folklore: FolklorePacket;
  agents: VisibleAgent[];
  puffs: Float64Array;
  procession: ProcessionRun | undefined;
  signalClock: number;
  signalOffsets?: SignalOffsets;
  tapFrame?: number;
  tapReceipts?: readonly TapReceipt[];
  terrain?: TerrainSnapshot | null;
  profile?: ProfileSample;
};
/**
 * A worker reply on the wire: the frame with its agents packed into transferred columns
 * (agent-frame.ts); `frameFromReply` restores the object frame.
 */
export type FrameReply = Omit<FrameResult, 'agents'> & { packed: PackedAgents };

/** The object frame of a delivered reply, with fresh agents. */
export function frameFromReply({ packed, ...rest }: FrameReply): FrameResult {
  return { ...rest, agents: unpackAgents(packed) };
}
export type LifeInit = {
  peddlers?: readonly PeddlerConfig[];
  folklore?: RuntimeFolklore;
  emergencyConfig?: EmergencyConfig;
  emergency?: EmergencyData;
  seasons?: readonly SimulationSeason[];
  shopSchedule?: ShopSchedule;
  itemInspection?: boolean;
  tapTargets?: boolean;
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
    | 'processions'
    | 'seasons'
    | 'shopSchedule'
    | 'folklore'
    | 'emergencyConfig'
    | 'emergency'
    | 'peddlers'
  >,
) {
  world.setProcessions(options.processions);
  world.setSeasons(options.seasons ?? []);
  world.setShopSchedule(options.shopSchedule);
  world.setPeddlers(options.peddlers);
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
    step.taps,
    step.tapPointer,
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
    ...(world.signalOffsets && { signalOffsets: world.signalOffsets }),
    ...(world.tapSources && { tapFrame: world.tapSources.frame }),
    ...(world.tapReceipts && { tapReceipts: world.tapReceipts }),
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
  /** Mirrors the host's record of which geometry is held here (recent-keys.ts). */
  const held = new RecentKeys();
  return {
    init(options: LifeInit) {
      preparation?.clear();
      profiler = options.profiling ? new FrameProfiler() : undefined;
      world = worldFactory(options, profiler);
      if (options.tapTargets) world.enableTaps();
      preparation = new LifePreparation(world, profiler, preparationClock);
      configureLifeWorld(world, options);
      geometries.clear();
      held.clear();
      lastTerrain = undefined;
      terrainSent = false;
    },
    sync(tiles: readonly SyncTile[], focus?: readonly [number, number], view?: LifeViewContext) {
      const resolved = tiles.map(({ key, tile, life }) => {
        const geometry = life ?? geometries.get(key);
        if (!geometry) throw new Error(`Missing Life geometry for ${key}`);
        geometries.set(key, geometry);
        return { key, tile, life: geometry };
      });
      for (const key of held.touch(tiles.map((t) => t.key))) geometries.delete(key);
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
      held.clear();
      lastTerrain = undefined;
      terrainSent = false;
    },
    frame(input: FrameInput): FrameReply {
      profiler?.begin(input.gust.time * 1000);
      preparation.camera(
        input.step.bounds,
        spawnMargin(input.step.cellMeters ?? 0, input.gust.cssCell.h / input.gust.cssCell.w),
      );
      preparation.commit();
      const { agents, ...frame } = runLifeFrame(world, input, profiler);
      for (const agent of agents) delete agent.consist;
      const result: FrameReply = { ...frame, packed: packAgents(agents) };
      const buffers: ArrayBuffer[] = packedTransferables(result.packed);
      if (result.puffs.length) buffers.push(result.puffs.buffer as ArrayBuffer);
      const terrain = world.cellTerrain();
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
        // Profiling overhead, not transport latency: cloning what the reply copies rather than
        // transfers (its string table and sidecars) bounds its serialization cost.
        const start = profiler.time();
        structuredClone({
          table: result.packed.table,
          extras: result.packed.extras,
          procession: result.procession,
          folklore: result.folklore,
          tapReceipts: result.tapReceipts,
          signalOffsets: result.signalOffsets,
        });
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
