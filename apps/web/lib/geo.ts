import type { SubdivisionArea } from '@atlas/shared';

const EARTH_CIRCUMFERENCE_M = 40_075_016.686;

/** Ground meters per CSS pixel at a latitude and zoom (512-px tiles, as in the renderer). */
export const metersPerPixel = (lat: number, zoom: number) =>
  (EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** zoom);

/**
 * The scale bar (SPEC.md §5 HUD): the longest 1, 2, or 5 × 10ⁿ meters that fits in
 * `maxPixels`, its width in pixels, and its label.
 */
export function scaleBar(
  lat: number,
  zoom: number,
  maxPixels = 120,
): { meters: number; pixels: number; label: string } {
  const perPixel = metersPerPixel(lat, zoom);
  const max = perPixel * maxPixels;
  const power = 10 ** Math.floor(Math.log10(max));
  const step = [5, 2, 1].find((s) => s * power <= max) ?? 1;
  const meters = step * power;
  const label = meters >= 1000 ? `${meters / 1000} km` : `${meters} m`;
  return { meters, pixels: meters / perPixel, label };
}

type Ring = number[][];

/** Even-odd ray casting against one ring of [lng, lat] positions. */
function inRing([x, y]: [number, number], ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] as [number, number];
    const [xj, yj] = ring[j] as [number, number];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inPolygon(point: [number, number], rings: Ring[]): boolean {
  const [outer, ...holes] = rings;
  return !!outer && inRing(point, outer) && !holes.some((h) => inRing(point, h));
}

/** Each area's bounding box, [west, south, east, north], worked out once. */
const boxes = new WeakMap<SubdivisionArea, [number, number, number, number]>();
function boxOf(area: SubdivisionArea) {
  let box = boxes.get(area);
  if (!box) {
    box = [Infinity, Infinity, -Infinity, -Infinity];
    const { geometry } = area;
    const polygons =
      geometry.type === 'Polygon'
        ? [geometry.coordinates as Ring[]]
        : geometry.type === 'MultiPolygon'
          ? (geometry.coordinates as Ring[][])
          : [];
    for (const [outer] of polygons) {
      for (const [x, y] of (outer ?? []) as [number, number][]) {
        box[0] = Math.min(box[0], x);
        box[1] = Math.min(box[1], y);
        box[2] = Math.max(box[2], x);
        box[3] = Math.max(box[3], y);
      }
    }
    boxes.set(area, box);
  }
  return box;
}

/** The subdivision area containing a point, if any (`<city>.subdivisions.json`). */
export function areaAt(
  areas: readonly SubdivisionArea[],
  lng: number,
  lat: number,
): SubdivisionArea | undefined {
  return areas.find((area) => {
    const [west, south, east, north] = boxOf(area);
    if (lng < west || lng > east || lat < south || lat > north) return false;
    const { geometry } = area;
    if (geometry.type === 'Polygon') return inPolygon([lng, lat], geometry.coordinates as Ring[]);
    if (geometry.type === 'MultiPolygon') {
      return (geometry.coordinates as Ring[][]).some((p) => inPolygon([lng, lat], p));
    }
    return false;
  });
}
