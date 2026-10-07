/** Bounded geographic permissions shared by event admission and inline/worker cell packing. */
import {
  pointInPolygon,
  localMetricProjection,
  seasonalAccessRing,
  type StreetRoute,
  type MassRoute,
  type FluvialRoute,
} from '@atlas/shared';
import type { LngLatBounds } from './procession';
type Point = [number, number];
export type EventGround = {
  regions: Point[][];
  blocked: Point[][];
  water?: Point[][];
  bridges?: Point[][];
  seated?: EventGround;
  altar?: EventGround;
};
type RingBounds = { ring: Point[]; w: number; s: number; e: number; n: number };
type RingIndex = { bins: Map<number, RingBounds[]>; large: RingBounds[]; scratch: Set<RingBounds> };
const BIN = 0.00025;
// Latitude spans ±90 degrees, far beyond occupancy's local 16-bit metric bins.
const BIN_ROWS = Math.ceil(180 / BIN) + 1;
const binKey = (x: number, y: number) => x * BIN_ROWS + y;
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
const routeGrounds = new WeakMap<StreetRoute | MassRoute | FluvialRoute, EventGround>();
const groundBounds = new WeakMap<EventGround, LngLatBounds>();
export function streetSidewalks(segment: StreetRoute['segments'][number]) {
  return segment.sidewalks_m ?? { left: segment.sidewalk_m, right: segment.sidewalk_m };
}
/** Shared carriageway/access traversal; asymmetric sidewalks shift the envelope. */
export function routeRings(
  route: StreetRoute,
  options: { sidewalks?: boolean; verges?: boolean } = {},
): Point[][] {
  const rings: Point[][] = [];
  for (let i = 1; i < route.route.length; i++) {
    const segment = route.segments[i - 1]!;
    const tags = options.sidewalks ? streetSidewalks(segment) : { left: 0, right: 0 };
    const sides =
      options.verges && segment.verge_m
        ? {
            left: Math.max(tags.left, segment.verge_m.left),
            right: Math.max(tags.right, segment.verge_m.right),
          }
        : tags;
    const offset = (sides.left - sides.right) / 2;
    const frame = localMetricProjection(route.route[i - 1]!);
    const end = frame.to(route.route[i]!);
    const d = Math.hypot(...end);
    const shift = (q: Point) =>
      frame.from([q[0] - (end[1] / d) * offset, q[1] + (end[0] / d) * offset]);
    rings.push(
      seasonalAccessRing({
        from: offset && d ? shift([0, 0]) : route.route[i - 1]!,
        to: offset && d ? shift(end) : route.route[i]!,
        width_m: segment.width_m + sides.left + sides.right,
      }),
    );
  }
  return rings;
}
/** Full event envelope, independent of the camera; guard callers add their body margin. */
export function eventGroundBounds(ground: EventGround): LngLatBounds {
  const saved = groundBounds.get(ground);
  if (saved) return saved;
  const bounds: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const ring of ground.regions)
    for (const [lng, lat] of ring) {
      bounds[0] = Math.min(bounds[0], lng);
      bounds[1] = Math.min(bounds[1], lat);
      bounds[2] = Math.max(bounds[2], lng);
      bounds[3] = Math.max(bounds[3], lat);
    }
  groundBounds.set(ground, bounds);
  return bounds;
}
/** Initialized once on either side of the worker; frame replies carry only route IDs. */
export function groundForRoute(route: StreetRoute | MassRoute | FluvialRoute): EventGround {
  const saved = routeGrounds.get(route);
  if (saved) return saved;
  const ground: EventGround =
    route.kind === 'mass'
      ? { regions: route.site.grounds, blocked: route.site.blocked }
      : route.kind === 'fluvial'
        ? {
            regions: route.crowd_ground?.grounds ?? [],
            blocked: route.crowd_ground?.blocked ?? [],
            water: route.crowd_ground?.water,
            bridges: route.crowd_ground?.bridges,
          }
        : {
            regions: [
              ...routeRings(route, { sidewalks: true, verges: true }),
              ...(route.crowd_grounds ?? []),
            ],
            blocked: route.blocked,
            water: route.water,
            bridges: route.bridges,
          };
  if (route.kind === 'mass') {
    ground.seated = { regions: route.site.seated_grounds ?? [], blocked: route.site.blocked };
    ground.altar = { regions: route.site.altar_ground ?? [], blocked: route.site.blocked };
  }
  routeGrounds.set(route, ground);
  return ground;
}
export function groundsForRoutes(routes: readonly (StreetRoute | MassRoute | FluvialRoute)[]) {
  const grounds = new Map<string, EventGround>();
  for (const route of routes) grounds.set(route.id, groundForRoute(route));
  return grounds;
}
/** Traffic always closes the mapped carriageway or complete authored precinct. */
export function trafficRings(route: StreetRoute | MassRoute): Point[][] {
  return route.kind === 'mass' ? (route.site.closure_zone ?? []) : routeRings(route);
}
function index(rings: Point[][]): RingIndex {
  const saved = ringIndexes.get(rings);
  if (saved) return saved;
  const out: RingIndex = { bins: new Map(), large: [], scratch: new Set() };
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
        const key = binKey(x, y);
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
  const nearby = index.bins.get(binKey(Math.floor(q[0] / BIN), Math.floor(q[1] / BIN)));
  return nearby?.some((r) => contains(q, r)) || index.large.some((r) => contains(q, r));
}
function crosses(a: Point, b: Point, c: Point, d: Point) {
  const side = (a: Point, b: Point, q: Point) =>
    (b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]);
  return (
    Math.max(a[0], b[0]) >= Math.min(c[0], d[0]) &&
    Math.max(c[0], d[0]) >= Math.min(a[0], b[0]) &&
    Math.max(a[1], b[1]) >= Math.min(c[1], d[1]) &&
    Math.max(c[1], d[1]) >= Math.min(a[1], b[1]) &&
    side(a, b, c) * side(a, b, d) <= 0 &&
    side(c, d, a) * side(c, d, b) <= 0
  );
}
/** Test full edges and enclosed obstacles, including roofs narrower than the sample grid. */
function outlineHits(index: RingIndex, outline: readonly Point[]) {
  if (!index.bins.size && !index.large.length) return false;
  let w = Infinity,
    e = -Infinity,
    s = Infinity,
    n = -Infinity;
  for (const [x, y] of outline) {
    w = Math.min(w, x);
    e = Math.max(e, x);
    s = Math.min(s, y);
    n = Math.max(n, y);
  }
  const nearby = index.scratch;
  nearby.clear();
  for (const r of index.large) nearby.add(r);
  for (let y = Math.floor(s / BIN); y <= Math.floor(n / BIN); y++)
    for (let x = Math.floor(w / BIN); x <= Math.floor(e / BIN); x++) {
      const bin = index.bins.get(binKey(x, y));
      if (bin) for (const r of bin) nearby.add(r);
    }
  for (const r of nearby)
    if (
      r.w <= e &&
      r.e >= w &&
      r.s <= n &&
      r.n >= s &&
      (outline.some((q) => contains(q, r)) ||
        r.ring.some((q) => pointInPolygon(q, [outline])) ||
        outline.some((a, i) =>
          r.ring.some((c, j) =>
            crosses(a, outline[(i + 1) % outline.length]!, c, r.ring[(j + 1) % r.ring.length]!),
          ),
        ))
    )
      return true;
  return false;
}
export function eventGroundAllows(
  ground: EventGround,
  points: readonly Point[],
  outline?: readonly Point[],
) {
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
  return (
    (!outline || !outlineHits(cached.blocked, outline)) &&
    (!outline ||
      !outlineHits(cached.water, outline) ||
      points.every((q) => inside(cached.bridges, q))) &&
    points.every(
      (q) =>
        inside(cached.regions, q) &&
        !inside(cached.blocked, q) &&
        (!inside(cached.water, q) || inside(cached.bridges, q)),
    )
  );
}
/** Water is crossed only inside the explicitly baked bridge carriageway. */
export function eventBridgeAllows(ground: EventGround, points: readonly Point[]) {
  const bridges = index(ground.bridges ?? EMPTY);
  return points.every((q) => inside(bridges, q));
}
/** Candidate pruning for partial coarse cells; admission still checks every subcell. */
export function eventGroundTouches(ground: EventGround, outline: readonly Point[]) {
  const regions = index(ground.regions);
  return outline.some((q) => inside(regions, q)) || outlineHits(regions, outline);
}
