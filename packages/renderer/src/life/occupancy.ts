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
  /** Query classification only; it never changes physical collision scores. */
  kind?: number;
};
export const BODY_KIND = { human: 1, vehicle: 2, fixed: 4, animal: 8 } as const;
export type Point = { x: number; y: number };
export type Polygon = readonly (readonly Point[])[];

/** Thin swept segment; padding is total added length, in the caller's metric coordinates. */
export function segmentBody(a: Point, b: Point, padding = 0): Body {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const distance = Math.hypot(dx, dy);
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    hx: distance ? dx / distance : 1,
    hy: distance ? dy / distance : 0,
    length: Math.max(distance + padding, 0.01),
    width: 0.01,
  };
}

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
export function binKeys(points: readonly Point[], pad = 0, out: number[] = []): number[] {
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

/** Exact linear sweep of a fixed-orientation rectangle; touching edges are allowed. */
export function sweptBodyOverlap(a: Body, target: Point, b: Body, gap = 0.15): boolean {
  let enter = 0,
    leave = 1;
  for (let i = 0; i < 4; i++) {
    const p = i < 2 ? a : b;
    const x = i % 2 ? -p.hy : p.hx,
      y = i % 2 ? p.hx : p.hy;
    const radius = reach(a, x, y) + reach(b, x, y) + gap,
      separation = (a.x - b.x) * x + (a.y - b.y) * y,
      velocity = (target.x - a.x) * x + (target.y - a.y) * y;
    if (Math.abs(velocity) < 1e-12) {
      if (Math.abs(separation) >= radius) return false;
      continue;
    }
    const first = (-radius - separation) / velocity,
      last = (radius - separation) / velocity;
    enter = Math.max(enter, Math.min(first, last));
    leave = Math.min(leave, Math.max(first, last));
    if (enter >= leave) return false;
  }
  return enter < leave;
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
/** Half the footprint's extent projected onto an axis. */

export function reach(p: Body, x: number, y: number) {
  return (
    (Math.abs(p.hx * x + p.hy * y) * p.length) / 2 + (Math.abs(-p.hy * x + p.hx * y) * p.width) / 2
  );
}

/** Clip a footprint in corridor coordinates; projections alone overestimate rotated corners. */
export function corridorDistance(
  b: Body,
  x: number,
  y: number,
  hx: number,
  hy: number,
  halfWidth: number,
  range: number,
) {
  if (range < 0 || halfWidth < 0) return Infinity;
  const dx = b.x - x,
    dy = b.y - y;
  const cx = dx * hx + dy * hy,
    cy = -dx * hy + dy * hx;
  const along = b.hx * hx + b.hy * hy,
    side = -b.hx * hy + b.hy * hx;
  const ax = (along * b.length) / 2,
    ay = (side * b.length) / 2;
  const bx = (-side * b.width) / 2,
    by = (along * b.width) / 2;
  const forwardReach = Math.abs(ax) + Math.abs(bx),
    lateralReach = Math.abs(ay) + Math.abs(by);
  if (
    cx + forwardReach < -1e-9 ||
    cx - forwardReach > range + 1e-9 ||
    Math.abs(cy) > halfWidth + lateralReach + 1e-9
  )
    return Infinity;
  let previousX = cx - ax - bx,
    previousY = cy - ay - by;
  let first = Infinity,
    last = -Infinity;
  // Clipping only the lateral strip yields a continuous forward interval. Its nearest
  // intersection with [0, range] needs no temporary polygons or forward-edge clipping.
  for (let i = 1; i <= 4; i++) {
    const longitudinal = i === 1 || i === 2 ? 1 : -1;
    const lateral = i === 2 || i === 3 ? 1 : -1;
    const nextX = cx + longitudinal * ax + lateral * bx;
    const nextY = cy + longitudinal * ay + lateral * by;
    if (Math.abs(nextY) <= halfWidth + 1e-9) {
      first = Math.min(first, nextX);
      last = Math.max(last, nextX);
    }
    const span = nextY - previousY;
    if (span !== 0)
      for (let edge = 0; edge < 2; edge++) {
        const boundary = edge ? halfWidth : -halfWidth;
        const t = (boundary - previousY) / span;
        if (t < 0 || t > 1) continue;
        const at = previousX + (nextX - previousX) * t;
        first = Math.min(first, at);
        last = Math.max(last, at);
      }
    previousX = nextX;
    previousY = nextY;
  }
  return last < -1e-9 || first > range + 1e-9 ? Infinity : Math.max(0, first);
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
  private entries = new Map<object, { bodies: readonly Body[]; keys: number[]; mask: number }>();
  private humans = 0;
  get hasHumans() {
    return this.humans > 0;
  }
  private readonly corners: Point[] = [];
  private readonly scratchKeys: number[] = [];
  private readonly uniqueKeys = new Set<number>();
  private readonly neighbors = new Set<object>();
  private readonly queryNeighbors = new Set<object>();
  private readonly corridor: Body = { x: 0, y: 0, hx: 0, hy: 0, length: 0, width: 0 };
  private keys(b: Body): number[] {
    const ax = (b.hx * b.length) / 2,
      ay = (b.hy * b.length) / 2,
      bx = (b.hy * b.width) / 2,
      by = (b.hx * b.width) / 2;
    // Keep the corner arithmetic order: rounding at bin edges must match bodyCorners.
    const xa = b.x - ax + bx,
      xb = b.x + ax + bx,
      xc = b.x + ax - bx,
      xd = b.x - ax - bx,
      ya = b.y - ay - by,
      yb = b.y + ay - by,
      yc = b.y + ay + by,
      yd = b.y - ay + by;
    const x0 = Math.floor((Math.min(xa, xb, xc, xd) - 0.2) / BIN_M),
      x1 = Math.floor((Math.max(xa, xb, xc, xd) + 0.2) / BIN_M),
      y0 = Math.floor((Math.min(ya, yb, yc, yd) - 0.2) / BIN_M),
      y1 = Math.floor((Math.max(ya, yb, yc, yd) + 0.2) / BIN_M);
    const keys = this.scratchKeys;
    keys.length = 0;
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) keys.push((x + 32768) * 65536 + (y + 32768));
    return keys;
  }
  set(owner: object, bodies: readonly Body[]) {
    const previous = this.entries.get(owner);
    this.uniqueKeys.clear();
    let mask = 0;
    for (const b of bodies) {
      mask |= b.kind ?? BODY_KIND.fixed;
      for (const key of this.keys(b)) this.uniqueKeys.add(key);
    }
    let sameBins = previous !== undefined && previous.keys.length === this.uniqueKeys.size;
    if (sameBins && previous)
      for (const key of previous.keys)
        if (!this.uniqueKeys.has(key)) {
          sameBins = false;
          break;
        }
    if (previous && sameBins) {
      this.humans +=
        Number(!!(mask & BODY_KIND.human)) - Number(!!(previous.mask & BODY_KIND.human));
      previous.bodies = bodies;
      previous.mask = mask;
      for (const key of previous.keys) {
        // Preserve the original delete/reinsert neighbor order, including singleton bins.
        const bin = this.bins.get(key)!;
        bin.delete(owner);
        bin.add(owner);
      }
      this.uniqueKeys.clear();
      return;
    }
    const keys = previous?.keys ?? [];
    this.delete(owner);
    keys.length = 0;
    for (const key of this.uniqueKeys) keys.push(key);
    this.uniqueKeys.clear();
    this.entries.set(owner, { bodies, keys, mask });
    if (mask & BODY_KIND.human) this.humans++;
    for (const key of keys) put(this.bins, key, owner);
  }
  delete(owner: object) {
    const entry = this.entries.get(owner);
    if ((entry?.mask ?? 0) & BODY_KIND.human) this.humans--;
    for (const key of entry?.keys ?? []) {
      const bin = this.bins.get(key);
      bin?.delete(owner);
      if (bin?.size === 0) this.bins.delete(key);
    }
    this.entries.delete(owner);
  }
  bodies(owner: object): readonly Body[] {
    return this.entries.get(owner)?.bodies ?? [];
  }
  /** Exact nearest footprint in a corridor with a normalized forward axis, in metres. */
  nearestInCorridor(
    x: number,
    y: number,
    hx: number,
    hy: number,
    halfWidth: number,
    range: number,
    kindMask: number,
    ignore?: object,
  ): number {
    if (
      range < 0 ||
      halfWidth < 0 ||
      !Number.isFinite(range) ||
      !Number.isFinite(halfWidth) ||
      (kindMask === BODY_KIND.human && !this.humans)
    )
      return Infinity;
    const corridor = this.corridor;
    corridor.x = x + (hx * range) / 2;
    corridor.y = y + (hy * range) / 2;
    corridor.hx = hx;
    corridor.hy = hy;
    corridor.length = range;
    corridor.width = halfWidth * 2;
    const owners = this.queryNeighbors;
    const support = (BIN_M / 2) * (Math.abs(hx) + Math.abs(hy));
    owners.clear();
    try {
      for (const key of this.keys(corridor)) {
        const bx = Math.floor(key / 65536) - 32768,
          by = (key % 65536) - 32768;
        const dx = (bx + 0.5) * BIN_M - x,
          dy = (by + 0.5) * BIN_M - y,
          forward = dx * hx + dy * hy;
        if (
          Math.abs(-dx * hy + dy * hx) > halfWidth + support + 1e-9 ||
          forward < -support - 1e-9 ||
          forward > range + support + 1e-9
        )
          continue;
        for (const owner of this.bins.get(key) ?? [])
          if (owner !== ignore && this.entries.get(owner)!.mask & kindMask) owners.add(owner);
      }
      let nearest = Infinity;
      for (const owner of owners)
        for (const b of this.entries.get(owner)!.bodies) {
          if (!((b.kind ?? BODY_KIND.fixed) & kindMask)) continue;
          nearest = Math.min(nearest, corridorDistance(b, x, y, hx, hy, halfWidth, range));
          if (nearest === 0) return 0;
        }
      return nearest;
    } finally {
      owners.clear();
    }
  }
  /** Visit each matching owner once. Bodies and callback are borrowed for this call only. */
  visitInArea(
    polygon: Polygon,
    kindMask: number,
    visit: (owner: object, body: Readonly<Body>) => void,
  ) {
    const owners = this.queryNeighbors;
    owners.clear();
    try {
      const points = polygon.length === 1 ? polygon[0]! : polygon.flat();
      if (!points.length) return;
      for (const key of binKeys(points, 0, this.scratchKeys))
        for (const owner of this.bins.get(key) ?? [])
          if (this.entries.get(owner)!.mask & kindMask) owners.add(owner);
      for (const owner of owners) {
        const body = this.entries
          .get(owner)!
          .bodies.find(
            (b) =>
              !!((b.kind ?? BODY_KIND.fixed) & kindMask) &&
              bodyHitsPolygon(b, polygon, bodyCorners(b, this.corners)),
          );
        if (body) visit(owner, body);
      }
    } finally {
      owners.clear();
    }
  }
  /** Visit matching footprints, never expose owners or retain callback/body references. */
  someInArea(
    polygon: Polygon,
    kindMask: number,
    predicate?: (body: Readonly<Body>) => boolean,
    ignore?: object,
  ): boolean {
    const owners = this.queryNeighbors;
    owners.clear();
    try {
      const points = polygon.length === 1 ? polygon[0]! : polygon.flat();
      if (!points.length) return false;
      for (const key of binKeys(points, 0, this.scratchKeys))
        for (const owner of this.bins.get(key) ?? [])
          if (owner !== ignore && this.entries.get(owner)!.mask & kindMask) owners.add(owner);
      for (const owner of owners)
        for (const b of this.entries.get(owner)!.bodies)
          if (
            (b.kind ?? BODY_KIND.fixed) & kindMask &&
            bodyHitsPolygon(b, polygon, bodyCorners(b, this.corners)) &&
            (!predicate || predicate(b))
          )
            return true;
      return false;
    } finally {
      owners.clear();
    }
  }
  conflicts(
    owner: object,
    bodies: readonly Body[],
    ignore?: object,
    project?: (owner: object, body: Body, index: number) => Body,
    previous?: readonly Body[],
  ): number {
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
        const otherBodies = this.entries.get(other)!.bodies;
        for (let index = 0; index < bodies.length; index++) {
          const a = bodies[index]!;
          for (let i = 0; i < otherBodies.length; i++) {
            const b = otherBodies[i]!;
            const body = project ? project(other, b, i) : b;
            const depth = overlapDepth(a, body);
            hits += previous
              ? Math.max(0, depth - overlapDepth(previous[index]!, body) - 1e-6)
              : depth;
          }
        }
      }
      return hits;
    } finally {
      neighbors.clear();
    }
  }
  /** Reject-only first blocker, with the same exclusions and optional physical projection. */
  firstConflict(
    owner: object,
    bodies: readonly Body[],
    ignore?: object,
    project?: (owner: object, body: Body, index: number) => Body,
  ): object | undefined {
    for (const a of bodies)
      for (const key of this.keys(a))
        for (const other of this.bins.get(key) ?? []) {
          if (other === owner || other === ignore) continue;
          if (
            this.entries
              .get(other)!
              .bodies.some((b, i) => bodiesOverlap(a, project ? project(other, b, i) : b))
          )
            return other;
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
  /** Exact translated footprint, used only to prove rejected holding corridors. */
  sweptHits(body: Body, target: Point): boolean {
    const hull = bodyTranslationHull(body, target);
    const tested = new Set<Polygon>();
    for (const key of binKeys(hull))
      for (const polygon of this.bins.get(key) ?? []) {
        if (tested.has(polygon)) continue;
        tested.add(polygon);
        if (bodyHitsPolygon(body, polygon, hull)) return true;
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

/** Exact swept convex footprint of a fixed-orientation translation. */
function bodyTranslationHull(body: Body, target: Point): Point[] {
  const points = [...bodyCorners(body), ...bodyCorners({ ...body, ...target })].sort(
    (a, b) => a.x - b.x || a.y - b.y,
  );
  const cross = (a: Point, b: Point, c: Point) =>
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const half = (ordered: readonly Point[]) => {
    const hull: Point[] = [];
    for (const point of ordered) {
      while (hull.length >= 2 && cross(hull.at(-2)!, hull.at(-1)!, point) <= 0) hull.pop();
      hull.push(point);
    }
    hull.pop();
    return hull;
  };
  return [...half(points), ...half([...points].reverse())];
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
