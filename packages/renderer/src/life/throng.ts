/**
 * Ownerless crowd raster candidates: no population, owners, inspection or worker agents.
 *
 * Crowd geography is classified once per event on a fixed metric lattice (the field), in
 * chunks prepared within a per-frame time budget, visible chunks first. A zoom or pan only
 * projects the prepared field onto the current cells; moving events then only recompute
 * membership as the formation advances. With a worker pool (`throng-pool.ts`), chunks are
 * classified and terrain-checked off the main thread, several at once.
 */
import { localMetricProjection, PROCESSION_GEOMETRY, type ProcessionRoute } from '@atlas/shared';
import type { GridPlacement } from '../grid';
import type { TileId } from '../tiles';
import { project, unproject, TILE_SIZE } from '../camera';
import { MERCATOR_METERS } from '../raster/geometry';
import type { VisibleAgent } from './simulate';
import {
  eventGroundBounds,
  groundForRoute,
  type EventGround,
  streetSidewalks,
} from './ground-events';
import { CrowdMaskRaster, THRONG_MASK_WORDS } from './crowd-mask';
export { THRONG_MASK_SIDE } from './crowd-mask';
import { formationLayout } from './formation-layout';
import { PROCESSION, routePolyline } from './procession';
import { ProcessionGlyph } from './procession-glyphs';
import { figureFit } from './people';
export const MAX_THRONG_CELLS = 16000;
/** Lattice pitch of the zoom-independent crowd field, m. */
export const THRONG_FIELD_PITCH_M = 1;
/** Lattice points per field chunk side; a chunk is classified and terrain-checked at once. */
export const THRONG_FIELD_CHUNK = 32;
/** Field preparation per call, ms: visible chunks first, then the rest of the event. */
export const THRONG_FIELD_BUDGET_MS = 3;
/** Coarse cells sample at most this many points per side, at least this far apart (m). */
const COARSE_SAMPLES = 8,
  COARSE_SPACING_M = 1.5;
/** Shared figure ink quantizes facing to this many directions (`draw.ts`). */
export const THRONG_HEADINGS = 8;
const CHUNK = THRONG_FIELD_CHUNK,
  CHUNK_POINTS = CHUNK * CHUNK,
  BLOCK = 4;
// Field point bits: ground permission, then street classification (`classify`) shifted.
const STANDING = 1,
  SEATED = 2,
  FLAG_SHIFT = 2;
export type ThrongCell = {
  col: number;
  row: number;
  agent: VisibleAgent;
  mask?: Uint32Array;
  hash: number;
  /** Shared figure ink identity (paint, flap, candle, seated, facing); detailed cells only. */
  look?: number;
  /** Whole-figure admission, cached for one ink and field version. */
  permitted?: boolean;
  permitInk?: object;
  permitVersion?: number;
};
/** Cells per metre of the shared ink frame, quantized so nearby zooms reuse figure ink. */
export type ThrongInkScale = { x: number; y: number; key: string };
export type ThrongPayload = {
  cells: ThrongCell[];
  cap: number;
  pending?: boolean;
  stampPending?: boolean;
  ink?: ThrongInkScale;
  /** Field ground and terrain permission of one view cell for a detailed figure's texel. */
  allows?: (agent: VisibleAgent, col: number, row: number) => boolean;
  version?: number;
  /**
   * Cells (relative to the grid) a figure must stay inside, when the grid has a pan margin:
   * admission and the cap see only the cells the screen draws from.
   */
  clip?: { left: number; top: number; right: number; bottom: number };
};
type Point = [number, number];
type Guard = ((agent: VisibleAgent, col: number, row: number) => boolean) & {
  terrainKey?: object;
  hardTerrainKey?: object;
  /** The terrain's tile frame, so a worker can rebuild the same guard. */
  terrainRef?: { tile: TileId; perMeter: number };
};
/** Builds a terrain guard over the field lattice (whole 1 m lattice cells). */
export type ThrongGuardFactory = (
  toCell: (lng: number, lat: number) => [number, number],
) => Guard | undefined;
/** Prepares field chunks off the main thread; results arrive through `acceptFieldChunk`. */
export interface ThrongFieldPool {
  readonly alive: boolean;
  /** Whether a worker can rebuild this guard (its terrain can be sent). */
  accepts(guard: Guard | undefined): boolean;
  /** Queues one chunk; false while every worker is busy. */
  submit(event: ProcessionRoute, index: number, guard: Guard | undefined): boolean;
}
/** A prepared chunk's arrays, as a worker returns them. */
export type ThrongFieldChunk = {
  kind: Uint8Array;
  blocks: Uint8Array;
  heading: Uint8Array;
  along?: Float32Array;
  clear?: Uint8Array;
};
type RouteIndex = {
  frame: ReturnType<typeof localMetricProjection>;
  line: ReturnType<typeof routePolyline>;
  bins: Map<number, Map<number, number[]>>;
  visited: Uint32Array;
  epoch: number;
  origin: Point;
  kx: number;
  ky: number;
  segments: { x: number; y: number; dx: number; dy: number; length: number; along: number }[];
  nearest: {
    s: number;
    off: number;
    segment: number;
    target: Point;
    distance2: number;
    x: number;
    y: number;
  };
};
const routes = new WeakMap<ProcessionRoute, RouteIndex>();
const mix = (x: number, y: number) => {
  let h = Math.imul(x, 0x1f123bb5) ^ Math.imul(y, 0x5f356495);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return (h ^ (h >>> 16)) >>> 0;
};
function routeIndex(event: Exclude<ProcessionRoute, { kind: 'mass' }>) {
  let index = routes.get(event);
  if (index) return index;
  const frame = localMetricProjection(event.route[0]!),
    line = routePolyline(event.route.map(frame.to)),
    bins: RouteIndex['bins'] = new Map();
  for (let i = 1; i < line.points.length; i++) {
    const a = line.points[i - 1]!,
      b = line.points[i]!;
    for (
      let y = Math.floor(Math.min(a[1], b[1]) / 32);
      y <= Math.floor(Math.max(a[1], b[1]) / 32);
      y++
    )
      for (
        let x = Math.floor(Math.min(a[0], b[0]) / 32);
        x <= Math.floor(Math.max(a[0], b[0]) / 32);
        x++
      ) {
        let column = bins.get(x);
        if (!column) bins.set(x, (column = new Map<number, number[]>()));
        let ids = column.get(y);
        if (!ids) column.set(y, (ids = []));
        ids.push(i - 1);
      }
  }
  const origin = event.route[0]!;
  const segments = line.points.slice(1).map((b, i) => {
    const a = line.points[i]!,
      dx = b[0] - a[0],
      dy = b[1] - a[1];
    return { x: a[0], y: a[1], dx, dy, length: Math.hypot(dx, dy), along: line.along[i]! };
  });
  routes.set(
    event,
    (index = {
      frame,
      line,
      bins,
      origin,
      kx: frame.to([origin[0] + 1, origin[1]])[0],
      ky: frame.to([origin[0], origin[1] + 1])[1],
      visited: new Uint32Array(segments.length),
      epoch: 0,
      segments,
      nearest: { s: 0, off: 0, segment: -1, target: [0, 0], distance2: Infinity, x: 0, y: 0 },
    }),
  );
  return index;
}
function visitSegment(index: RouteIndex, i: number, x: number, y: number) {
  if (index.visited[i] === index.epoch) return;
  index.visited[i] = index.epoch;
  const a = index.segments[i]!;
  if (!a.length) return;
  const u = Math.max(0, Math.min(1, ((x - a.x) * a.dx + (y - a.y) * a.dy) / (a.length * a.length)));
  const px = a.x + u * a.dx,
    py = a.y + u * a.dy,
    distance2 = (x - px) ** 2 + (y - py) ** 2;
  const result = index.nearest;
  if (distance2 < result.distance2) {
    result.distance2 = distance2;
    result.s = a.along + u * a.length;
    result.off = ((y - py) * a.dx - (x - px) * a.dy) / a.length;
    result.segment = i;
    result.x = px;
    result.y = py;
  }
}
function nearest(index: RouteIndex, point: Point) {
  const x = (point[0] - index.origin[0]) * index.kx,
    y = (point[1] - index.origin[1]) * index.ky;
  const bx = Math.floor(x / 32),
    by = Math.floor(y / 32);
  const result = index.nearest;
  result.distance2 = Infinity;
  result.segment = -1;
  result.s = result.off = 0;
  index.epoch = (index.epoch + 1) >>> 0;
  if (!index.epoch) {
    index.visited.fill(0);
    index.epoch = 1;
  }
  if (index.segments.length === 1) visitSegment(index, 0, x, y);
  else {
    for (let cx = bx - 1; cx <= bx + 1; cx++) {
      const column = index.bins.get(cx);
      if (!column) continue;
      for (let cy = by - 1; cy <= by + 1; cy++) {
        const ids = column.get(cy);
        if (ids) for (const i of ids) visitSegment(index, i, x, y);
      }
    }
    // The searched square bounds every unvisited segment; distant areas use an exact fallback.
    const edge = Math.min(
      x - (bx - 1) * 32,
      (bx + 2) * 32 - x,
      y - (by - 1) * 32,
      (by + 2) * 32 - y,
    );
    if (result.distance2 > edge * edge)
      for (let i = 0; i < index.segments.length; i++) visitSegment(index, i, x, y);
  }
  // Facing towards the route (fluvial banks), in the route's metric frame.
  result.target[0] = result.x - x;
  result.target[1] = result.y - y;
  return result;
}
function classify(
  event: Exclude<ProcessionRoute, { kind: 'mass' | 'fluvial' }>,
  near: ReturnType<typeof nearest>,
  area: boolean,
  blockWidth: number,
) {
  const segment = event.segments[near.segment];
  if (!segment) return area ? 1 : 0;
  const half = segment.width_m / 2,
    side = near.off > 0 ? 'left' : 'right';
  const verge = Math.max(streetSidewalks(segment)[side], segment.verge_m?.[side] ?? 0);
  return (
    (area || (Math.abs(near.off) > half && Math.abs(near.off) <= half + verge) ? 1 : 0) |
    (Math.abs(near.off) <= half ? 2 : 0) |
    (Math.abs(near.off) < blockWidth ? 4 : 0)
  );
}
const densityScratch: [number, number] = [0, 0];
/**
 * Membership density of one street point `back` metres behind the formation's head. A
 * procession's crowd travels with the images: spectators gather ahead of the head, walk
 * beside and behind it, and thin out once it has passed; the stream fills the road behind.
 */
export function movingDensity(
  event: ProcessionRoute,
  back: number,
  flags: number,
  layout: ReturnType<typeof formationLayout> | undefined,
  paint: number,
): [number, number] {
  const t = PROCESSION.throng;
  let density = 0;
  if (flags & 1)
    density =
      event.kind !== 'procession'
        ? t.verge
        : back < -layout!.leading
          ? // Waiting spectators: denser where the images will arrive next.
            Math.max(
              t.waiting,
              t.verge - ((-layout!.leading - back) / t.gather) * (t.verge - t.waiting),
            )
          : back <= layout!.tail
            ? t.stream
            : // Passed: most devotees have joined the stream, a few remain.
              Math.max(t.passed, t.tail - ((back - layout!.tail) / t.gather) * (t.tail - t.passed));
  if (flags & 2) {
    if (event.kind === 'procession' && back >= -layout!.leading && back <= layout!.tail)
      density =
        back <= Math.min(t.streamLength, layout!.tail) ? t.stream : Math.max(density, t.tail);
    if (event.kind === 'parade' && flags & 4) {
      let lo = 0,
        hi = layout!.blocks.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (layout!.blocks[mid]!.back <= back) lo = mid + 1;
        else hi = mid;
      }
      const block = layout!.blocks[lo - 1];
      if (block && back <= block.back + block.length) {
        density = 0.98;
        paint = block.paint;
      }
    }
  }
  densityScratch[0] = density;
  densityScratch[1] = paint;
  return densityScratch;
}

type FieldChunk = {
  /** Order of the terrain this chunk was checked against, for worker results. */
  seq?: number;
  kind: Uint8Array;
  /** 8×8 blocks of 4×4 points: 1 where any point has ground (coarse cells skip the rest). */
  blocks: Uint8Array;
  heading: Uint8Array;
  along?: Float32Array;
  /** 1 where the accepted terrain leaves the lattice point clear; absent without a guard. */
  clear?: Uint8Array;
  terrain?: object;
  hardTerrain?: object;
};
/** Growable static cell columns (struct of arrays): no object per cell until it is drawn. */
class StaticCells {
  n = 0;
  col = new Int32Array(256);
  row = new Int32Array(256);
  hash = new Uint32Array(256);
  kind = new Uint8Array(256);
  heading = new Uint8Array(256);
  s = new Float32Array(256);
  dist = new Float32Array(256);
  /** Coarse street cells: sample counts, then summed `along`, per classification. */
  classes?: Float64Array;
  masks?: Uint32Array;
  agents: (VisibleAgent | undefined)[] = [];
  cells: (ThrongCell | undefined)[] = [];
  push(col: number, row: number, kind: number, heading: number, s: number, dist: number) {
    if (this.n === this.col.length) {
      const grow = <T extends Int32Array | Uint32Array | Uint8Array | Float32Array>(a: T): T => {
        const b = new (a.constructor as new (n: number) => T)(a.length * 2);
        b.set(a);
        return b;
      };
      this.col = grow(this.col);
      this.row = grow(this.row);
      this.hash = grow(this.hash);
      this.kind = grow(this.kind);
      this.heading = grow(this.heading);
      this.s = grow(this.s);
      this.dist = grow(this.dist);
      if (this.classes) {
        const classes = new Float64Array(this.classes.length * 2);
        classes.set(this.classes);
        this.classes = classes;
      }
      if (this.masks) {
        const masks = new Uint32Array(this.masks.length * 2);
        masks.set(this.masks);
        this.masks = masks;
      }
    }
    const i = this.n++;
    this.col[i] = col;
    this.row[i] = row;
    this.hash[i] = mix(col, row);
    this.kind[i] = kind;
    this.heading[i] = heading;
    this.s[i] = s;
    this.dist[i] = dist;
    return i;
  }
}
/** Static cells of one zoom, in absolute cells over a window wider than the view. */
type ViewCache = {
  key: number[];
  version: number;
  terrainVersion: number;
  /** Absolute cell window: inclusive left/top, exclusive right/bottom. */
  window: readonly [number, number, number, number];
  fine: boolean;
  cells: StaticCells;
  pending: boolean;
  ink?: ThrongInkScale;
  /** Lattice coordinates of absolute cell positions. */
  toI: (col: number, row: number) => number;
  toJ: (col: number, row: number) => number;
  /** Linear lattice → lng/lat about the window's centre (exact in longitude). */
  lng0: number;
  lngPerI: number;
  lat0: number;
  latPerJ: number;
  j0: number;
  dynamic?: { at: number[]; progress: number; quality: number; result: ThrongPayload };
};
type Field = {
  event: ProcessionRoute;
  ground: EventGround;
  /** Zoom-zero world pixels of lattice corner (0, 0), and per lattice step. */
  x0: number;
  y0: number;
  unit: number;
  width: number;
  height: number;
  cw: number;
  ch: number;
  chunks: (FieldChunk | null | undefined)[];
  cursor: number;
  /** Chunks a worker is preparing, by the terrain they were requested with. */
  inflight: Map<number, object>;
  /** Bumped by any preparation; `terrainVersion` only by rechecks of prepared chunks. */
  version: number;
  terrainVersion: number;
  /** The previous call's projection key; a zoom in progress skips the pan margin. */
  lastKey?: number[];
  raster: CrowdMaskRaster;
  seated?: CrowdMaskRaster;
  area?: CrowdMaskRaster;
  toLattice: (lng: number, lat: number) => [number, number];
  /** Lattice coordinates a Mass faces and fills from. */
  facing?: Point;
  views: ViewCache[];
};
const fields = new WeakMap<ProcessionRoute, Field>();
const now = () => globalThis.performance?.now() ?? Date.now();
function fieldFor(event: ProcessionRoute): Field {
  let field = fields.get(event);
  if (field) return field;
  const ground = groundForRoute(event),
    standing = eventGroundBounds(ground),
    seated = ground.seated && eventGroundBounds(ground.seated);
  // Seated grounds may extend beyond the standing ones.
  const bounds = seated?.every(Number.isFinite)
    ? [
        Math.min(standing[0], seated[0]),
        Math.min(standing[1], seated[1]),
        Math.max(standing[2], seated[2]),
        Math.max(standing[3], seated[3]),
      ]
    : standing;
  const empty = !bounds.every(Number.isFinite);
  const lat0 = empty ? 0 : (bounds[1] + bounds[3]) / 2;
  const unit =
    (THRONG_FIELD_PITCH_M * TILE_SIZE) / (MERCATOR_METERS * Math.cos((lat0 * Math.PI) / 180));
  const [west, north] = empty ? [0, 0] : project(bounds[0], bounds[3], 0),
    [east, south] = empty ? [0, 0] : project(bounds[2], bounds[1], 0);
  const x0 = west - unit,
    y0 = north - unit;
  const width = empty ? 0 : Math.ceil((east - west) / unit) + 2,
    height = empty ? 0 : Math.ceil((south - north) / unit) + 2;
  const fromLattice = (i: number, j: number) => unproject(x0 + i * unit, y0 + j * unit, 0);
  const raster = (g: EventGround) => new CrowdMaskRaster(g, fromLattice, 0, 0, 1);
  const toLattice = (lng: number, lat: number): [number, number] => {
    const [x, y] = project(lng, lat, 0);
    return [(x - x0) / unit, (y - y0) / unit];
  };
  const areaGround =
    (event.kind === 'procession' || event.kind === 'parade') && event.crowd_grounds?.length
      ? {
          regions: event.crowd_grounds,
          blocked: ground.blocked,
          water: ground.water,
          bridges: ground.bridges,
        }
      : undefined;
  const cw = Math.ceil(width / CHUNK),
    ch = Math.ceil(height / CHUNK);
  field = {
    event,
    ground,
    x0,
    y0,
    unit,
    width,
    height,
    cw,
    ch,
    chunks: new Array<FieldChunk | null | undefined>(cw * ch),
    cursor: 0,
    inflight: new Map(),
    version: 0,
    terrainVersion: 0,
    raster: raster(ground),
    seated: ground.seated?.regions.length ? raster(ground.seated) : undefined,
    area: areaGround && raster(areaGround),
    toLattice,
    facing:
      event.kind === 'mass'
        ? toLattice(...(event.site.altar?.at ?? event.site.location))
        : undefined,
    views: [],
  };
  fields.set(event, field);
  return field;
}
const headingByte = (x: number, y: number) =>
  Math.round((Math.atan2(y, x) / (2 * Math.PI)) * 256) & 255;
function buildChunk(field: Field, index: number) {
  const { event } = field;
  const cx = index % field.cw,
    cy = Math.floor(index / field.cw);
  const street = event.kind === 'procession' || event.kind === 'parade';
  const route = event.kind === 'mass' ? undefined : routeIndex(event);
  const layout = street ? formationLayout(event) : undefined;
  const blockWidth = layout
    ? (((layout.blocks[0]?.columns ?? layout.columns) - 1) * PROCESSION_GEOMETRY.columnPitch) / 2 +
      PROCESSION_GEOMETRY.person.width / 2
    : 0;
  const facing =
    event.kind === 'mass'
      ? localMetricProjection(event.site.altar?.at ?? event.site.location)
      : undefined;
  let chunk: FieldChunk | undefined;
  const point: Point = [0, 0];
  for (let r = 0; r < CHUNK; r++) {
    const j = cy * CHUNK + r;
    if (j >= field.height) break;
    for (let c = 0; c < CHUNK; c++) {
      const i = cx * CHUNK + c;
      if (i >= field.width) break;
      const seated = !!field.seated?.has(i, j);
      if (!seated && !field.raster.has(i, j)) continue;
      chunk ??= {
        kind: new Uint8Array(CHUNK_POINTS),
        blocks: new Uint8Array((CHUNK / BLOCK) ** 2),
        heading: new Uint8Array(CHUNK_POINTS),
        along: street ? new Float32Array(CHUNK_POINTS) : undefined,
      };
      const k = r * CHUNK + c;
      field.raster.point(i, j, 0, point);
      let bits = seated ? SEATED : STANDING;
      if (facing) {
        const to = facing.to(point);
        chunk.heading[k] = headingByte(-to[0], -to[1]);
      } else {
        const near = nearest(route!, point);
        if (street) {
          bits |= classify(event, near, !!field.area?.has(i, j), blockWidth) << FLAG_SHIFT;
          chunk.along![k] = near.s;
          const h = route!.line.at(near.s);
          chunk.heading[k] = headingByte(h.hx, h.hy);
        } else chunk.heading[k] = headingByte(near.target[0], near.target[1]);
      }
      chunk.kind[k] = bits;
      chunk.blocks[Math.floor(r / BLOCK) * (CHUNK / BLOCK) + Math.floor(c / BLOCK)] = 1;
    }
  }
  field.chunks[index] = chunk ?? null;
}
const standingProbe: VisibleAgent = { kind: 'person', lng: 0, lat: 0, flap: 0 },
  seatedProbe: VisibleAgent = { kind: 'person', lng: 0, lat: 0, flap: 0, eventRole: 'seated' };
function checkTerrain(field: Field, index: number, guard: Guard, terrain: object, hard: object) {
  const chunk = field.chunks[index];
  if (!chunk) return;
  const cx = index % field.cw,
    cy = Math.floor(index / field.cw);
  const clear = chunk.clear ?? new Uint8Array(CHUNK_POINTS);
  standingProbe.eventGround = seatedProbe.eventGround = field.event.id;
  for (let k = 0; k < CHUNK_POINTS; k++) {
    const kind = chunk.kind[k]!;
    if (!kind) continue;
    clear[k] = guard(
      kind & SEATED ? seatedProbe : standingProbe,
      cx * CHUNK + (k % CHUNK),
      cy * CHUNK + Math.floor(k / CHUNK),
    )
      ? 1
      : 0;
  }
  chunk.clear = clear;
  chunk.terrain = terrain;
  chunk.hardTerrain = hard;
}
/** In-flight marker of chunks requested without a terrain guard. */
const NO_TERRAIN = {};
/**
 * Classify unprepared visible chunks nearest the view centre first, recheck stale terrain,
 * then continue with the rest of the event. Returns whether visible work remains. A worker
 * pool takes the same chunks in the same order, and the frame only waits for its results.
 */
function prepare(
  field: Field,
  guard: Guard | undefined,
  rect: readonly [number, number, number, number],
  budgetMs: number,
  pool?: ThrongFieldPool,
) {
  const deadline = budgetMs === Infinity ? Infinity : now() + budgetMs;
  const terrain = guard && (guard.terrainKey ?? guard),
    hard = guard && (guard.hardTerrainKey ?? guard);
  const stale = (chunk: FieldChunk) =>
    !!guard && (chunk.terrain !== terrain || chunk.hardTerrain !== hard);
  const [x0, y0, x1, y1] = rect;
  const mx = (x0 + x1) / 2,
    my = (y0 + y1) / 2;
  const visible: number[] = [];
  for (let cy = y0; cy <= y1; cy++)
    for (let cx = x0; cx <= x1; cx++) {
      const index = cy * field.cw + cx,
        chunk = field.chunks[index];
      if (chunk === undefined || (chunk && stale(chunk))) visible.push(index);
    }
  visible.sort((a, b) => {
    const da = ((a % field.cw) - mx) ** 2 + (Math.floor(a / field.cw) - my) ** 2,
      db = ((b % field.cw) - mx) ** 2 + (Math.floor(b / field.cw) - my) ** 2;
    return da - db;
  });
  if (pool?.alive && pool.accepts(guard)) {
    const requested = terrain ?? NO_TERRAIN;
    const ask = (index: number) => {
      if (field.inflight.get(index) === requested) return true;
      if (!pool.submit(field.event, index, guard)) return false;
      field.inflight.set(index, requested);
      return true;
    };
    for (const index of visible) if (!ask(index)) return true;
    while (field.cursor < field.chunks.length) {
      const index = field.cursor;
      if (field.chunks[index] === undefined && !field.inflight.has(index) && !ask(index)) break;
      field.cursor++;
    }
    return visible.length > 0;
  }
  let worked = false,
    pending = false;
  const unit = (index: number) => {
    if (field.chunks[index] === undefined) buildChunk(field, index);
    else field.terrainVersion++;
    if (guard) checkTerrain(field, index, guard, terrain!, hard!);
    field.version++;
    worked = true;
  };
  for (const index of visible) {
    if (worked && now() > deadline) {
      pending = true;
      break;
    }
    unit(index);
  }
  while (!pending && field.cursor < field.chunks.length && now() <= deadline) {
    const index = field.cursor++;
    if (field.chunks[index] === undefined) unit(index);
  }
  return pending;
}

/**
 * Worker side: classify one chunk of `event` and check it against the guard's terrain. The
 * worker keeps no chunks; the main thread installs the result with `acceptFieldChunk`.
 */
export function buildFieldChunk(
  event: ProcessionRoute,
  index: number,
  guardFor?: ThrongGuardFactory,
): ThrongFieldChunk | null {
  const field = fieldFor(event);
  if (index < 0 || index >= field.chunks.length) return null;
  buildChunk(field, index);
  const guard = guardFor?.(field.toLattice);
  if (guard) checkTerrain(field, index, guard, guard, guard);
  const chunk = field.chunks[index];
  field.chunks[index] = undefined;
  if (!chunk) return null;
  return {
    kind: chunk.kind,
    blocks: chunk.blocks,
    heading: chunk.heading,
    ...(chunk.along && { along: chunk.along }),
    ...(chunk.clear && { clear: chunk.clear }),
  };
}
/**
 * Main side: install a worker's chunk, checked against `terrain`/`hard` (the guard's keys)
 * as the `seq`-th terrain. An older terrain's result never replaces a newer one.
 */
export function acceptFieldChunk(
  event: ProcessionRoute,
  index: number,
  result: ThrongFieldChunk | null,
  terrain: object | undefined,
  hard: object | undefined,
  seq: number,
) {
  const field = fields.get(event);
  if (!field || index < 0 || index >= field.chunks.length) return;
  if (field.inflight.get(index) === (terrain ?? NO_TERRAIN)) field.inflight.delete(index);
  const prior = field.chunks[index];
  if (prior && (prior.seq ?? -1) > seq) return;
  const chunk: FieldChunk | null = result && {
    ...result,
    seq,
    ...(terrain && { terrain, hardTerrain: hard }),
  };
  if (prior !== undefined) field.terrainVersion++;
  field.chunks[index] = chunk;
  field.version++;
}
/** Main side: a worker failed to prepare this chunk; it is requested again. */
export function abandonFieldChunk(event: ProcessionRoute, index: number) {
  const field = fields.get(event);
  if (!field) return;
  field.inflight.delete(index);
  field.cursor = Math.min(field.cursor, index);
}

const sampled = { chunk: undefined as FieldChunk | undefined, k: 0 };
/** Field kind at lattice coordinates, 0 outside the ground or where terrain blocks it. */
function sample(field: Field, fi: number, fj: number) {
  const i = Math.floor(fi),
    j = Math.floor(fj);
  if (i < 0 || j < 0 || i >= field.width || j >= field.height) return 0;
  const chunk = field.chunks[Math.floor(j / CHUNK) * field.cw + Math.floor(i / CHUNK)];
  if (!chunk) return 0;
  const k = (j % CHUNK) * CHUNK + (i % CHUNK);
  const kind = chunk.kind[k]!;
  if (!kind || (chunk.clear && !chunk.clear[k])) return 0;
  sampled.chunk = chunk;
  sampled.k = k;
  return kind;
}
/** Whether any field block in this lattice rectangle has ground. */
function occupied(field: Field, i0: number, j0: number, i1: number, j1: number) {
  const bi0 = Math.max(0, Math.floor(i0 / BLOCK)),
    bi1 = Math.min(Math.ceil(field.width / BLOCK) - 1, Math.floor(i1 / BLOCK)),
    bj0 = Math.max(0, Math.floor(j0 / BLOCK)),
    bj1 = Math.min(Math.ceil(field.height / BLOCK) - 1, Math.floor(j1 / BLOCK));
  const per = CHUNK / BLOCK;
  for (let bj = bj0; bj <= bj1; bj++)
    for (let bi = bi0; bi <= bi1; bi++) {
      const chunk = field.chunks[Math.floor(bj / per) * field.cw + Math.floor(bi / per)];
      if (chunk && chunk.blocks[(bj % per) * per + (bi % per)]) return true;
    }
  return false;
}
const sameClass = (a: number, b: number) => (a & (STANDING | SEATED)) === (b & (STANDING | SEATED));
let visitEpoch = 0;
let visits = new Uint32Array(0);
const bucketCounts = new Uint32Array(256);
const bucketOffsets = new Uint32Array(256);
const sortedCells: ThrongCell[] = [];
const weights = new Float64Array(16);
/** A detailed cell is admitted only where its corners share its centre's ground class. */
const FINE_CORNERS = [
  [0.05, 0.05],
  [0.95, 0.05],
  [0.05, 0.95],
  [0.95, 0.95],
] as const;
/** Static windows extend this share of the view beyond each edge, so pans only rebase. */
const WINDOW_MARGIN = 0.25;

/**
 * Project the prepared field onto absolute cells of one zoom: positions, ground classes,
 * masks. `affine` maps lattice coordinates to absolute cells: col = e + a·i + b·j.
 */
function staticView(
  field: Field,
  fine: boolean,
  key: number[],
  affine: readonly number[],
  window: readonly [number, number, number, number],
): ViewCache {
  const [a, b, c, d, e, f] = affine as [number, number, number, number, number, number];
  const det = a * d - b * c;
  // Lattice steps per cell step, along a row (col + 1) and down a column (row + 1).
  const iCol = d / det,
    jCol = -c / det,
    iRow = -b / det,
    jRow = a / det;
  const toI = (col: number, row: number) => (d * (col - e) - b * (row - f)) / det,
    toJ = (col: number, row: number) => (-c * (col - e) + a * (row - f)) / det;
  // Cells per metre east, quantized to a quarter octave: ink and stride are shared by
  // every nearby zoom.
  const scale = 2 ** (Math.round(Math.log2(Math.abs(a) / THRONG_FIELD_PITCH_M) * 4) / 4);
  // Cell aspect is fixed per cell size; round away projection noise.
  const aspect = Math.round((d / a) * 1000) / 1000;
  const ink: ThrongInkScale = { x: scale, y: scale * aspect, key: `${scale}/${aspect}` };
  const fit = figureFit('adult', scale * 0.6);
  const stride = !fine
    ? 1
    : fit === 'big'
      ? 2
      : fit === 'stamp'
        ? Math.max(3, Math.ceil(scale * 0.7))
        : 1;
  const [w0, h0, w1, h1] = window;
  const ci = toI((w0 + w1) / 2, (h0 + h1) / 2),
    cj = toJ((w0 + w1) / 2, (h0 + h1) / 2);
  const [lng0, lat0] = unproject(field.x0 + ci * field.unit, field.y0 + cj * field.unit, 0),
    [lng1, lat1] = unproject(field.x0 + (ci + 1) * field.unit, field.y0 + (cj + 1) * field.unit, 0);
  const cells = new StaticCells();
  const street = field.event.kind === 'procession' || field.event.kind === 'parade';
  if (!fine) {
    cells.masks = new Uint32Array(cells.col.length * THRONG_MASK_WORDS);
    if (street) cells.classes = new Float64Array(cells.col.length * 16);
  }
  const view: ViewCache = {
    key,
    version: field.version,
    terrainVersion: field.terrainVersion,
    window,
    fine,
    cells,
    pending: false,
    ink: fine ? ink : undefined,
    toI,
    toJ,
    lng0: lng0 - ci * (lng1 - lng0),
    lngPerI: lng1 - lng0,
    lat0,
    latPerJ: lat1 - lat0,
    j0: cj,
  };
  const cols = w1 - w0,
    rows = h1 - h0;
  const corners = [
    [toI(w0, h0), toJ(w0, h0)],
    [toI(w1, h0), toJ(w1, h0)],
    [toI(w0, h1), toJ(w0, h1)],
    [toI(w1, h1), toJ(w1, h1)],
  ];
  const cx0 = Math.max(0, Math.floor(Math.min(...corners.map((p) => p[0]!)) / CHUNK)),
    cx1 = Math.min(field.cw - 1, Math.floor(Math.max(...corners.map((p) => p[0]!)) / CHUNK)),
    cy0 = Math.max(0, Math.floor(Math.min(...corners.map((p) => p[1]!)) / CHUNK)),
    cy1 = Math.min(field.ch - 1, Math.floor(Math.max(...corners.map((p) => p[1]!)) / CHUNK));
  if (cx0 > cx1 || cy0 > cy1) return view;
  if (visits.length < cols * rows) visits = new Uint32Array(cols * rows);
  visitEpoch = (visitEpoch + 1) >>> 0;
  if (!visitEpoch) {
    visits.fill(0);
    visitEpoch = 1;
  }
  const facing = field.facing;
  const fx = facing?.[0] ?? 0,
    fy = facing?.[1] ?? 0;
  const anchor = (n: number) => ((n % stride) + stride) % stride === 0;
  // Samples per axis: a power of two (whole mask subcells each), no finer than the field.
  const samples = (meters: number) =>
    2 **
    Math.min(
      Math.log2(COARSE_SAMPLES),
      Math.max(1, Math.ceil(Math.log2(meters / COARSE_SPACING_M))),
    );
  const nx = samples(Math.hypot(iCol, jCol) * THRONG_FIELD_PITCH_M),
    ny = samples(Math.hypot(iRow, jRow) * THRONG_FIELD_PITCH_M);
  for (let cy = cy0; cy <= cy1; cy++)
    for (let cx = cx0; cx <= cx1; cx++) {
      const chunk = field.chunks[cy * field.cw + cx];
      if (chunk === undefined) view.pending = true;
      if (!chunk) continue;
      let minC = Infinity,
        maxC = -Infinity,
        minR = Infinity,
        maxR = -Infinity;
      for (let corner = 0; corner < 4; corner++) {
        const i = (cx + (corner & 1)) * CHUNK,
          j = (cy + (corner >> 1)) * CHUNK;
        const col = e + a * i + b * j,
          row = f + c * i + d * j;
        minC = Math.min(minC, col);
        maxC = Math.max(maxC, col);
        minR = Math.min(minR, row);
        maxR = Math.max(maxR, row);
      }
      const c0 = Math.max(w0, Math.floor(minC)),
        c1 = Math.min(w1 - 1, Math.floor(maxC)),
        rStart = Math.max(h0, Math.floor(minR)),
        rEnd = Math.min(h1 - 1, Math.floor(maxR));
      for (let row = rStart; row <= rEnd; row++) {
        if (fine && !anchor(row)) continue;
        // Lattice coordinates of this row's first cell corner; each cell adds (iCol, jCol).
        let ri = toI(c0, row),
          rj = toJ(c0, row);
        for (let col = c0; col <= c1; col++, ri += iCol, rj += jCol) {
          if (fine && !anchor(col)) continue;
          const at = (row - h0) * cols + (col - w0);
          if (visits[at] === visitEpoch) continue;
          visits[at] = visitEpoch;
          const mi = ri + (iCol + iRow) / 2,
            mj = rj + (jCol + jRow) / 2;
          const dist = facing ? Math.hypot(mi - fx, mj - fy) * THRONG_FIELD_PITCH_M : 0;
          if (fine) {
            const kind = sample(field, mi, mj);
            if (!kind) continue;
            const centre = sampled.chunk!,
              k = sampled.k;
            let whole = true;
            for (let p = 0; p < 4 && whole; p++) {
              const [u, v] = FINE_CORNERS[p]!;
              const other = sample(field, ri + u * iCol + v * iRow, rj + u * jCol + v * jRow);
              whole = !!other && sameClass(other, kind);
            }
            if (!whole) continue;
            cells.push(col, row, kind, centre.heading[k]!, centre.along?.[k] ?? 0, dist);
            continue;
          }
          if (
            !occupied(
              field,
              Math.min(ri, ri + iCol, ri + iRow, ri + iCol + iRow),
              Math.min(rj, rj + jCol, rj + jRow, rj + jCol + jRow),
              Math.max(ri, ri + iCol, ri + iRow, ri + iCol + iRow),
              Math.max(rj, rj + jCol, rj + jRow, rj + jCol + jRow),
            )
          )
            continue;
          let slot = -1,
            closest = Infinity;
          for (let sy = 0; sy < ny; sy++) {
            const v = (sy + 0.5) / ny;
            for (let sx = 0; sx < nx; sx++) {
              const u = (sx + 0.5) / nx;
              const found = sample(field, ri + u * iCol + v * iRow, rj + u * jCol + v * jRow);
              if (!found) continue;
              const distance = (u - 0.5) ** 2 + (v - 0.5) ** 2;
              if (slot < 0) {
                slot = cells.push(col, row, found, 0, 0, dist);
                cells.masks!.fill(0, slot * THRONG_MASK_WORDS, (slot + 1) * THRONG_MASK_WORDS);
                cells.classes?.fill(0, slot * 16, slot * 16 + 16);
              }
              if (distance < closest) {
                closest = distance;
                cells.kind[slot] = found;
                cells.heading[slot] = sampled.chunk!.heading[sampled.k]!;
              }
              const masks = cells.masks!;
              for (let y = sy * (16 / ny); y < (sy + 1) * (16 / ny); y++)
                for (let x = sx * (16 / nx); x < (sx + 1) * (16 / nx); x++) {
                  const bit = y * 16 + x;
                  masks[slot * THRONG_MASK_WORDS + (bit >>> 5)]! |= (1 << (bit & 31)) >>> 0;
                }
              if (street) {
                const flags = found >>> FLAG_SHIFT,
                  classes = cells.classes!;
                classes[slot * 16 + flags]!++;
                classes[slot * 16 + flags + 8]! += sampled.chunk!.along![sampled.k]!;
              }
            }
          }
        }
      }
    }
  return view;
}

/** One placement's lattice → view cell transform: [a, b, c, d, e, f], col = e + a·i + b·j. */
function affineFor(field: Field, grid: GridPlacement): number[] {
  const at = (i: number, j: number) =>
    grid.toCell(...unproject(field.x0 + i * field.unit, field.y0 + j * field.unit, 0));
  const span = Math.max(CHUNK, Math.min(field.width, field.height));
  const o = at(0, 0),
    x = at(span, 0),
    y = at(0, span);
  return [
    (x[0] - o[0]) / span,
    (y[0] - o[0]) / span,
    (x[1] - o[1]) / span,
    (y[1] - o[1]) / span,
    o[0],
    o[1],
  ];
}

/** A new figure's ownerless agent, positioned by the view's linear lattice map. */
function crowdAgent(
  view: ViewCache,
  cells: StaticCells,
  index: number,
  event: ProcessionRoute,
  paint: number,
  seated: boolean,
): VisibleAgent {
  const ci = view.toI(cells.col[index]! + 0.5, cells.row[index]! + 0.5),
    cj = view.toJ(cells.col[index]! + 0.5, cells.row[index]! + 0.5);
  const hash = cells.hash[index]!;
  const lng = view.lng0 + ci * view.lngPerI,
    lat = view.lat0 + (cj - view.j0) * view.latPerJ;
  if (!view.fine)
    return {
      kind: 'person',
      lng,
      lat,
      paint,
      flap: hash & 1,
      candle: (hash >>> 16) % 10 < 6,
      eventGround: event.id,
      prop: 'event',
      glyph: String.fromCharCode(ProcessionGlyph.crowd0.charCodeAt(0) + (hash % 4)),
    };
  const angle = (cells.heading[index]! / 256) * 2 * Math.PI,
    hx = Math.cos(angle),
    hy = Math.sin(angle);
  return {
    kind: 'person',
    lng,
    lat,
    paint,
    flap: hash & 1,
    candle: (hash >>> 16) % 10 < 6,
    eventGround: event.id,
    // One metre ahead and to the right, on the north-up lattice (rows run south).
    ahead: [lng + hx * view.lngPerI, lat - hy * view.latPerJ],
    side: [lng + hy * view.lngPerI, lat + hx * view.latPerJ],
    ...(seated && {
      eventRole: 'seated' as const,
      people: [{ figure: 'seated' as const, paint, lateral: 0, back: 0, flap: 0 }],
    }),
  };
}

/**
 * The crowd for this view: the prepared field projected on the grid, and its membership at
 * `progress`. Changing zoom never reclassifies geography; it only projects again.
 */
export function throng(
  event: ProcessionRoute,
  progress: number,
  grid: GridPlacement,
  cols: number,
  rows: number,
  zoom: number,
  quality = 1,
  guardFor?: ThrongGuardFactory,
  budgetMs = THRONG_FIELD_BUDGET_MS,
  pool?: ThrongFieldPool,
  /** Absolute cells to admit (`grid.ts` `coreCells`); default the whole grid. */
  bounds?: { left: number; top: number; right: number; bottom: number },
): ThrongPayload {
  const result: ThrongPayload = { cells: [], cap: Math.floor(MAX_THRONG_CELLS * quality) };
  if (zoom < 15 || progress < 0 || progress >= 1 || quality <= 0) return result;
  const field = fieldFor(event);
  if (!field.width) return result;
  const fine = zoom >= 17;
  const { originCol, originRow } = grid.grid;
  const affine = affineFor(field, grid);
  // Absolute cells: integer pans keep the same transform and reuse the static window.
  affine[4]! += originCol;
  affine[5]! += originRow;
  const [a, b, c, d, e, f] = affine as [number, number, number, number, number, number];
  const det = a * d - b * c;
  if (!(Math.abs(det) > 0)) return result;
  const toI = (col: number, row: number) => (d * (col - e) - b * (row - f)) / det,
    toJ = (col: number, row: number) => (-c * (col - e) + a * (row - f)) / det;
  const left = bounds?.left ?? originCol,
    top = bounds?.top ?? originRow,
    right = bounds?.right ?? originCol + cols,
    bottom = bounds?.bottom ?? originRow + rows;
  // The view and its pan margin, for preparation priority.
  const mc = Math.ceil((right - left) * WINDOW_MARGIN),
    mr = Math.ceil((bottom - top) * WINDOW_MARGIN);
  const is = [
      toI(left - mc, top - mr),
      toI(right + mc, top - mr),
      toI(left - mc, bottom + mr),
      toI(right + mc, bottom + mr),
    ],
    js = [
      toJ(left - mc, top - mr),
      toJ(right + mc, top - mr),
      toJ(left - mc, bottom + mr),
      toJ(right + mc, bottom + mr),
    ];
  const rect = [
    Math.max(0, Math.floor(Math.min(...is) / CHUNK)),
    Math.max(0, Math.floor(Math.min(...js) / CHUNK)),
    Math.min(field.cw - 1, Math.floor(Math.max(...is) / CHUNK)),
    Math.min(field.ch - 1, Math.floor(Math.max(...js) / CHUNK)),
  ] as const;
  const guard = guardFor?.(field.toLattice);
  const preparing = prepare(field, guard, rect, budgetMs, pool);
  const key = [a, b, c, d, e, f, fine ? 1 : 0];
  let view = field.views.find(
    (v) =>
      v.key.every((value, i) => value === key[i]) &&
      v.window[0] <= left &&
      v.window[1] <= top &&
      v.window[2] >= right &&
      v.window[3] >= bottom,
  );
  // Chunks prepared elsewhere cannot change a window that had none left to prepare.
  if (
    !view ||
    view.terrainVersion !== field.terrainVersion ||
    (view.pending && view.version !== field.version)
  ) {
    if (view) field.views.splice(field.views.indexOf(view), 1);
    // While the scale keeps changing, a margin would be projected for nothing.
    const settled = !!field.lastKey?.every((value, i) => value === key[i]);
    const wc = settled ? mc : 0,
      wr = settled ? mr : 0;
    view = staticView(field, fine, key, affine, [left - wc, top - wr, right + wc, bottom + wr]);
    field.views.push(view);
    if (field.views.length > 2) field.views.shift();
  }
  field.lastKey = key;
  const layout =
    event.kind === 'procession' || event.kind === 'parade' ? formationLayout(event) : undefined;
  // The Mass crowd has gathered when the Mass starts; it only leaves at the end.
  const massRamp =
    event.kind === 'mass' ? Math.min(1, (1 - progress) / (1 - PROCESSION.mass.disperseStart)) : 1;
  const head = layout?.head(progress) ?? 0;
  const progressKey = event.kind === 'mass' ? massRamp : event.kind === 'fluvial' ? 0 : head;
  const at = [originCol, originRow, left, top, right, bottom];
  const held = view.dynamic;
  if (
    held &&
    !preparing &&
    held.progress === progressKey &&
    held.quality === quality &&
    held.at.every((value, i) => value === at[i])
  )
    return { ...held.result };
  const current = view;
  result.ink = view.ink;
  result.version = field.version;
  result.pending = preparing || view.pending;
  if (bounds)
    result.clip = {
      left: left - originCol,
      top: top - originRow,
      right: right - originCol,
      bottom: bottom - originRow,
    };
  result.allows = fine
    ? (agent, col, row) => {
        const kind = sample(
          field,
          current.toI(col + originCol + 0.5, row + originRow + 0.5),
          current.toJ(col + originCol + 0.5, row + originRow + 0.5),
        );
        return !!kind && !!(kind & (agent.eventRole === 'seated' ? SEATED : STANDING));
      }
    : undefined;
  const outer = event.kind === 'mass' ? Math.max(1, event.site.radius_m) : 1;
  const cells = view.cells,
    classes = cells.classes;
  for (let index = 0; index < cells.n; index++) {
    const col = cells.col[index]!,
      row = cells.row[index]!;
    if (col < left || col >= right || row < top || row >= bottom) continue;
    const hash = cells.hash[index]!,
      kind = cells.kind[index]!;
    let density = 0,
      paint = 3 + (hash % 8);
    if (event.kind === 'mass') {
      // Stable cells drain outside-in as the Mass ends.
      if (massRamp < 1 && cells.dist[index]! / outer > massRamp) continue;
      density = PROCESSION.throng.mass;
    } else if (event.kind === 'fluvial') density = PROCESSION.throng.bank;
    else if (classes) {
      weights.fill(0);
      let sum = 0,
        count = 0;
      for (let flags = 0; flags < 8; flags++) {
        const n = classes[index * 16 + flags]!;
        if (!n) continue;
        const [w, p] = movingDensity(
          event,
          head - classes[index * 16 + flags + 8]! / n,
          flags,
          layout,
          paint,
        );
        sum += w * n;
        count += n;
        weights[p]! += w * n;
      }
      density = sum / count;
      let best = 0;
      for (let p = 0; p < weights.length; p++)
        if (weights[p]! > best) {
          best = weights[p]!;
          paint = p;
        }
    } else
      [density, paint] = movingDensity(
        event,
        head - cells.s[index]!,
        kind >>> FLAG_SHIFT,
        layout,
        paint,
      );
    if ((hash & 0xffff) / 65536 >= density) continue;
    const seated = !!(kind & SEATED) && !(kind & STANDING);
    let agent = cells.agents[index];
    if (!agent) agent = cells.agents[index] = crowdAgent(view, cells, index, event, paint, seated);
    else if (agent.paint !== paint) {
      agent.paint = paint;
      if (agent.people) agent.people = [{ ...agent.people[0]!, paint }];
    }
    let throngCell = cells.cells[index];
    if (!throngCell)
      throngCell = cells.cells[index] = {
        col: 0,
        row: 0,
        agent,
        mask: cells.masks?.subarray(index * THRONG_MASK_WORDS, (index + 1) * THRONG_MASK_WORDS),
        hash,
      };
    throngCell.col = col - originCol;
    throngCell.row = row - originRow;
    if (fine) {
      const direction =
        Math.round((cells.heading[index]! / 256) * THRONG_HEADINGS) % THRONG_HEADINGS;
      throngCell.look =
        (paint & 31) |
        ((hash & 1) << 5) |
        (Number(agent.candle) << 6) |
        (Number(seated) << 7) |
        (direction << 8);
    }
    result.cells.push(throngCell);
  }
  // Stable linear buckets spread cap thinning across the viewport without a full sort.
  bucketCounts.fill(0);
  for (const cell of result.cells) bucketCounts[cell.hash >>> 24]!++;
  let offset = 0;
  for (let i = 0; i < bucketCounts.length; i++) {
    bucketOffsets[i] = offset;
    offset += bucketCounts[i]!;
  }
  for (const cell of result.cells) sortedCells[bucketOffsets[cell.hash >>> 24]!++] = cell;
  for (let i = 0; i < result.cells.length; i++) result.cells[i] = sortedCells[i]!;
  sortedCells.length = 0;
  view.dynamic = { at, progress: progressKey, quality, result: { ...result } };
  return result;
}
