/**
 * Loaded tiles on the GPU, and which of them to draw for a view: the view's own tiles where
 * they have loaded, else a loaded ancestor or loaded children, plus the coarser tiles that hold
 * the region-only features (DATA.md §2 step 05).
 */
import { REGION_TILE_MAX_ZOOM, type CameraState } from '@atlas/shared';
import type { Size } from './camera';
import type { FrameProfiler } from './profile';
import { deleteTile, uploadTile, type GL, type TileMesh } from './gpu';
import type { UtilityRecord, SeasonalRecord } from '@atlas/shared';
import type { LifeGeometry } from './life/geometry';
import type { TileLabel } from './raster/geometry';
import {
  ancestorAt,
  findAncestor,
  LruCache,
  tileKey,
  TileSource,
  viewTiles,
  type TileHeader,
  type TileId,
} from './tiles';

const TILE_CACHE_SIZE = 256;
/** A tile that failed is asked for again after this long, doubling each time up to the max. */
export const RETRY_MS = 2000;
export const RETRY_MAX_MS = 60_000;

/** A loaded tile: its GPU mesh and label candidates. */
export type LoadedTile = {
  mesh: TileMesh;
  labels: TileLabel[];
  life: LifeGeometry;
  utilities?: readonly UtilityRecord[];
  seasonal?: readonly SeasonalRecord[];
};

export class TileCache {
  readonly source: TileSource;
  private header: TileHeader | null = null;
  /** Tiles that failed to load: how often, and when to ask for them again (`Date.now()` ms). */
  private readonly failed = new Map<string, { tries: number; retryAt: number }>();
  /** Timers that redraw when a failed tile's retry comes due, so an idle map asks again. */
  private readonly retryTimers = new Set<ReturnType<typeof setTimeout>>();
  /** Loaded tiles (null = the archive has no tile there). */
  private meshes: LruCache<LoadedTile | null>;
  /** While the WebGL context is lost, arriving tiles are dropped and asked for again later. */
  private suspended = false;

  constructor(
    private readonly gl: GL,
    url: string,
    /** Called when the header or a tile arrives, so the view redraws. */
    onChange: () => void,
    profiler?: FrameProfiler,
  ) {
    this.meshes = this.createCache();
    this.source = new TileSource(url, {
      header: (h) => {
        this.header = h;
        onChange();
      },
      tile: (key, geometry) => {
        if (this.suspended) return;
        this.failed.delete(key);
        if (geometry) {
          const start = profiler?.time();
          const mesh = uploadTile(gl, geometry);
          if (start !== undefined) profiler!.record('tileUpload', profiler!.time() - start);
          this.meshes.set(key, {
            mesh,
            labels: geometry.labels,
            life: geometry.life,
            ...(geometry.utilities ? { utilities: geometry.utilities } : {}),
            ...(geometry.seasonal ? { seasonal: geometry.seasonal } : {}),
          });
        } else this.meshes.set(key, null);
        onChange();
      },
      error: (message, key) => {
        if (key) this.retryLater(key, onChange);
        console.warn(`ASCII Atlas: ${key ? `tile ${key}: ` : ''}${message}`);
      },
    });
  }

  /** A tile failed: ask for it again after a backoff, and redraw then so the view does. */
  private retryLater(key: string, onChange: () => void) {
    const tries = (this.failed.get(key)?.tries ?? 0) + 1;
    const delay = Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** (tries - 1));
    this.failed.set(key, { tries, retryAt: Date.now() + delay });
    const timer = setTimeout(() => {
      this.retryTimers.delete(timer);
      onChange();
    }, delay);
    this.retryTimers.add(timer);
  }

  /** Whether a tile may be asked for: it never failed, or its retry is due. */
  private mayRequest(key: string) {
    const failed = this.failed.get(key);
    return !failed || Date.now() >= failed.retryAt;
  }

  private createCache() {
    return new LruCache<LoadedTile | null>(TILE_CACHE_SIZE, (tile) => {
      if (tile) deleteTile(this.gl, tile.mesh);
    });
  }

  get(tile: TileId): LoadedTile | null | undefined {
    return this.meshes.get(tileKey(tile));
  }

  /** Number of tiles loaded (including ones the archive doesn't have). */
  get size() {
    return this.meshes.size;
  }

  /**
   * The WebGL context was lost: every mesh is gone with it. Forget them without deleting (the
   * handles are dead), and drop tiles that arrive until `resume`.
   */
  suspend() {
    this.suspended = true;
    this.meshes = this.createCache();
    this.failed.clear();
  }

  /** The context is back; `tilesToDraw` asks for the view's tiles again. */
  resume() {
    this.suspended = false;
  }

  /** Tiles to draw for the view: loaded ones, else a loaded ancestor or loaded children. */
  tilesToDraw(camera: CameraState, size: Size): TileId[] {
    const { header, meshes } = this;
    if (!header || this.suspended) return [];
    const minZoom = header.minZoom;
    const view = viewTiles(camera, size, header);
    const out = new Map<string, TileId>();
    const missing: TileId[] = [];
    for (const tile of view) {
      const key = tileKey(tile);
      if (meshes.has(key)) {
        out.set(key, tile);
        continue;
      }
      if (this.mayRequest(key)) missing.push(tile);
      const ancestor = findAncestor(tile, minZoom, (k) => meshes.has(k));
      if (ancestor) {
        out.set(tileKey(ancestor), ancestor);
        continue;
      }
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const child = { z: tile.z + 1, x: tile.x * 2 + dx, y: tile.y * 2 + dy };
          if (meshes.has(tileKey(child))) out.set(tileKey(child), child);
        }
      }
    }
    // In the view's order (from its center out): those the view no longer needs are dropped.
    this.source.want(missing, 'view');
    // Coarser tiles first, so finer ones overwrite them where both exist.
    return [...out.values()].sort((a, b) => a.z - b.z);
  }

  /**
   * Tiles whose region-only features to draw under the view's tiles: each view tile's
   * ancestor at `REGION_TILE_MAX_ZOOM` (or the tile itself when it is that coarse), else, while
   * that one loads, its nearest loaded ancestor.
   */
  regionTilesFor(tiles: readonly TileId[]): TileId[] {
    const { header, meshes } = this;
    if (!header) return [];
    const loaded = (key: string) => !!meshes.get(key);
    const out = new Map<string, TileId>();
    const missing = new Map<string, TileId>();
    for (const tile of tiles) {
      const region = ancestorAt(tile, Math.max(header.minZoom, REGION_TILE_MAX_ZOOM));
      const key = tileKey(region);
      if (loaded(key)) {
        out.set(key, region);
        continue;
      }
      if (!meshes.has(key) && this.mayRequest(key)) missing.set(key, region);
      const fallback = findAncestor(region, header.minZoom, loaded);
      if (fallback) out.set(tileKey(fallback), fallback);
    }
    this.source.want([...missing.values()], 'region');
    return [...out.values()].sort((a, b) => a.z - b.z);
  }

  destroy() {
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers.clear();
    this.source.destroy();
    this.meshes.clear();
  }
}
