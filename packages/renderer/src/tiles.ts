/** Tile selection, the tile cache, and the client side of the tile worker. */
import type { BBox, CameraState } from '@atlas/shared';
import { project, TILE_SIZE, type Size } from './camera';
import type { FeatureInfo, TileGeometry } from './raster/geometry';

export type TileId = { z: number; x: number; y: number };

export type TileHeader = {
  minZoom: number;
  maxZoom: number;
  /** Where the archive has data: [west, south, east, north]. */
  bounds: BBox;
};

export type WorkerRequest =
  { type: 'init'; url: string } | { type: 'tile'; key: string; z: number; x: number; y: number };

export type WorkerResponse =
  | { type: 'header'; header: TileHeader }
  | {
      type: 'tile';
      key: string;
      geometry: TileGeometry | null;
      newFeatures: FeatureInfo[];
      /** Time to decode and triangulate the tile (0 when the archive has none). */
      decodeMs?: number;
    }
  | { type: 'error'; key: string | null; message: string };

export const tileKey = ({ z, x, y }: TileId) => `${z}/${x}/${y}`;

export const parentOf = ({ z, x, y }: TileId): TileId => ({ z: z - 1, x: x >> 1, y: y >> 1 });

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Tile zoom for a camera zoom: the archive's nearest level, overzoomed past its max. */
export const tileZoom = (zoom: number, header: Pick<TileHeader, 'minZoom' | 'maxZoom'>) =>
  clamp(Math.floor(zoom), header.minZoom, header.maxZoom);

/** The tile containing a point at tile zoom `z`. */
function tileAt(lng: number, lat: number, z: number): [number, number] {
  const [x, y] = project(lng, lat, z);
  const n = 2 ** z;
  return [clamp(Math.floor(x / TILE_SIZE), 0, n - 1), clamp(Math.floor(y / TILE_SIZE), 0, n - 1)];
}

/**
 * Tiles covering a `size` (CSS px) view plus `margin` tiles on each side, limited to where the
 * archive has data, nearest to the center first.
 */
export function viewTiles(
  camera: CameraState,
  size: Size,
  header: TileHeader,
  margin = 1,
): TileId[] {
  const z = tileZoom(camera.zoom, header);
  const tileSize = TILE_SIZE * 2 ** (camera.zoom - z);
  const [cx, cy] = project(camera.lng, camera.lat, camera.zoom);
  const [west, south, east, north] = header.bounds;
  const [dx0, dy0] = tileAt(west, north, z);
  const [dx1, dy1] = tileAt(east, south, z);

  const x0 = Math.max(dx0, Math.floor((cx - size.width / 2) / tileSize) - margin);
  const x1 = Math.min(dx1, Math.floor((cx + size.width / 2) / tileSize) + margin);
  const y0 = Math.max(dy0, Math.floor((cy - size.height / 2) / tileSize) - margin);
  const y1 = Math.min(dy1, Math.floor((cy + size.height / 2) / tileSize) + margin);

  const tiles: TileId[] = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) tiles.push({ z, x, y });
  const [ccx, ccy] = [cx / tileSize, cy / tileSize];
  const dist = (t: TileId) => (t.x + 0.5 - ccx) ** 2 + (t.y + 0.5 - ccy) ** 2;
  return tiles.sort((a, b) => dist(a) - dist(b));
}

/**
 * Tiles at `z` covering `bounds` (e.g. a tilted view's ground footprint) plus `margin` tiles
 * on each side, limited to the archive's data, nearest to `center` first, at most `cap`.
 */
export function boundsTiles(
  bounds: BBox,
  z: number,
  header: TileHeader,
  center: readonly [number, number],
  cap = 256,
  margin = 1,
): TileId[] {
  const [west, south, east, north] = bounds;
  const [dw, ds, de, dn] = header.bounds;
  if (west > de || east < dw || south > dn || north < ds) return [];
  const [vx0, vy0] = tileAt(west, north, z);
  const [vx1, vy1] = tileAt(east, south, z);
  const [dx0, dy0] = tileAt(dw, dn, z);
  const [dx1, dy1] = tileAt(de, ds, z);
  const [x0, y0] = [Math.max(dx0, vx0 - margin), Math.max(dy0, vy0 - margin)];
  const [x1, y1] = [Math.min(dx1, vx1 + margin), Math.min(dy1, vy1 + margin)];
  const [px, py] = project(center[0], center[1], z);
  const [cx, cy] = [px / TILE_SIZE, py / TILE_SIZE];
  const tiles: TileId[] = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) tiles.push({ z, x, y });
  const dist = (t: TileId) => (t.x + 0.5 - cx) ** 2 + (t.y + 0.5 - cy) ** 2;
  return tiles.sort((a, b) => dist(a) - dist(b)).slice(0, cap);
}

/** The nearest ancestor (down to `minZoom`) for which `has` is true. */
/** The tile at zoom `z` (at most the tile's own) that contains `tile`. */
export function ancestorAt(tile: TileId, z: number): TileId {
  if (z >= tile.z) return tile;
  const shift = tile.z - z;
  return { z, x: Math.floor(tile.x / 2 ** shift), y: Math.floor(tile.y / 2 ** shift) };
}

export function findAncestor(
  tile: TileId,
  minZoom: number,
  has: (key: string) => boolean,
): TileId | null {
  for (let t = parentOf(tile); t.z >= minZoom; t = parentOf(t)) {
    if (has(tileKey(t))) return t;
  }
  return null;
}

/** Least-recently-used cache. `onEvict` releases whatever the value holds (e.g. GL buffers). */
export class LruCache<V> {
  private readonly map = new Map<string, V>();

  constructor(
    private readonly capacity: number,
    private readonly onEvict: (value: V) => void = () => {},
  ) {}

  get size() {
    return this.map.size;
  }

  has(key: string) {
    return this.map.has(key);
  }

  get(key: string): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  set(key: string, value: V) {
    const old = this.map.get(key);
    if (old !== undefined) this.onEvict(old);
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.capacity) {
      const [oldest, evicted] = this.map.entries().next().value as [string, V];
      this.map.delete(oldest);
      this.onEvict(evicted);
    }
  }

  clear() {
    for (const value of this.map.values()) this.onEvict(value);
    this.map.clear();
  }
}

export type TileSourceHandlers = {
  header: (header: TileHeader) => void;
  /** `geometry` is null when the archive has no tile there. */
  tile: (key: string, geometry: TileGeometry | null) => void;
  /** `key` is the tile that failed, or null for archive-level errors. */
  error: (message: string, key: string | null) => void;
};

/** How many recent tile decodes `decodeMsAverage` covers. */
const DECODE_SAMPLES = 50;

/** Requests tiles from the worker and tracks the feature id strings it registers. */
export class TileSource {
  /** Features by index - 1 (the id buffer stores the index; 0 = none). */
  private readonly features: FeatureInfo[] = [];
  /** Feature id string → index. */
  private readonly indices = new Map<string, number>();
  private readonly pending = new Set<string>();
  private readonly worker: Worker;
  /** Decode times of the most recent tiles, for `decodeMsAverage`. */
  private readonly decodeTimes: number[] = [];

  constructor(url: string, handlers: TileSourceHandlers) {
    this.worker = new Worker(new URL('./tiles.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (message.type === 'header') {
        handlers.header(message.header);
      } else if (message.type === 'tile') {
        this.pending.delete(message.key);
        if (message.decodeMs !== undefined) {
          this.decodeTimes.push(message.decodeMs);
          if (this.decodeTimes.length > DECODE_SAMPLES) this.decodeTimes.shift();
        }
        for (const info of message.newFeatures) {
          this.features.push(info);
          this.indices.set(info.id, this.features.length);
        }
        handlers.tile(message.key, message.geometry);
      } else {
        if (message.key) this.pending.delete(message.key);
        handlers.error(message.message, message.key);
      }
    };
    this.post({ type: 'init', url });
  }

  /** The feature at an id-buffer index, if its tile has loaded. */
  feature(index: number): FeatureInfo | undefined {
    return index > 0 ? this.features[index - 1] : undefined;
  }

  /** A feature id's index in the id buffer, or 0 if no loaded tile has it yet. */
  indexOf(id: string): number {
    return this.indices.get(id) ?? 0;
  }

  /** A loaded feature by its id. */
  featureById(id: string): FeatureInfo | undefined {
    return this.feature(this.indexOf(id));
  }

  isPending(key: string) {
    return this.pending.has(key);
  }

  /** Tiles requested from the worker and not yet answered. */
  get pendingCount() {
    return this.pending.size;
  }

  /** Mean decode time of the last tiles decoded, in ms (0 before any). */
  get decodeMsAverage() {
    const n = this.decodeTimes.length;
    return n === 0 ? 0 : this.decodeTimes.reduce((a, b) => a + b, 0) / n;
  }

  request(tile: TileId) {
    const key = tileKey(tile);
    if (this.pending.has(key)) return;
    this.pending.add(key);
    this.post({ type: 'tile', key, ...tile });
  }

  destroy() {
    this.worker.terminate();
  }

  private post(request: WorkerRequest) {
    this.worker.postMessage(request);
  }
}
