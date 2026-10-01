import * as Comlink from 'comlink';
import type { CameraState, ProcessionRoute, TrafficMix } from '@atlas/shared';
import { FrameProfiler, type ProfileSample } from '../profile';
import { placeGrid } from '../grid';
import { treeGust } from '../glyphs/select';
import { LifeWorld, type LifeTile, type VisibleAgent, type ProcessionRun } from './simulate';
import type { LifeGeometry } from './geometry';
import type { WindNow } from './wind';
import { snapshotOf, type TerrainSnapshot } from './terrain-snapshot';

type Step = Parameters<LifeWorld['step']>;
export type FrameInput = {
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
  };
  visible: Parameters<LifeWorld['visible']>;
};
export type FrameResult = {
  agents: VisibleAgent[];
  procession: ProcessionRun | undefined;
  signalClock: number;
  terrain?: TerrainSnapshot | null;
  profile?: ProfileSample;
};
export type LifeInit = {
  traffic?: TrafficMix;
  processions: readonly ProcessionRoute[];
  profiling?: boolean;
};
export type SyncTile = Omit<LifeTile, 'life'> & { life?: LifeGeometry };

/** Shared synchronous execution keeps the fallback's order and arguments identical. */
export function runLifeFrame(world: LifeWorld, input: FrameInput, profiler?: FrameProfiler) {
  const { gust, step } = input;
  const { grid, toCell } = placeGrid(
    { camera: gust.camera, dpr: 1, ...gust.size },
    gust.cssCell,
    1,
    1,
  );
  const start = profiler?.time();
  world.step(
    step.dt,
    (lng, lat) => {
      const [col, row] = toCell(lng, lat);
      const x = grid.originCol + Math.floor(col);
      const y = grid.originRow + Math.floor(row);
      return gust.wind.strength * treeGust(x, y, gust.time, gust.wind.dir);
    },
    step.zoom,
    step.bounds,
    step.wind,
    step.weather,
    step.cellMeters,
    gust.cssCell.h / gust.cssCell.w,
  );
  if (start !== undefined) profiler!.add('step', profiler!.time() - start);
  const visibleStart = profiler?.time();
  const agents = world.visible(...input.visible);
  if (visibleStart !== undefined) profiler!.add('visible', profiler!.time() - visibleStart);
  return { agents, procession: world.procession(), signalClock: world.signalClock };
}

/** Plain API for both Comlink and deterministic tests; no DOM or GL dependencies. */
export function createLifeWorkerApi() {
  let world: LifeWorld;
  let profiler: FrameProfiler | undefined;
  let lastTerrain: object | undefined;
  let terrainSent = false;
  const geometries = new Map<string, LifeGeometry>();
  return {
    init(options: LifeInit) {
      profiler = options.profiling ? new FrameProfiler() : undefined;
      world = new LifeWorld(options.traffic, profiler);
      world.setProcessions(options.processions);
      geometries.clear();
      lastTerrain = undefined;
      terrainSent = false;
    },
    sync(tiles: readonly SyncTile[]) {
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
      world.sync(resolved);
      const sample = profiler?.drain();
      if (sample) profiler!.merge(sample);
      if (!tiles.length) terrainSent = false;
    },
    frame(input: FrameInput): FrameResult {
      profiler?.begin(input.gust.time * 1000);
      const result: FrameResult = runLifeFrame(world, input, profiler);
      for (const agent of result.agents) delete agent.consist;
      const terrain = world.cellTerrain();
      let buffers: ArrayBuffer[] = [];
      if (!terrainSent || terrain?.version !== lastTerrain) {
        terrainSent = true;
        lastTerrain = terrain?.version;
        if (terrain) {
          const start = profiler?.time();
          const encoded = snapshotOf(terrain);
          if (start !== undefined) profiler!.add('terrainEncode', profiler!.time() - start);
          result.terrain = encoded.snapshot;
          buffers = encoded.transferables;
        } else result.terrain = null;
      }
      if (profiler) {
        // Profiling only: serialization plus deserialization bounds the reply's clone cost.
        const start = profiler.time();
        structuredClone({ agents: result.agents, procession: result.procession });
        profiler.add('replyClone', profiler.time() - start);
        result.profile = profiler.drain();
      }
      return Comlink.transfer(result, buffers);
    },
    setLive(id: string | undefined, progress?: number) {
      world.setLive(id, progress);
    },
    play(id: string) {
      return world.play(id);
    },
    stop() {
      world.stop();
    },
  };
}
export type LifeWorkerApi = ReturnType<typeof createLifeWorkerApi>;
