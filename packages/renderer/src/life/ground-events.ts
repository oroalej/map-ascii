/** Bounded geographic permissions shared by event admission and inline/worker cell packing. */
import {
  pointInPolygon,
  localMetricProjection,
  type StreetRoute,
  type MassRoute,
} from '@atlas/shared';
type Point = [number, number];
export type EventGround = {
  regions: Point[][];
  blocked: Point[][];
  water?: Point[][];
  bridges?: Point[][];
};
type RingBounds = { ring: Point[]; w: number; s: number; e: number; n: number };
type RingIndex = { bins: Map<string, RingBounds[]>; large: RingBounds[] };
const BIN = 0.00025;
const ringIndexes = new WeakMap<Point[][], RingIndex>();
const indexes = new WeakMap<
  EventGround,
  {
    regions: RingIndex;
    blocked: RingIndex;
    water: RingIndex;
    bridges: RingIndex;
  }
>();
const EMPTY: Point[][] = [];
const routeGrounds = new WeakMap<StreetRoute | MassRoute, EventGround>();
/** Initialized once on either side of the worker; frame replies carry only route IDs. */
export function groundForRoute(route: StreetRoute | MassRoute): EventGround {
  const saved = routeGrounds.get(route);
  if (saved) return saved;
  const ground: EventGround =
    route.kind === 'mass'
      ? { regions: route.site.grounds, blocked: route.site.blocked }
      : { regions: [], blocked: route.blocked, water: route.water, bridges: route.bridges };
  if (route.kind !== 'mass') {
    const frame = localMetricProjection(route.route[0]!);
    for (let i = 1; i < route.route.length; i++) {
      const a = frame.to(route.route[i - 1]!),
        b = frame.to(route.route[i]!);
      const dx = b[0] - a[0],
        dy = b[1] - a[1],
        d = Math.hypot(dx, dy);
      if (!d) continue;
      const reach = route.segments[i - 1]!.width_m / 2 + route.segments[i - 1]!.sidewalk_m;
      const nx = (-dy / d) * reach,
        ny = (dx / d) * reach;
      ground.regions.push(
        [
          [a[0] + nx, a[1] + ny],
          [b[0] + nx, b[1] + ny],
          [b[0] - nx, b[1] - ny],
          [a[0] - nx, a[1] - ny],
          [a[0] + nx, a[1] + ny],
        ].map((q) => frame.from(q as Point)),
      );
    }
  }
  routeGrounds.set(route, ground);
  return ground;
}
export function groundsForRoutes(
  routes: readonly (StreetRoute | MassRoute | { kind: 'fluvial' })[],
) {
  const grounds = new Map<string, EventGround>();
  for (const route of routes)
    if (route.kind !== 'fluvial') grounds.set(route.id, groundForRoute(route));
  return grounds;
}
function index(rings: Point[][]): RingIndex {
  const saved = ringIndexes.get(rings);
  if (saved) return saved;
  const out: RingIndex = { bins: new Map(), large: [] };
  for (const ring of rings) {
    let w = Infinity,
      s = Infinity,
      e = -Infinity,
      n = -Infinity;
    for (const [x, y] of ring) {
      w = Math.min(w, x);
      e = Math.max(e, x);
      s = Math.min(s, y);
      n = Math.max(n, y);
    }
    const r = { ring, w, s, e, n };
    const x0 = Math.floor(w / BIN),
      x1 = Math.floor(e / BIN);
    const y0 = Math.floor(s / BIN),
      y1 = Math.floor(n / BIN);
    // Bound allocation even for regional rings in legacy archives.
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4096) {
      out.large.push(r);
      continue;
    }
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const key = `${x}/${y}`;
        let bin = out.bins.get(key);
        if (!bin) out.bins.set(key, (bin = []));
        bin.push(r);
      }
  }
  ringIndexes.set(rings, out);
  return out;
}
const contains = (q: Point, r: RingBounds) =>
  q[0] >= r.w && q[0] <= r.e && q[1] >= r.s && q[1] <= r.n && pointInPolygon(q, [r.ring]);
function inside(index: RingIndex, q: Point) {
  const nearby = index.bins.get(`${Math.floor(q[0] / BIN)}/${Math.floor(q[1] / BIN)}`);
  return nearby?.some((r) => contains(q, r)) || index.large.some((r) => contains(q, r));
}
export function eventGroundAllows(ground: EventGround, points: readonly Point[]) {
  let cached = indexes.get(ground);
  if (!cached)
    indexes.set(
      ground,
      (cached = {
        regions: index(ground.regions),
        blocked: index(ground.blocked),
        water: index(ground.water ?? EMPTY),
        bridges: index(ground.bridges ?? EMPTY),
      }),
    );
  return points.every(
    (q) =>
      inside(cached.regions, q) &&
      !inside(cached.blocked, q) &&
      (!inside(cached.water, q) || inside(cached.bridges, q)),
  );
}
/** Water is crossed only inside the explicitly baked bridge carriageway. */
export function eventBridgeAllows(ground: EventGround, points: readonly Point[]) {
  const bridges = index(ground.bridges ?? EMPTY);
  return points.every((q) => inside(bridges, q));
}
