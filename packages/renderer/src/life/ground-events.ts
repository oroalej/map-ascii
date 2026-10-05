/** Bounded geographic permissions shared by event admission and inline/worker cell packing. */
import { pointInPolygon } from '@atlas/shared';
export type EventGround = { regions: [number, number][][]; blocked: [number, number][][] };
type RingBounds = { ring: [number, number][]; w: number; s: number; e: number; n: number };
const indexes = new WeakMap<EventGround, { regions: RingBounds[]; blocked: RingBounds[] }>();
const ringIndexes = new WeakMap<[number, number][][], RingBounds[]>();
const index = (rings: [number, number][][]) => {
  const cached = ringIndexes.get(rings);
  if (cached) return cached;
  const bounds = rings.map((ring) => {
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
    return { ring, w, s, e, n };
  });
  ringIndexes.set(rings, bounds);
  return bounds;
};
const contains = ([x, y]: [number, number], r: RingBounds) =>
  x >= r.w && x <= r.e && y >= r.s && y <= r.n && pointInPolygon([x, y], [r.ring]);
export function eventGroundAllows(ground: EventGround, points: readonly [number, number][]) {
  let cached = indexes.get(ground);
  if (!cached)
    indexes.set(
      ground,
      (cached = { regions: index(ground.regions), blocked: index(ground.blocked) }),
    );
  return points.every(
    (q) =>
      cached.regions.some((r) => contains(q, r)) && !cached.blocked.some((r) => contains(q, r)),
  );
}
