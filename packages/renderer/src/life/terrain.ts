import { DEFAULT_ROAD_WIDTH_M } from './config';
import { LifeLine, type LifeGeometry } from './geometry';
import {
  boundsOf,
  PolygonIndex,
  segmentBody,
  type Body,
  type Point,
  type Polygon,
} from './occupancy';
import { complete } from './cooperate';

/** The same rectangular segment footprint used by the road rasterizer. */
export function stripRing(a: Point, b: Point, halfWidth: number): Point[] {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (!length) return [];
  const x = (-(b.y - a.y) / length) * halfWidth;
  const y = ((b.x - a.x) / length) * halfWidth;
  return [
    { x: a.x + x, y: a.y + y },
    { x: b.x + x, y: b.y + y },
    { x: b.x - x, y: b.y - y },
    { x: a.x - x, y: a.y - y },
    { x: a.x + x, y: a.y + y },
  ];
}

/** Fixtures and older life geometry can derive road envelopes from their retained widths. */
export function carriageways(geo: LifeGeometry, perMeter: number): Polygon[] {
  return complete(carriagewaySteps(geo, perMeter));
}
function* carriagewaySteps(geo: LifeGeometry, perMeter: number): Generator<void, Polygon[], void> {
  const retained = geo.areas?.filter((a) => a.kind === 'carriageway').map((a) => a.rings);
  if (retained?.length) return retained;
  const roads: Polygon[] = [];
  for (let line = 0; line < geo.kinds.length; line++) {
    if (geo.kinds[line]! > LifeLine.roadMinor) continue;
    const halfWidth = ((geo.widths[line] || DEFAULT_ROAD_WIDTH_M) * perMeter) / 2;
    for (let v = geo.starts[line]!; v < geo.starts[line + 1]! - 1; v++) {
      if ((v & 63) === 0) yield;
      const ring = stripRing(
        { x: geo.coords[v * 2]!, y: geo.coords[v * 2 + 1]! },
        { x: geo.coords[v * 2 + 2]!, y: geo.coords[v * 2 + 3]! },
        halfWidth,
      );
      if (ring.length) roads.push([ring]);
    }
  }
  return roads;
}

const area = (ring: readonly Point[]) =>
  ring.reduce((sum, p, i) => {
    const q = ring[(i + 1) % ring.length]!;
    return sum + p.x * q.y - q.x * p.y;
  }, 0);
const openRing = (ring: readonly Point[]) =>
  ring.length > 1 && ring[0]!.x === ring.at(-1)!.x && ring[0]!.y === ring.at(-1)!.y
    ? ring.slice(0, -1)
    : [...ring];

/** Clip a convex polygon to either half-plane of a directed edge. */
function halfPlane(points: readonly Point[], a: Point, b: Point, sign: number): Point[] {
  const side = (p: Point) => sign * ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x));
  const out: Point[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!,
      q = points[(i + 1) % points.length]!;
    const dp = side(p),
      dq = side(q);
    if (dp >= 0) out.push(p);
    if (dp >= 0 !== dq >= 0) {
      const t = dp / (dp - dq);
      out.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
    }
  }
  return out;
}

/** Difference of convex road/crosswalk quads, retained as convex pieces with closed rings. */
export function subtractCrossing(road: readonly Point[], crossing: readonly Point[]): Point[][] {
  const clip = openRing(crossing);
  let inside = openRing(road);
  const outside: Point[][] = [];
  const sign = Math.sign(area(clip));
  if (!sign) return [inside];
  for (let i = 0; i < clip.length && inside.length >= 3; i++) {
    const a = clip[i]!,
      b = clip[(i + 1) % clip.length]!;
    const piece = halfPlane(inside, a, b, -sign);
    if (piece.length >= 3 && Math.abs(area(piece)) > 1e-8) outside.push([...piece, piece[0]!]);
    inside = halfPlane(inside, a, b, sign);
  }
  return outside;
}

const ROAD_BIN_M = 20;
type IndexedCrossing = { polygon: Polygon };
/** All inputs use meters, including the walking graph's queries. */
class CrossingIndex<T extends IndexedCrossing> {
  private readonly bins = new Map<string, T[]>();
  private keys(polygon: Polygon) {
    const [x0, y0, x1, y1] = boundsOf(polygon[0]!);
    const out: string[] = [];
    for (let x = Math.floor(x0 / ROAD_BIN_M); x <= Math.floor(x1 / ROAD_BIN_M); x++)
      for (let y = Math.floor(y0 / ROAD_BIN_M); y <= Math.floor(y1 / ROAD_BIN_M); y++)
        out.push(`${x},${y}`);
    return out;
  }
  add(entry: T) {
    complete(this.addSteps(entry));
  }
  *addSteps(entry: T): Generator<void, void, void> {
    let count = 0;
    const [x0, y0, x1, y1] = boundsOf(entry.polygon[0]!);
    for (let x = Math.floor(x0 / ROAD_BIN_M); x <= Math.floor(x1 / ROAD_BIN_M); x++)
      for (let y = Math.floor(y0 / ROAD_BIN_M); y <= Math.floor(y1 / ROAD_BIN_M); y++) {
        const key = `${x},${y}`;
        const entries = this.bins.get(key) ?? [];
        entries.push(entry);
        this.bins.set(key, entries);
        if ((++count & 127) === 0) yield;
      }
  }
  nearby(polygon: Polygon): Set<T> {
    const [x0, y0, x1, y1] = boundsOf(polygon[0]!);
    return new Set(
      this.keys(polygon)
        .flatMap((key) => this.bins.get(key) ?? [])
        .filter((entry) => {
          const [a0, b0, a1, b1] = boundsOf(entry.polygon[0]!);
          return a0 <= x1 && x0 <= a1 && b0 <= y1 && y0 <= b1;
        }),
    );
  }
}

const cut = (pieces: readonly Polygon[], crossings: Iterable<Polygon>): Polygon[] => {
  let out = [...pieces];
  for (const crossing of crossings)
    out = out.flatMap((piece) => subtractCrossing(piece[0]!, crossing[0]!).map((ring) => [ring]));
  return out;
};

/** Metric carriageways with only explicit crossing footprints cut out for walkers. */
export class RoadAccess {
  readonly roads = new PolygonIndex();
  readonly forbidden = new PolygonIndex();
  piecesByRoad!: readonly (readonly Polygon[])[];

  constructor(
    roads: readonly Polygon[],
    crossings: readonly Polygon[],
    pieces?: readonly (readonly Polygon[])[],
    deferred = false,
  ) {
    if (!deferred) complete(this.prepare(roads, crossings, pieces));
  }
  *prepare(
    roads: readonly Polygon[],
    crossings: readonly Polygon[],
    pieces?: readonly (readonly Polygon[])[],
  ): Generator<void, void, void> {
    if (pieces) this.piecesByRoad = pieces;
    else {
      const index = new CrossingIndex<IndexedCrossing>();
      for (const polygon of crossings) yield* index.addSteps({ polygon });
      const fragments: Polygon[][] = [];
      for (const road of roads) {
        fragments.push(
          cut(
            [road],
            [...index.nearby(road)].map((c) => c.polygon),
          ),
        );
        yield;
      }
      this.piecesByRoad = fragments;
    }
    for (const road of roads) yield* this.roads.addSteps(road);
    for (const fragments of this.piecesByRoad)
      for (const polygon of fragments) yield* this.forbidden.addSteps(polygon);
  }

  /** Assemble cached pieces without performing crossing subtraction again. */
  static fromPrepared(roads: readonly Polygon[], pieces: readonly (readonly Polygon[])[]) {
    return new RoadAccess(roads, [], pieces);
  }

  allows(bodies: readonly Body[], crossing = true): boolean {
    return !(crossing ? this.forbidden : this.roads).hits(bodies);
  }

  near(x0: number, y0: number, x1: number, y1: number, crossing = true): boolean {
    return (crossing ? this.forbidden : this.roads).near(x0, y0, x1, y1);
  }

  clear(a: Point, b: Point): boolean {
    return this.allows([segmentBody(a, b)]);
  }
}

export type PreparedRoadTerrain = {
  roads: readonly Polygon[];
  crossings: readonly Polygon[];
  access: RoadAccess;
};
const prepared = new WeakMap<LifeGeometry, Map<number, PreparedRoadTerrain>>();

/** Geometry is immutable; share its metric preparation across its tile and walking graph. */
export function prepareRoadTerrain(geo: LifeGeometry, perMeter: number): PreparedRoadTerrain {
  return complete(prepareRoadTerrainSteps(geo, perMeter));
}
export function* prepareRoadTerrainSteps(
  geo: LifeGeometry,
  perMeter: number,
): Generator<void, PreparedRoadTerrain, void> {
  let variants = prepared.get(geo);
  if (!variants) prepared.set(geo, (variants = new Map<number, PreparedRoadTerrain>()));
  const cached = variants.get(perMeter);
  if (cached) return cached;
  const metric = (polygon: Polygon) => transformPolygon(polygon, 0, 0, 1 / perMeter);
  const roads: Polygon[] = [],
    crossings: Polygon[] = [];
  for (const road of yield* carriagewaySteps(geo, perMeter)) {
    roads.push(metric(road));
    yield;
  }
  for (const a of geo.areas ?? [])
    if (a.kind === 'crossing') {
      crossings.push(metric(a.rings));
      yield;
    }
  const access = new RoadAccess(roads, crossings, undefined, true);
  yield* access.prepare(roads, crossings);
  const terrain = { roads, crossings, access };
  variants.set(perMeter, terrain);
  return terrain;
}

export function transformPolygon(polygon: Polygon, x: number, y: number, scale: number): Polygon {
  return polygon.map((ring) => ring.map((p) => ({ x: x + p.x * scale, y: y + p.y * scale })));
}

type Contribution = {
  owner: object;
  terrain: PreparedRoadTerrain;
  x: number;
  y: number;
  scale: number;
};
type CrossingToken = { owner: object; source: Polygon };
type RoadFragments = { dependencies: Set<CrossingToken>; pieces: readonly Polygon[] };
type TileFragments = {
  terrain: PreparedRoadTerrain;
  tokens: CrossingToken[];
  roads: RoadFragments[];
  origin: string;
  transformed: WeakMap<Polygon, Polygon>;
  pieces: WeakMap<readonly Polygon[], Polygon[]>;
};

/** Keep fragments in owner-local meters so changing the world reference never invalidates them. */
export class WorldRoadCache {
  private readonly tiles = new WeakMap<object, TileFragments>();

  /** A frozen tile must not retain crossing dependency chains from its former neighbors. */
  forget(owner: object): void {
    this.tiles.delete(owner);
  }

  build(contributions: readonly Contribution[]): RoadAccess {
    return complete(this.buildSteps(contributions));
  }
  *buildSteps(contributions: readonly Contribution[]): Generator<void, RoadAccess, void> {
    const caches = new Map<object, TileFragments>();
    const index = new CrossingIndex<IndexedCrossing & { token: CrossingToken }>();
    for (const c of contributions) {
      let cached = this.tiles.get(c.owner);
      if (!cached || cached.terrain !== c.terrain) {
        cached = {
          terrain: c.terrain,
          origin: '',
          transformed: new WeakMap(),
          pieces: new WeakMap(),
          tokens: c.terrain.crossings.map((source) => ({ owner: c.owner, source })),
          roads: c.terrain.access.piecesByRoad.map((pieces) => ({
            dependencies: new Set(),
            pieces,
          })),
        };
        this.tiles.set(c.owner, cached);
      }
      // A yielding build must own its cache records: foreground retirement/rebuild can run
      // between slices. Polygon results are immutable, so same-origin weak maps can be shared.
      cached = { ...cached, roads: cached.roads.map((fragments) => ({ ...fragments })) };
      caches.set(c.owner, cached);
      const origin = `${c.x},${c.y},${c.scale}`;
      if (cached.origin !== origin) {
        cached.origin = origin;
        cached.transformed = new WeakMap();
        cached.pieces = new WeakMap();
      }
      for (const token of cached.tokens)
        yield* index.addSteps({ token, polygon: this.transform(cached, token.source, c) });
    }
    const roads: Polygon[] = [],
      pieces: Polygon[][] = [];
    for (const c of contributions) {
      const cached = caches.get(c.owner)!;
      for (let i = 0; i < c.terrain.roads.length; i++) {
        yield;
        const road = c.terrain.roads[i]!;
        const worldRoad = this.transform(cached, road, c);
        const nearby = [...index.nearby(worldRoad)].filter(
          (entry) => entry.token.owner !== c.owner,
        );
        const fragments = cached.roads[i]!;
        if (
          nearby.length !== fragments.dependencies.size ||
          nearby.some((entry) => !fragments.dependencies.has(entry.token))
        ) {
          fragments.dependencies = new Set(nearby.map((entry) => entry.token));
          cached.pieces.delete(fragments.pieces);
          fragments.pieces = cut(
            c.terrain.access.piecesByRoad[i]!,
            nearby.map((entry) =>
              transformPolygon(entry.polygon, -c.x / c.scale, -c.y / c.scale, 1 / c.scale),
            ),
          );
        }
        roads.push(worldRoad);
        let worldPieces = cached.pieces.get(fragments.pieces);
        if (!worldPieces) {
          worldPieces = fragments.pieces.map((polygon) => this.transform(cached, polygon, c));
          cached.pieces.set(fragments.pieces, worldPieces);
        }
        pieces.push(worldPieces);
      }
    }
    const access = new RoadAccess(roads, [], pieces, true);
    yield* access.prepare(roads, [], pieces);
    for (const [owner, cached] of caches) this.tiles.set(owner, cached);
    return access;
  }

  private transform(cache: TileFragments, polygon: Polygon, c: Contribution): Polygon {
    let world = cache.transformed.get(polygon);
    if (!world) {
      world = transformPolygon(polygon, c.x, c.y, c.scale);
      cache.transformed.set(polygon, world);
    }
    return world;
  }
}
