/** Bounded ground feeding, using the same immutable metric terrain as walking agents. */
import { Habitat, type BirdSpecies } from './birds';
import { FORAGE } from './config';
import { inTile, type LifeGeometry } from './geometry';
import { PolygonIndex, type Body, type Point } from './occupancy';
import { between } from './random';
import { prepareRoadTerrain, transformPolygon, type RoadAccess } from './terrain';

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
  shores: readonly { a: Point; b: Point }[];
  roads: RoadAccess;
};
const prepared = new WeakMap<LifeGeometry, Map<number, ForageTerrain>>();

export function prepareForageTerrain(geo: LifeGeometry, perMeter: number): ForageTerrain {
  let variants = prepared.get(geo);
  if (!variants) prepared.set(geo, (variants = new Map<number, ForageTerrain>()));
  const cached = variants.get(perMeter);
  if (cached) return cached;
  const blocked = new PolygonIndex(),
    water = new PolygonIndex();
  const shores: { a: Point; b: Point }[] = [];
  for (const area of geo.areas ?? []) {
    if (area.kind !== 'blocked') continue;
    const polygon = transformPolygon(area.rings, 0, 0, 1 / perMeter);
    (area.water ? water : blocked).add(polygon);
    if (area.water)
      for (const ring of polygon) {
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i]!,
            b = ring[(i + 1) % ring.length]!;
          if (a.x !== b.x || a.y !== b.y) shores.push({ a, b });
        }
      }
  }
  const terrain = { blocked, water, shores, roads: prepareRoadTerrain(geo, perMeter).access };
  variants.set(perMeter, terrain);
  return terrain;
}

const pointBody = (p: Point, size = 0.01): Body => ({
  ...p,
  hx: 1,
  hy: 0,
  length: size,
  width: size,
});
const metric = (p: Point, perMeter: number): Point => ({ x: p.x / perMeter, y: p.y / perMeter });
function nearest(p: Point, a: Point, b: Point): Point {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
  return { x: a.x + t * dx, y: a.y + t * dy };
}

/** Signed metres: negative in water, positive on dry ground, including islands/holes. */
export function shoreDistance(p: Point, terrain: ForageTerrain): number {
  let distance = Infinity;
  for (const { a, b } of terrain.shores) {
    const q = nearest(p, a, b);
    distance = Math.min(distance, Math.hypot(p.x - q.x, p.y - q.y));
  }
  return terrain.water.hits([pointBody(p, 0)]) ? -distance : distance;
}

export function forageable(
  species: BirdSpecies,
  habitat: Habitat,
  x: number,
  y: number,
  terrain: ForageTerrain,
  perMeter: number,
): boolean {
  const spec = FORAGE_SPECIES[species];
  if (!spec || !inTile({ x, y })) return false;
  const p = metric({ x, y }, perMeter),
    bodies = [pointBody(p)];
  if (terrain.blocked.hits(bodies) || !terrain.roads.allows(bodies, false)) return false;
  if (habitat === Habitat.water && spec.edge) {
    const distance = shoreDistance(p, terrain);
    return distance >= -spec.edge.wet && distance <= spec.edge.dry;
  }
  return !terrain.water.hits(bodies);
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
  const bodies: Body[] = [
    {
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
      hx: length ? dx / length : 1,
      hy: length ? dy / length : 0,
      length: length + 0.01,
      width: 0.01,
    },
  ];
  if (terrain.blocked.hits(bodies) || !terrain.roads.allows(bodies, false)) return false;
  if (habitat === Habitat.water && spec.edge) {
    const d0 = shoreDistance(a, terrain),
      d1 = shoreDistance(b, terrain);
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
      ? terrain.shores
          .map(({ a, b }) => {
            const q = nearest(p, a, b);
            return { q, a, b, distance: Math.hypot(q.x - p.x, q.y - p.y) };
          })
          .filter((bank) => bank.distance <= FORAGE.reach)
          .sort((a, b) => a.distance - b.distance)
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
        x: (bank.q.x - (dy / length) * nudge) * perMeter,
        y: (bank.q.y + (dx / length) * nudge) * perMeter,
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

export type GroundForager = {
  gx: number;
  gy: number;
  tx: number;
  ty: number;
  face: number;
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
