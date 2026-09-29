/**
 * Loaded tiles on the GPU, and which of them to draw for a view: the view's own tiles where
 * they have loaded, else a loaded ancestor or loaded children, plus the coarser tiles that hold
 * the region-only features (DATA.md §2 step 05).
 */
import { REGION_TILE_MAX_ZOOM, type CameraState } from '@atlas/shared';
import { isTilted, viewportFor, type Size } from './camera';
import { deleteTile, uploadTile, type GL, type TileMesh } from './gpu';
import type { TileLabel } from './raster/geometry';
import {
  ancestorAt,
  boundsTiles,
  findAncestor,
  LruCache,
  tileKey,
  TileSource,
  tileZoom,
  viewTiles,
  type TileHeader,
  type TileId,
} from './tiles';

const TILE_CACHE_SIZE = 256;

/** A loaded tile: its GPU mesh and label candidates. */
export type LoadedTile = { mesh: TileMesh; labels: TileLabel[] };

export class TileCache {
  readonly source: TileSource;
  private header: TileHeader | null = null;
  private readonly failed = new Set<string>();
  /** Loaded tiles (null = the archive has no tile there). */
  private meshes: LruCache<LoadedTile | null>;
  /** While the WebGL context is lost, arriving tiles are dropped and asked for again later. */
  private suspended = false;

  constructor(
    private readonly gl: GL,
    url: string,
    /** Called when the header or a tile arrives, so the view redraws. */
    onChange: () => void,
  ) {
    this.meshes = this.createCache();
    this.source = new TileSource(url, {
      header: (h) => {
        this.header = h;
        onChange();
      },
      tile: (key, geometry) => {
        if (this.suspended) return;
        this.meshes.set(
          key,
          geometry ? { mesh: uploadTile(gl, geometry), labels: geometry.labels } : null,
        );
        onChange();
      },
      error: (message, key) => {
        if (key) this.failed.add(key);
        console.warn(`ASCII Atlas: ${key ? `tile ${key}: ` : ''}${message}`);
      },
    });
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
    let view: TileId[];
    if (isTilted(camera)) {
      // The tilted view's ground footprint (the far edge is where the view reaches the ground).
      const [[west, south], [east, north]] = viewportFor(camera, size).getBounds() as [
        [number, number],
        [number, number],
      ];
      view = boundsTiles([west, south, east, north], tileZoom(camera.zoom, header), header, [
        camera.lng,
        camera.lat,
      ]);
    } else {
      view = viewTiles(camera, size, header);
    }
    const out = new Map<string, TileId>();
    for (const tile of view) {
      const key = tileKey(tile);
      if (meshes.has(key)) {
        out.set(key, tile);
        continue;
      }
      if (!this.failed.has(key)) this.source.request(tile);
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
    for (const tile of tiles) {
      const region = ancestorAt(tile, Math.max(header.minZoom, REGION_TILE_MAX_ZOOM));
      const key = tileKey(region);
      if (loaded(key)) {
        out.set(key, region);
        continue;
      }
      if (!meshes.has(key) && !this.failed.has(key)) this.source.request(region);
      const fallback = findAncestor(region, header.minZoom, loaded);
      if (fallback) out.set(tileKey(fallback), fallback);
    }
    return [...out.values()].sort((a, b) => a.z - b.z);
  }

  destroy() {
    this.source.destroy();
    this.meshes.clear();
  }
}
