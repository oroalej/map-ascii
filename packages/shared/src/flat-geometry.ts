import { MERCATOR_METERS } from './tile-space';

export const METERS_PER_DEGREE = MERCATOR_METERS / 360;
/** Existing geographic row identities and route data use this rounded flat scale. */
export const LEGACY_LOCAL_METERS_PER_DEGREE = 111_320;
type Point = readonly [number, number];

/** Local flat approximation; callers can retain legacy scales for existing route data. */
export function localMetricProjection(
  [lng0, lat0]: Point,
  { latitude = lat0, east = METERS_PER_DEGREE, north = METERS_PER_DEGREE } = {},
) {
  const kx = east * Math.cos((latitude * Math.PI) / 180);
  return {
    to: (p: readonly number[]): [number, number] => [(p[0]! - lng0) * kx, (p[1]! - lat0) * north],
    from: ([x, y]: Point): [number, number] => [lng0 + x / kx, lat0 + y / north],
  };
}

/** Even–odd containment of an outer ring and holes; boundary follows the ray crossing rule. */
export function pointInPolygon([x, y]: Point, polygon: readonly (readonly Point[])[]): boolean {
  let hit = false;
  for (const ring of polygon)
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [ax, ay] = ring[i]!,
        [bx, by] = ring[j]!;
      if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) hit = !hit;
    }
  return hit;
}
