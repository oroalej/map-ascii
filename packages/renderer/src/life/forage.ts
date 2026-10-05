/** Bounded ground feeding with local water indexes and shared world clearance and road access. */
import { Habitat, type BirdSpecies } from './birds';
import { FORAGE } from './config';
import { complete } from './cooperate';
import { inTile, type LifeGeometry } from './geometry';
import { PolygonIndex, segmentBody, type Point, type Polygon } from './occupancy';
import { between } from './random';
import { prepareRoadTerrainSteps, transformPolygon, type RoadAccess } from './terrain';

export type ForageSpec = {
  gait: 'hop' | 'walk' | 'stalk';
  step: readonly [number, number];
  speed: number;
  peck: readonly [number, number];
  feed: readonly [number, number];
  rest: readonly [number, number];
  patch: number;
  treeRest: number;
  edge?: { wet: number; dry: number };
};

export const FORAGE_SPECIES: Partial<Record<BirdSpecies, ForageSpec>> = {
  maya: {
    gait: 'hop',
    step: [0.15, 0.4],
    speed: 0,
    peck: [0.3, 1],
    feed: [6, 15],
    rest: [8, 20],
    patch: 4,
    treeRest: 0.6,
  },
  pigeon: {
    gait: 'walk',
    step: [0.2, 0.8],
    speed: 0.5,
    peck: [0.4, 1.5],
    feed: [10, 25],
    rest: [10, 30],
    patch: 6,
    treeRest: 0.2,
  },
  egret: {
    gait: 'stalk',
    step: [0.4, 1.2],
    speed: 0.15,
    peck: [2, 6],
    feed: [20, 60],
    rest: [15, 40],
    patch: 10,
    treeRest: 0,
    edge: { wet: 1.5, dry: 3 },
  },
};

export type ForageTerrain = {
  blocked: PolygonIndex;
  water: PolygonIndex;
  membership: WaterMembership;
  shores: readonly Shore[];
  shoreIndex: ShoreIndex;
  roads: RoadAccess;
};
type Segment = { a: Point; b: Point };
type Shore = Segment & { wetLeft: boolean };
const SHORE_BIN_M = 12;

/** A horizontal ray only visits edges spanning its y bin; parity includes all polygon holes. */
class WaterMembership {
  private readonly bins = new Map<number, { a: Point; b: Point; polygon: number }[]>();
  private readonly parity = new Set<number>();
  private polygons = 0;

  *addSteps(polygon: Polygon): Generator<void, void, void> {
    const id = this.polygons++;
    let count = 0;
    for (const ring of polygon)
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i]!,
          b = ring[(i + 1) % ring.length]!;
        if (a.y !== b.y) {
          const edge = { a, b, polygon: id };
          for (
            let y = Math.floor(Math.min(a.y, b.y) / SHORE_BIN_M);
            y <= Math.floor(Math.max(a.y, b.y) / SHORE_BIN_M);
            y++
          ) {
            const bin = this.bins.get(y) ?? [];
            bin.push(edge);
            this.bins.set(y, bin);
            if ((++count & 127) === 0) yield;
          }
        }
        if ((i & 127) === 0) yield;
      }
  }

  /** Candidate count exposes bounded work without incrementing a production query counter. */
  candidates(y: number): number {
    return this.bins.get(Math.floor(y / SHORE_BIN_M))?.length ?? 0;
  }

  contains(p: Point): boolean {
    this.parity.clear();
    for (const { a, b, polygon } of this.bins.get(Math.floor(p.y / SHORE_BIN_M)) ?? [])
      if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
        if (this.parity.has(polygon)) this.parity.delete(polygon);
        else this.parity.add(polygon);
      }
    return this.parity.size > 0;
  }
}

/** Metric edge bins shared by union preparation and bounded shore searches. */
class ShoreIndex {
  // Nested numeric keys avoid coordinate-range assumptions and pair collisions.
  private readonly bins = new Map<number, Map<number, number[]>>();
  private readonly found = new Set<number>();
  constructor(private readonly segments: readonly Segment[]) {}

  *addSteps(id: number): Generator<void, void, void> {
    const { a, b } = this.segments[id]!;
    let count = 0;
    for (
      let x = Math.floor(Math.min(a.x, b.x) / SHORE_BIN_M);
      x <= Math.floor(Math.max(a.x, b.x) / SHORE_BIN_M);
      x++
    ) {
      const column = this.bins.get(x) ?? new Map<number, number[]>();
      this.bins.set(x, column);
      for (
        let y = Math.floor(Math.min(a.y, b.y) / SHORE_BIN_M);
        y <= Math.floor(Math.max(a.y, b.y) / SHORE_BIN_M);
        y++
      ) {
        const bin = column.get(y) ?? [];
        bin.push(id);
        column.set(y, bin);
        if ((++count & 127) === 0) yield;
      }
    }
  }

  /** Borrowed query scratch; copy it before another query on this index. */
  nearby(x0: number, y0: number, x1: number, y1: number): Set<number> {
    this.found.clear();
    for (let x = Math.floor(x0 / SHORE_BIN_M); x <= Math.floor(x1 / SHORE_BIN_M); x++) {
      const column = this.bins.get(x);
      if (!column) continue;
      for (let y = Math.floor(y0 / SHORE_BIN_M); y <= Math.floor(y1 / SHORE_BIN_M); y++) {
        const bin = column.get(y);
        if (!bin) continue;
        for (const id of bin) {
          const { a, b } = this.segments[id]!;
          if (
            Math.min(a.x, b.x) <= x1 &&
            Math.max(a.x, b.x) >= x0 &&
            Math.min(a.y, b.y) <= y1 &&
            Math.max(a.y, b.y) >= y0
          )
            this.found.add(id);
        }
      }
    }
    return this.found;
  }
}

export type ForageMode = 'standalone' | 'world';
const prepared = {
  standalone: new WeakMap<LifeGeometry, Map<number, ForageTerrain>>(),
  world: new WeakMap<LifeGeometry, Map<number, ForageTerrain>>(),
};

export function prepareForageTerrain(
  geo: LifeGeometry,
  perMeter: number,
  mode: ForageMode = 'standalone',
): ForageTerrain {
  return complete(prepareForageTerrainSteps(geo, perMeter, mode));
}

export function* prepareForageTerrainSteps(
  geo: LifeGeometry,
  perMeter: number,
  mode: ForageMode = 'standalone',
): Generator<void, ForageTerrain, void> {
  let variants = prepared[mode].get(geo);
  if (!variants) prepared[mode].set(geo, (variants = new Map<number, ForageTerrain>()));
  const cached = variants.get(perMeter);
  if (cached) return cached;
  const blocked = new PolygonIndex(),
    water = new PolygonIndex();
  const membership = new WaterMembership();
  const edges: Segment[] = [];
  for (const area of geo.areas ?? []) {
    if (area.kind !== 'blocked') continue;
    if (!area.water && mode === 'world') continue;
    const polygon = transformPolygon(area.rings, 0, 0, 1 / perMeter);
    yield* (area.water ? water : blocked).addSteps(polygon);
    if (area.water) yield* membership.addSteps(polygon);
    if (area.water)
      for (const ring of polygon) {
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i]!,
            b = ring[(i + 1) % ring.length]!;
          if (a.x !== b.x || a.y !== b.y) edges.push({ a, b });
          if ((i & 127) === 0) yield;
        }
      }
  }
  const edgeIndex = new ShoreIndex(edges);
  for (let i = 0; i < edges.length; i++) yield* edgeIndex.addSteps(i);
  const shores: Shore[] = [];
  for (const edge of edges) {
    const { a, b } = edge;
    const dx = b.x - a.x,
      dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    const cuts = [0, 1];
    const cut = (t: number) => {
      if (t > 0 && t < 1) cuts.push(t);
    };
    let count = 0;
    for (const id of edgeIndex.nearby(
      Math.min(a.x, b.x),
      Math.min(a.y, b.y),
      Math.max(a.x, b.x),
      Math.max(a.y, b.y),
    )) {
      const other = edges[id]!;
      const ox = other.b.x - other.a.x,
        oy = other.b.y - other.a.y;
      const cx = other.a.x - a.x,
        cy = other.a.y - a.y;
      const cross = dx * oy - dy * ox;
      if (Math.abs(cross) > 1e-10) {
        const t = (cx * oy - cy * ox) / cross;
        const u = (cx * dy - cy * dx) / cross;
        if (u >= 0 && u <= 1) cut(t);
      } else if (Math.abs(cx * dy - cy * dx) <= 1e-8 * length) {
        cut((cx * dx + cy * dy) / (length * length));
        cut(((other.b.x - a.x) * dx + (other.b.y - a.y) * dy) / (length * length));
      }
      if ((++count & 127) === 0) yield;
    }
    cuts.sort((a, b) => a - b);
    for (let i = 1; i < cuts.length; i++) {
      const t0 = cuts[i - 1]!,
        t1 = cuts[i]!;
      if ((t1 - t0) * length < 1e-8) continue;
      const middle = (t0 + t1) / 2;
      const p = { x: a.x + dx * middle, y: a.y + dy * middle };
      const epsilon = Math.min(1e-6, ((t1 - t0) * length) / 1000);
      const nx = (-dy / length) * epsilon,
        ny = (dx / length) * epsilon;
      const left = membership.contains({ x: p.x + nx, y: p.y + ny });
      const right = membership.contains({ x: p.x - nx, y: p.y - ny });
      if (left !== right)
        shores.push({
          a: { x: a.x + dx * t0, y: a.y + dy * t0 },
          b: { x: a.x + dx * t1, y: a.y + dy * t1 },
          wetLeft: left,
        });
      yield;
    }
  }
  const shoreIndex = new ShoreIndex(shores);
  for (let i = 0; i < shores.length; i++) yield* shoreIndex.addSteps(i);
  const roads = (yield* prepareRoadTerrainSteps(geo, perMeter)).access;
  const terrain = { blocked, water, membership, shores, shoreIndex, roads };
  variants.set(perMeter, terrain);
  return terrain;
}

const metric = (p: Point, perMeter: number): Point => ({ x: p.x / perMeter, y: p.y / perMeter });
function nearestFraction(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  return Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
}

/** Signed metres; Infinity outside the requested radius, including deep water. */
export function shoreDistance(p: Point, terrain: ForageTerrain, radius = Infinity): number {
  let squared = Infinity;
  const ids = Number.isFinite(radius)
    ? terrain.shoreIndex.nearby(p.x - radius, p.y - radius, p.x + radius, p.y + radius)
    : terrain.shores.keys();
  for (const id of ids) {
    const { a, b } = terrain.shores[id]!;
    const t = nearestFraction(p, a, b);
    const dx = p.x - (a.x + t * (b.x - a.x)),
      dy = p.y - (a.y + t * (b.y - a.y));
    squared = Math.min(squared, dx * dx + dy * dy);
  }
  const distance = Math.sqrt(squared);
  if (!Number.isFinite(distance) || distance > radius) return Infinity;
  return terrain.membership.contains(p) ? -distance : distance;
}

export function forageable(
  species: BirdSpecies,
  habitat: Habitat,
  x: number,
  y: number,
  terrain: ForageTerrain,
  perMeter: number,
): boolean {
  const p = { x, y };
  return forageMovement(species, habitat, p, p, terrain, perMeter);
}

/** Certify once at target selection; interpolation then needs no terrain queries. */
export function forageMovement(
  species: BirdSpecies,
  habitat: Habitat,
  from: Point,
  to: Point,
  terrain: ForageTerrain,
  perMeter: number,
): boolean {
  const spec = FORAGE_SPECIES[species];
  if (!spec || !inTile(from) || !inTile(to)) return false;
  const a = metric(from, perMeter),
    b = metric(to, perMeter);
  const dx = b.x - a.x,
    dy = b.y - a.y,
    length = Math.hypot(dx, dy);
  const bodies = [segmentBody(a, b, 0.01)];
  if (terrain.blocked.hits(bodies) || !terrain.roads.allows(bodies, false)) return false;
  if (habitat === Habitat.water && spec.edge) {
    const radius = Math.max(spec.edge.wet, spec.edge.dry);
    const d0 = shoreDistance(a, terrain, radius),
      d1 = length === 0 ? d0 : shoreDistance(b, terrain, radius);
    if (d0 < -spec.edge.wet || d0 > spec.edge.dry || d1 < -spec.edge.wet || d1 > spec.edge.dry)
      return false;
    // Signed distance is 1-Lipschitz. These bounds certify the whole straight segment.
    return (d0 + d1 - length) / 2 >= -spec.edge.wet && (d0 + d1 + length) / 2 <= spec.edge.dry;
  }
  return !terrain.water.hits(bodies);
}

export function forageSpot(
  species: BirdSpecies,
  habitat: Habitat,
  origin: Point,
  terrain: ForageTerrain,
  perMeter: number,
  rng: () => number,
  ok = (p: Point) => forageable(species, habitat, p.x, p.y, terrain, perMeter),
  preferred?: Point,
): Point | undefined {
  const spec = FORAGE_SPECIES[species];
  if (!spec) return;
  const p = metric(origin, perMeter);
  const banks =
    habitat === Habitat.water && spec.edge
      ? [
          ...terrain.shoreIndex.nearby(
            p.x - FORAGE.reach,
            p.y - FORAGE.reach,
            p.x + FORAGE.reach,
            p.y + FORAGE.reach,
          ),
        ]
          .map((id) => {
            const { a, b } = terrain.shores[id]!;
            const t = nearestFraction(p, a, b);
            const x = a.x + t * (b.x - a.x),
              y = a.y + t * (b.y - a.y);
            return { id, x, y, a, b, distance: Math.hypot(x - p.x, y - p.y) };
          })
          .filter((bank) => bank.distance <= FORAGE.reach)
          .sort((a, b) => a.distance - b.distance || a.id - b.id)
      : undefined;
  for (let i = 0; i < FORAGE.attempts; i++) {
    let candidate: Point;
    if (i === 0 && preferred) candidate = preferred;
    else if (banks) {
      if (!banks.length) return;
      const bank = banks[(i - (preferred ? 1 : 0)) % banks.length]!;
      const dx = bank.b.x - bank.a.x,
        dy = bank.b.y - bank.a.y,
        length = Math.hypot(dx, dy);
      const nudge = i === 0 ? 0 : (rng() - 0.5) * 2 * spec.edge!.wet;
      candidate = {
        x: (bank.x - (dy / length) * nudge) * perMeter,
        y: (bank.y + (dx / length) * nudge) * perMeter,
      };
    } else {
      const angle = rng() * 2 * Math.PI,
        radius = Math.sqrt(rng()) * spec.patch * perMeter;
      candidate = {
        x: origin.x + Math.cos(angle) * radius,
        y: origin.y + Math.sin(angle) * radius,
      };
    }
    if (ok(candidate)) return candidate;
  }
}

/** Prepare bounded local placement candidates once; the caller counts and validates each. */
export function forageOffsets(
  species: BirdSpecies,
  habitat: Habitat,
  origin: Point,
  terrain: ForageTerrain,
  perMeter: number,
  rng: () => number,
): () => Point | undefined {
  const spec = FORAGE_SPECIES[species];
  if (!spec) return () => undefined;
  if (habitat !== Habitat.water || !spec.edge)
    return () => {
      const angle = rng() * 2 * Math.PI;
      const radius = Math.sqrt(rng()) * spec.patch * perMeter;
      return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
    };
  const p = metric(origin, perMeter);
  const banks = [
    ...terrain.shoreIndex.nearby(
      p.x - spec.patch,
      p.y - spec.patch,
      p.x + spec.patch,
      p.y + spec.patch,
    ),
  ].flatMap((id) => {
    const bank = terrain.shores[id]!;
    const dx = bank.b.x - bank.a.x,
      dy = bank.b.y - bank.a.y;
    const squared = dx * dx + dy * dy;
    const projection = ((p.x - bank.a.x) * dx + (p.y - bank.a.y) * dy) / squared;
    const cross = (p.x - bank.a.x) * dy - (p.y - bank.a.y) * dx;
    const perpendicular = (cross * cross) / squared;
    if (perpendicular > spec.patch * spec.patch) return [];
    const reach = Math.sqrt((spec.patch * spec.patch - perpendicular) / squared);
    const lo = Math.max(0, projection - reach),
      hi = Math.min(1, projection + reach);
    return lo <= hi ? [{ bank, dx, dy, length: Math.sqrt(squared), lo, hi }] : [];
  });
  return () => {
    if (!banks.length) return;
    const { bank, dx, dy, length, lo, hi } = banks[Math.floor(rng() * banks.length)]!;
    const t = lo + (hi - lo) * rng();
    const nudge = between(rng, [-spec.edge!.dry, spec.edge!.wet]) * (bank.wetLeft ? 1 : -1);
    return {
      x: (bank.a.x + dx * t - (dy / length) * nudge) * perMeter - origin.x,
      y: (bank.a.y + dy * t + (dx / length) * nudge) * perMeter - origin.y,
    };
  };
}

export type GroundForager = {
  /** Current offsets from the flock centre, in tile units. */
  gx: number;
  gy: number;
  /** Certified target offsets in the same coordinate system. */
  tx: number;
  ty: number;
  /** Ground heading, in radians. */
  face: number;
  /** Seconds until the next ground movement decision. */
  wait: number;
};
export type ForageContext = {
  perMeter: number;
  x: number;
  y: number;
  lx: number;
  ly: number;
  ok: (from: Point, to: Point) => boolean;
};

export function isForager(bird: Partial<GroundForager>): bird is GroundForager {
  return (
    bird.gx !== undefined &&
    bird.gy !== undefined &&
    bird.tx !== undefined &&
    bird.ty !== undefined &&
    bird.face !== undefined &&
    bird.wait !== undefined
  );
}

export function stepForager(
  bird: GroundForager,
  spec: ForageSpec,
  dt: number,
  rng: () => number,
  context: ForageContext,
): void {
  if (dt <= 0) return;
  const { perMeter, x, y, lx, ly } = context;
  let dx = bird.tx - bird.gx,
    dy = bird.ty - bird.gy;
  if (dx === 0 && dy === 0) {
    bird.wait -= dt;
    if (bird.wait > 0) return;
    const from = { x: x + bird.gx, y: y + bird.gy };
    const atEdge = Math.hypot(from.x - lx, from.y - ly) > (spec.patch - spec.step[1]) * perMeter;
    const face =
      (atEdge ? Math.atan2(ly - from.y, lx - from.x) : bird.face) +
      ((rng() - 0.5) * 2 * Math.PI) / 3;
    const distance = between(rng, spec.step) * perMeter;
    const to = { x: from.x + Math.cos(face) * distance, y: from.y + Math.sin(face) * distance };
    if (
      Math.hypot(to.x - lx, to.y - ly) > spec.patch * perMeter ||
      !inTile(to) ||
      !context.ok(from, to)
    ) {
      bird.face += (2 * Math.PI) / 3;
      bird.wait = between(rng, spec.peck);
      return;
    }
    bird.tx = to.x - x;
    bird.ty = to.y - y;
    dx = bird.tx - bird.gx;
    dy = bird.ty - bird.gy;
  }
  const distance = Math.hypot(dx, dy);
  const reach = spec.gait === 'hop' ? distance : spec.speed * perMeter * dt;
  bird.face = Math.atan2(dy, dx);
  if (distance <= reach) {
    bird.gx = bird.tx;
    bird.gy = bird.ty;
    bird.wait = between(rng, spec.peck);
  } else {
    bird.gx += (dx / distance) * reach;
    bird.gy += (dy / distance) * reach;
  }
}

/** Recenter without moving any bird or changing a previously certified target. */
export function rebaseForagers(
  flock: { x: number; y: number; lx: number; ly: number },
  birds: readonly Partial<GroundForager>[],
  patch: number,
): void {
  let dx = 0,
    dy = 0,
    count = 0;
  for (const bird of birds)
    if (isForager(bird)) {
      dx += bird.gx;
      dy += bird.gy;
      count++;
    }
  if (!count) return;
  let x = flock.x + dx / count,
    y = flock.y + dy / count;
  const distance = Math.hypot(x - flock.lx, y - flock.ly);
  if (distance > patch) {
    x = flock.lx + ((x - flock.lx) / distance) * patch;
    y = flock.ly + ((y - flock.ly) / distance) * patch;
  }
  dx = x - flock.x;
  dy = y - flock.y;
  flock.x = x;
  flock.y = y;
  for (const bird of birds)
    if (isForager(bird)) {
      bird.gx -= dx;
      bird.gy -= dy;
      bird.tx -= dx;
      bird.ty -= dy;
    }
}
