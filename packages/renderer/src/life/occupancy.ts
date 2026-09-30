/** Ground-agent clearance, in meters, shared across loaded tile boundaries. */
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
function binKeys(points: readonly Point[], pad = 0): number[] {
  const [x0, y0, x1, y1] = boundsOf(points);
  const out: number[] = [];
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

export function bodyCorners(b: Body): Point[] {
  return [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([a, c]) => ({
    x: b.x + (b.hx * a! * b.length) / 2 - (b.hy * c! * b.width) / 2,
    y: b.y + (b.hy * a! * b.length) / 2 + (b.hx * c! * b.width) / 2,
  }));
}

/** Separating axes of both oriented rectangles; touching edges are allowed. */
export function bodiesOverlap(a: Body, b: Body, gap = 0.15): boolean {
  return overlapDepth(a, b, gap) > 0;
}

function overlapDepth(a: Body, b: Body, gap = 0.15): number {
  let depth = Infinity;
  for (const [x, y] of [
    [a.hx, a.hy],
    [-a.hy, a.hx],
    [b.hx, b.hy],
    [-b.hy, b.hx],
  ]) {
    const reach = (p: Body) =>
      (Math.abs(p.hx * x! + p.hy * y!) * p.length) / 2 +
      (Math.abs(-p.hy * x! + p.hx * y!) * p.width) / 2;
    const overlap = reach(a) + reach(b) + gap - Math.abs((b.x - a.x) * x! + (b.y - a.y) * y!);
    if (overlap <= 0) return 0;
    depth = Math.min(depth, overlap);
  }
  return depth;
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
    !polygon.slice(1).some((ring) => ring.some((p) => pointInside(p, [corners])))
  );
}

export function bodyHitsPolygon(b: Body, polygon: Polygon): boolean {
  const corners = bodyCorners(b);
  return (
    corners.some((p) => pointInside(p, polygon)) ||
    crossesBoundary(corners, polygon) ||
    polygon.some((ring) => ring.some((p) => pointInside(p, [corners])))
  );
}

/** A spatial hash avoids comparing every person against every car each frame. */
export class Occupancy {
  private bins = new Map<number, Set<object>>();
  private entries = new Map<object, { bodies: readonly Body[]; keys: number[] }>();
  private keys(b: Body): number[] {
    return binKeys(bodyCorners(b), 0.2);
  }
  set(owner: object, bodies: readonly Body[]) {
    this.delete(owner);
    const keys = [...new Set(bodies.flatMap((b) => this.keys(b)))];
    this.entries.set(owner, { bodies, keys });
    for (const key of keys) put(this.bins, key, owner);
  }
  delete(owner: object) {
    for (const key of this.entries.get(owner)?.keys ?? []) this.bins.get(key)?.delete(owner);
    this.entries.delete(owner);
  }
  conflicts(owner: object, bodies: readonly Body[]): number {
    const neighbors = new Set<object>();
    for (const b of bodies)
      for (const key of this.keys(b)) {
        for (const other of this.bins.get(key) ?? []) if (other !== owner) neighbors.add(other);
      }
    let hits = 0;
    for (const other of neighbors) {
      for (const a of bodies)
        for (const b of this.entries.get(other)!.bodies) hits += overlapDepth(a, b);
    }
    return hits;
  }
}

/** Polygon holes remain usable; index only the bounds and check the actual shape on query. */
export class PolygonIndex {
  private bins = new Map<number, Set<Polygon>>();
  add(polygon: Polygon) {
    for (const key of binKeys(polygon.flat())) put(this.bins, key, polygon);
  }
  hits(bodies: readonly Body[]): boolean {
    for (const b of bodies) {
      const tested = new Set<Polygon>();
      for (const key of binKeys(bodyCorners(b)))
        for (const polygon of this.bins.get(key) ?? []) {
          if (tested.has(polygon)) continue;
          tested.add(polygon);
          if (bodyHitsPolygon(b, polygon)) return true;
        }
    }
    return false;
  }
}
