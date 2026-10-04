/** Ground-agent clearance, in meters, shared across loaded tile boundaries. */
import { flattenPolygonSteps, type FlatPolygons } from './flat-polygons';
import type { PersonFigure } from './people';
import { CAT_LENGTH_M } from './cats';
import { DOG_LENGTH_M } from './dogs';
import { complete } from './cooperate';

const ADULT_BODY = { length: 0.9, width: 1 } as const;
const CHILD_BODY = { length: 0.5, width: 0.5 } as const;
/** Physical clearance dimensions; umbrellas and rowers use the adult footprint. */
export const memberSize = (figure: PersonFigure) => (figure === 'child' ? CHILD_BODY : ADULT_BODY);

const DOG_BODY = { length: DOG_LENGTH_M, width: DOG_LENGTH_M } as const;
const CAT_BODY = { length: CAT_LENGTH_M, width: CAT_LENGTH_M } as const;
/** Conservative bounds of the square sprite masters, including every pose and heading. */
export const animalSize = (kind: 'cat' | 'dog') => (kind === 'cat' ? CAT_BODY : DOG_BODY);

export type Body = {
  x: number;
  y: number;
  hx: number;
  hy: number;
  length: number;
  width: number;
};
export type Point = { x: number; y: number };
export type Polygon = readonly (readonly Point[])[];

/** The bounds of `points`: [minX, minY, maxX, maxY]. A loop, so long rings can't overflow a spread. */
export function boundsOf(points: readonly Point[]): [number, number, number, number] {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const p of points) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return [x0, y0, x1, y1];
}

/** Spatial-hash bin size, m. */
const BIN_M = 12;
/** The bins `points` span, padded by `pad` m, row by row. Keys are numeric (bins within ±32768). */
function binKeys(points: readonly Point[], pad = 0, out: number[] = []): number[] {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const p of points) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  out.length = 0;
  for (let y = Math.floor((y0 - pad) / BIN_M); y <= Math.floor((y1 + pad) / BIN_M); y++)
    for (let x = Math.floor((x0 - pad) / BIN_M); x <= Math.floor((x1 + pad) / BIN_M); x++)
      out.push((x + 32768) * 65536 + (y + 32768));
  return out;
}

function put<K, V>(bins: Map<K, Set<V>>, key: K, value: V) {
  let bin = bins.get(key);
  if (!bin) bins.set(key, (bin = new Set()));
  bin.add(value);
}

export function bodyCorners(b: Body, out: Point[] = []): Point[] {
  for (let i = 0; i < 4; i++) {
    const a = i === 0 || i === 3 ? -1 : 1,
      c = i < 2 ? -1 : 1;
    const p = out[i] ?? (out[i] = { x: 0, y: 0 });
    p.x = b.x + (b.hx * a * b.length) / 2 - (b.hy * c * b.width) / 2;
    p.y = b.y + (b.hy * a * b.length) / 2 + (b.hx * c * b.width) / 2;
  }
  out.length = 4;
  return out;
}

/** Separating axes of both oriented rectangles; touching edges are allowed. */
export function bodiesOverlap(a: Body, b: Body, gap = 0.15): boolean {
  return overlapDepth(a, b, gap) > 0;
}

function overlapDepth(a: Body, b: Body, gap = 0.15): number {
  let depth = Infinity;
  for (let i = 0; i < 4; i++) {
    const p = i < 2 ? a : b;
    const x = i % 2 ? -p.hy : p.hx,
      y = i % 2 ? p.hx : p.hy;
    const overlap =
      reach(a, x, y) + reach(b, x, y) + gap - Math.abs((b.x - a.x) * x + (b.y - a.y) * y);
    if (overlap <= 0) return 0;
    depth = Math.min(depth, overlap);
  }
  return depth;
}
function reach(p: Body, x: number, y: number) {
  return (
    (Math.abs(p.hx * x + p.hy * y) * p.length) / 2 + (Math.abs(-p.hy * x + p.hx * y) * p.width) / 2
  );
}
function insideRing(p: Point, ring: readonly Point[]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!,
      b = ring[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x)
      inside = !inside;
  }
  return inside;
}

export function pointInside(p: Point, polygon: Polygon): boolean {
  let inside = false;
  for (const ring of polygon) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i]!,
        b = ring[j]!;
      if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x)
        inside = !inside;
    }
  }
  return inside;
}

export function segmentCrossing(a: Point, b: Point, c: Point, d: Point): Point | undefined {
  const ux = b.x - a.x,
    uy = b.y - a.y,
    vx = d.x - c.x,
    vy = d.y - c.y;
  const cross = ux * vy - uy * vx;
  if (Math.abs(cross) < 1e-8) return undefined;
  const t = ((c.x - a.x) * vy - (c.y - a.y) * vx) / cross;
  const s = ((c.x - a.x) * uy - (c.y - a.y) * ux) / cross;
  if (t < -1e-6 || t > 1 + 1e-6 || s < -1e-6 || s > 1 + 1e-6) return undefined;
  return { x: a.x + t * ux, y: a.y + t * uy };
}

function crossesBoundary(corners: readonly Point[], polygon: Polygon): boolean {
  for (let i = 0; i < corners.length; i++) {
    for (const ring of polygon) {
      for (let j = 1; j < ring.length; j++) {
        if (
          segmentCrossing(corners[i]!, corners[(i + 1) % corners.length]!, ring[j - 1]!, ring[j]!)
        )
          return true;
      }
    }
  }
  return false;
}

/** Checks corners AND edges/holes: a center inside a lot does not mean a car fits. */
export function bodyInside(b: Body, polygon: Polygon): boolean {
  const corners = bodyCorners(b);
  return (
    corners.every((p) => pointInside(p, polygon)) &&
    !crossesBoundary(corners, polygon) &&
    !polygon.some((ring, i) => i > 0 && ring.some((p) => insideRing(p, corners)))
  );
}

export function bodyHitsPolygon(b: Body, polygon: Polygon, corners = bodyCorners(b)): boolean {
  return (
    corners.some((p) => pointInside(p, polygon)) ||
    crossesBoundary(corners, polygon) ||
    polygon.some((ring) => ring.some((p) => insideRing(p, corners)))
  );
}

/** A spatial hash avoids comparing every person against every car each frame. */
export class Occupancy {
  private bins = new Map<number, Set<object>>();
  private entries = new Map<object, { bodies: readonly Body[]; keys: number[] }>();
  private readonly corners: Point[] = [];
  private readonly scratchKeys: number[] = [];
  private readonly uniqueKeys = new Set<number>();
  private readonly neighbors = new Set<object>();
  private keys(b: Body): number[] {
    return binKeys(bodyCorners(b, this.corners), 0.2, this.scratchKeys);
  }
  set(owner: object, bodies: readonly Body[]) {
    const keys = this.entries.get(owner)?.keys ?? [];
    this.delete(owner);
    keys.length = 0;
    this.uniqueKeys.clear();
    for (const b of bodies)
      for (const key of this.keys(b))
        if (!this.uniqueKeys.has(key)) {
          this.uniqueKeys.add(key);
          keys.push(key);
        }
    this.uniqueKeys.clear();
    this.entries.set(owner, { bodies, keys });
    for (const key of keys) put(this.bins, key, owner);
  }
  delete(owner: object) {
    for (const key of this.entries.get(owner)?.keys ?? []) {
      const bin = this.bins.get(key);
      bin?.delete(owner);
      if (bin?.size === 0) this.bins.delete(key);
    }
    this.entries.delete(owner);
  }
  bodies(owner: object): readonly Body[] {
    return this.entries.get(owner)?.bodies ?? [];
  }
  conflicts(owner: object, bodies: readonly Body[], ignore?: object): number {
    const neighbors = this.neighbors;
    neighbors.clear();
    try {
      for (const b of bodies)
        for (const key of this.keys(b)) {
          for (const other of this.bins.get(key) ?? [])
            if (other !== owner && other !== ignore) neighbors.add(other);
        }
      let hits = 0;
      for (const other of neighbors) {
        for (const a of bodies)
          for (const b of this.entries.get(other)!.bodies) hits += overlapDepth(a, b);
      }
      return hits;
    } finally {
      neighbors.clear();
    }
  }
  /** Diagnostic-only first blocker, with the same exclusions as conflicts. */
  firstConflict(owner: object, bodies: readonly Body[], ignore?: object): object | undefined {
    for (const a of bodies)
      for (const key of this.keys(a))
        for (const other of this.bins.get(key) ?? []) {
          if (other === owner || other === ignore) continue;
          if (this.entries.get(other)!.bodies.some((b) => bodiesOverlap(a, b))) return other;
        }
    return undefined;
  }
}

/** Polygon holes remain usable; index only the bounds and check the actual shape on query. */
// Covers segmentCrossing's 1e-6 parametric tolerance on long edges, plus float rounding.
const BOUNDS_PAD_M = 0.01;
export class PolygonIndex {
  private flat?: FlatPolygonIndex;
  readonly polygons: Polygon[] = [];
  private bounds = new Map<Polygon, [number, number, number, number]>();
  private bins = new Map<number, Set<Polygon>>();
  private readonly corners: Point[] = [];
  private readonly keys: number[] = [];
  private readonly tested = new Set<Polygon>();
  /** Read-only diagnostics, kept off simulation and snapshot hot paths. */
  stats() {
    const counts = new Map<Polygon, number>();
    let items = 0;
    let maxBinsPerPolygon = 0;
    for (const bin of this.bins.values())
      for (const polygon of bin) {
        const count = (counts.get(polygon) ?? 0) + 1;
        counts.set(polygon, count);
        maxBinsPerPolygon = Math.max(maxBinsPerPolygon, count);
        items++;
      }
    return {
      polygons: this.polygons.length,
      bins: this.bins.size,
      items,
      maxBinsPerPolygon,
      meanBinsPerPolygon: this.polygons.length ? items / this.polygons.length : 0,
    };
  }
  add(polygon: Polygon) {
    complete(this.addSteps(polygon));
  }
  *addSteps(polygon: Polygon): Generator<void, void, void> {
    this.flat = undefined;
    const points: Point[] = [];
    let count = 0;
    for (const ring of polygon)
      for (const p of ring) {
        points.push(p);
        if ((++count & 127) === 0) yield;
      }
    this.polygons.push(polygon);
    this.bounds.set(polygon, boundsOf(points));
    const [x0, y0, x1, y1] = this.bounds.get(polygon)!;
    for (let y = Math.floor(y0 / BIN_M); y <= Math.floor(y1 / BIN_M); y++)
      for (let x = Math.floor(x0 / BIN_M); x <= Math.floor(x1 / BIN_M); x++) {
        put(this.bins, (x + 32768) * 65536 + (y + 32768), polygon);
        if ((++count & 127) === 0) yield;
      }
    yield;
  }
  toFlat(): FlatPolygonIndex {
    return complete(this.toFlatSteps());
  }
  *toFlatSteps(): Generator<void, FlatPolygonIndex, void> {
    if (this.flat?.polygons.polys.length === this.polygons.length + 1) return this.flat;
    const ids = new Map<Polygon, number>();
    for (let i = 0; i < this.polygons.length; i++) {
      ids.set(this.polygons[i]!, i);
      if ((i & 255) === 0) yield;
    }
    const bounds = new Float64Array(this.polygons.length * 4);
    for (const [id, polygon] of this.polygons.entries()) {
      bounds.set(this.bounds.get(polygon)!, id * 4);
      if ((id & 255) === 0) yield;
    }
    const keys = new Float64Array([...this.bins.keys()].sort((a, b) => a - b));
    const starts = new Uint32Array(keys.length + 1);
    const items: number[] = [];
    for (const [i, key] of keys.entries()) {
      starts[i] = items.length;
      for (const polygon of this.bins.get(key)!) {
        items.push(ids.get(polygon)!);
        if ((items.length & 255) === 0) yield;
      }
    }
    starts[keys.length] = items.length;
    return (this.flat = {
      polygons: yield* flattenPolygonSteps(this.polygons),
      bounds,
      keys,
      starts,
      items: new Uint32Array(items),
    });
  }
  near(x0: number, y0: number, x1: number, y1: number): boolean {
    for (const key of binKeys(
      [
        { x: x0, y: y0 },
        { x: x1, y: y1 },
      ],
      BOUNDS_PAD_M,
      this.keys,
    ))
      for (const polygon of this.bins.get(key) ?? []) {
        const [a0, b0, a1, b1] = this.bounds.get(polygon)!;
        if (
          a0 <= x1 + BOUNDS_PAD_M &&
          a1 >= x0 - BOUNDS_PAD_M &&
          b0 <= y1 + BOUNDS_PAD_M &&
          b1 >= y0 - BOUNDS_PAD_M
        )
          return true;
      }
    return false;
  }
  hits(bodies: readonly Body[]): boolean {
    const tested = this.tested;
    try {
      for (const b of bodies) {
        tested.clear();
        const corners = bodyCorners(b, this.corners);
        const [x0, y0, x1, y1] = boundsOf(corners);
        for (const key of binKeys(corners, 0, this.keys))
          for (const polygon of this.bins.get(key) ?? []) {
            if (tested.has(polygon)) continue;
            tested.add(polygon);
            const [a0, b0, a1, b1] = this.bounds.get(polygon)!;
            if (
              a0 > x1 + BOUNDS_PAD_M ||
              a1 < x0 - BOUNDS_PAD_M ||
              b0 > y1 + BOUNDS_PAD_M ||
              b1 < y0 - BOUNDS_PAD_M
            )
              continue;
            if (bodyHitsPolygon(b, polygon, corners)) return true;
          }
      }
      return false;
    } finally {
      tested.clear();
    }
  }
}

export type FlatPolygonIndex = {
  polygons: FlatPolygons;
  bounds: Float64Array;
  keys: Float64Array;
  starts: Uint32Array;
  items: Uint32Array;
};

/** Read-only transferred bins. Accepting a snapshot does no per-polygon work. */
export class FrozenPolygonIndex {
  private readonly polygons: (Polygon | undefined)[] = [];
  private readonly corners: Point[] = [];
  private readonly keys: number[] = [];
  private readonly tested = new Set<number>();
  constructor(private readonly flat: FlatPolygonIndex) {}

  private polygon(id: number): Polygon {
    const cached = this.polygons[id];
    if (cached) return cached;
    const { coords, rings, polys } = this.flat.polygons;
    const polygon: Point[][] = [];
    for (let r = polys[id]!; r < polys[id + 1]!; r++) {
      const ring: Point[] = [];
      for (let i = rings[r]!; i < rings[r + 1]!; i++)
        ring.push({ x: coords[2 * i]!, y: coords[2 * i + 1]! });
      polygon.push(ring);
    }
    this.polygons[id] = polygon;
    return polygon;
  }

  hits(bodies: readonly Body[]): boolean {
    const tested = this.tested;
    const { keys, starts, items, bounds } = this.flat;
    try {
      for (const b of bodies) {
        tested.clear();
        const corners = bodyCorners(b, this.corners);
        const [x0, y0, x1, y1] = boundsOf(corners);
        for (const key of binKeys(corners, 0, this.keys)) {
          let lo = 0,
            hi = keys.length;
          while (lo < hi) {
            const mid = Math.floor((lo + hi) / 2);
            if (keys[mid]! < key) lo = mid + 1;
            else hi = mid;
          }
          if (keys[lo] !== key) continue;
          for (let i = starts[lo]!; i < starts[lo + 1]!; i++) {
            const id = items[i]!;
            if (tested.has(id)) continue;
            tested.add(id);
            const offset = id * 4;
            if (
              bounds[offset]! > x1 + BOUNDS_PAD_M ||
              bounds[offset + 2]! < x0 - BOUNDS_PAD_M ||
              bounds[offset + 1]! > y1 + BOUNDS_PAD_M ||
              bounds[offset + 3]! < y0 - BOUNDS_PAD_M
            )
              continue;
            if (bodyHitsPolygon(b, this.polygon(id), corners)) return true;
          }
        }
      }
      return false;
    } finally {
      tested.clear();
    }
  }
}
