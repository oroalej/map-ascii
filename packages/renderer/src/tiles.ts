/** Tile selection, the tile cache, and the client side of the tile worker. */
import type { BBox, CameraState } from '@atlas/shared';
import { project, TILE_SIZE, type Size } from './camera';
import type { FeatureInfo, TileGeometry } from './raster/geometry';
import type { ResidentialSites } from './fireworks-sites';

export type TileId = { z: number; x: number; y: number };

export type TileHeader = {
  minZoom: number;
  maxZoom: number;
  /** Where the archive has data: [west, south, east, north]. */
  bounds: BBox;
};

export type WorkerRequest =
  | { type: 'init'; url: string; fireworks?: boolean; fireworksActive?: boolean }
  | { type: 'fireworks'; active: boolean }
  | { type: 'tile' | 'residential'; key: string; z: number; x: number; y: number };

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

export type ResidentialResponse = {
  type: 'residential';
  key: string;
  sites: ResidentialSites;
  newFeatures: FeatureInfo[];
};

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

export const RESIDENTIAL_ZOOM = 12;
export const RESIDENTIAL_TILE_LIMIT = 16;
/** Bounded building coverage for a cold coarse view; include its center and spread remaining requests. */
export function residentialCoverageTiles(
  camera: CameraState,
  size: Size,
  header: TileHeader,
): TileId[] {
  const z = clamp(RESIDENTIAL_ZOOM, header.minZoom, header.maxZoom);
  const [cx, cy] = project(camera.lng, camera.lat, z);
  const scale = 2 ** (z - camera.zoom);
  const [west, south, east, north] = header.bounds;
  const [ax, ay] = tileAt(west, north, z),
    [bx, by] = tileAt(east, south, z);
  const x0 = Math.max(ax, Math.floor((cx - (size.width * scale) / 2) / TILE_SIZE));
  const x1 = Math.min(bx, Math.floor((cx + (size.width * scale) / 2) / TILE_SIZE));
  const y0 = Math.max(ay, Math.floor((cy - (size.height * scale) / 2) / TILE_SIZE));
  const y1 = Math.min(by, Math.floor((cy + (size.height * scale) / 2) / TILE_SIZE));
  if (x0 > x1 || y0 > y1) return [];
  const tiles: TileId[] = [];
  const nx = Math.min(4, x1 - x0 + 1),
    ny = Math.min(4, y1 - y0 + 1);
  for (let y = 0; y < ny; y++)
    for (let x = 0; x < nx; x++)
      tiles.push({
        z,
        x: x0 + Math.floor(((x + 0.5) * (x1 - x0 + 1)) / nx),
        y: y0 + Math.floor(((y + 0.5) * (y1 - y0 + 1)) / ny),
      });
  const center = {
    z,
    x: clamp(Math.floor(cx / TILE_SIZE), x0, x1),
    y: clamp(Math.floor(cy / TILE_SIZE), y0, y1),
  };
  if (!tiles.some((tile) => tile.x === center.x && tile.y === center.y)) tiles.push(center);
  const distance = (tile: TileId) =>
    (tile.x + 0.5 - cx / TILE_SIZE) ** 2 + (tile.y + 0.5 - cy / TILE_SIZE) ** 2;
  return tiles.sort((a, b) => distance(a) - distance(b)).slice(0, RESIDENTIAL_TILE_LIMIT);
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
  residential?: (key: string, sites: ResidentialSites) => void;
};

/** How many recent tile decodes `decodeMsAverage` covers. */
const DECODE_SAMPLES = 50;

/** At most this many tile requests are at the worker at once; the rest wait their turn. */
export const MAX_IN_FLIGHT = 6;

/** Who wants a tile: the region's coarser tiles go before the view's own. */
export type RequestGroup = 'region' | 'view' | 'fireworks';
const requestKey = (tile: TileId, group: RequestGroup) =>
  group === 'fireworks' ? `residential/${tileKey(tile)}` : tileKey(tile);

/**
 * Tile requests: at most `max` at the worker at once, the rest queued in the order they are
 * wanted. Each group's queue is replaced whenever it is wanted again, so tiles the view has
 * moved past (the zooms a fly-to passes through) are dropped before they are asked for.
 */
export class RequestQueue {
  private readonly inFlight = new Set<string>();
  private readonly queues: Record<RequestGroup, TileId[]> = { region: [], view: [], fireworks: [] };

  constructor(
    private readonly send: (tile: TileId, key: string, group: RequestGroup) => void,
    private readonly max = MAX_IN_FLIGHT,
  ) {}

  /** The tiles `group` needs now, most wanted first: they replace its queue. */
  want(tiles: readonly TileId[], group: RequestGroup) {
    this.queues[group] = tiles.filter((t) => !this.inFlight.has(requestKey(t, group)));
    this.pump();
  }

  /** The worker answered for `key` (a tile or an error): the next one can go. */
  done(key: string) {
    if (this.inFlight.delete(key)) this.pump();
  }

  /** Whether `key` is queued or at the worker. */
  has(key: string) {
    return (
      this.inFlight.has(key) ||
      (['region', 'view', 'fireworks'] as const).some((group) =>
        this.queues[group].some((t) => requestKey(t, group) === key),
      )
    );
  }

  /** Requests queued or at the worker. */
  get size() {
    return (
      this.inFlight.size +
      this.queues.region.length +
      this.queues.view.length +
      this.queues.fireworks.length
    );
  }

  private pump() {
    while (this.inFlight.size < this.max) {
      const group = (['region', 'view', 'fireworks'] as const).find(
        (group) => this.queues[group].length > 0,
      );
      if (!group) return;
      const tile = this.queues[group].shift();
      if (!tile) return;
      const key = requestKey(tile, group);
      if (this.inFlight.has(key)) continue;
      this.inFlight.add(key);
      this.send(tile, key, group);
    }
  }
}

/** Requests tiles from the worker and tracks the feature id strings it registers. */
export class TileSource {
  /** Features by index - 1 (the id buffer stores the index; 0 = none). */
  private readonly features: FeatureInfo[] = [];
  /** Feature id string → index. */
  private readonly indices = new Map<string, number>();
  private readonly requests: RequestQueue;
  private readonly worker: Worker;
  /** Decode times of the most recent tiles, for `decodeMsAverage`. */
  private readonly decodeTimes: number[] = [];
  private fireworksActive: boolean;

  constructor(
    url: string,
    handlers: TileSourceHandlers,
    private readonly fireworks = false,
    active = false,
  ) {
    this.fireworksActive = fireworks && active;
    this.requests = new RequestQueue((tile, key, group) =>
      this.post({ type: group === 'fireworks' ? 'residential' : 'tile', key, ...tile }),
    );
    this.worker = new Worker(new URL('./tiles.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<WorkerResponse | ResidentialResponse>) => {
      const message = event.data;
      if (message.type === 'header') {
        handlers.header(message.header);
      } else if (message.type === 'tile' || message.type === 'residential') {
        this.requests.done(message.key);
        if (message.type === 'tile' && message.decodeMs !== undefined) {
          this.decodeTimes.push(message.decodeMs);
          if (this.decodeTimes.length > DECODE_SAMPLES) this.decodeTimes.shift();
        }
        for (const info of message.newFeatures) {
          this.features.push(info);
          this.indices.set(info.id, this.features.length);
        }
        if (message.type === 'tile') handlers.tile(message.key, message.geometry);
        else handlers.residential?.(message.key, message.sites);
      } else {
        handlers.error(message.message, message.key);
        if (message.key) this.requests.done(message.key);
      }
    };
    this.post({ type: 'init', url, fireworks, fireworksActive: this.fireworksActive });
  }

  setFireworksActive(active: boolean) {
    active &&= this.fireworks;
    if (active === this.fireworksActive) return;
    this.fireworksActive = active;
    this.post({ type: 'fireworks', active });
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
    return this.requests.has(key);
  }

  /** Tiles wanted and not yet answered: queued, or at the worker. */
  get pendingCount() {
    return this.requests.size;
  }

  /** Mean decode time of the last tiles decoded, in ms (0 before any). */
  get decodeMsAverage() {
    const n = this.decodeTimes.length;
    return n === 0 ? 0 : this.decodeTimes.reduce((a, b) => a + b, 0) / n;
  }

  /** The tiles `group` needs now, most wanted first (`RequestQueue.want`). */
  want(tiles: readonly TileId[], group: RequestGroup) {
    this.requests.want(tiles, group);
  }

  destroy() {
    this.worker.terminate();
  }

  private post(request: WorkerRequest) {
    this.worker.postMessage(request);
  }
}
