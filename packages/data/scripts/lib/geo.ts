import { DEFAULT_ROAD_WIDTH_M, type BBox, type LngLat } from '@atlas/shared';
import type { Position } from 'geojson';

export const METERS_PER_DEGREE = 111_320;

/** Local east/north meters, preserving the caller's origin and reference latitude. */
export function localFrame([lng0, lat0]: LngLat, latitude = lat0) {
  const mx = METERS_PER_DEGREE * Math.cos((latitude * Math.PI) / 180);
  return {
    toMeters: ([lng, lat]: Position): LngLat => [
      (lng! - lng0) * mx,
      (lat! - lat0) * METERS_PER_DEGREE,
    ],
    toLngLat: ([x, y]: LngLat): LngLat => [lng0 + x / mx, lat0 + y / METERS_PER_DEGREE],
  };
}

/** Full corridor width; cemetery callers explicitly add their clearance margin. */
export const clearanceWidth = (properties: { class: string; width?: number }, padding = 0) =>
  (properties.width ?? (properties.class === 'path' ? 2 : DEFAULT_ROAD_WIDTH_M)) + padding;

const kmPerDegreeLat = 111.32;

/** Grow a [west, south, east, north] bbox by `km` on every side. */
export function bufferBbox([west, south, east, north]: BBox, km: number): BBox {
  const dLat = km / kmPerDegreeLat;
  const midLat = ((south + north) / 2) * (Math.PI / 180);
  const dLng = km / (kmPerDegreeLat * Math.cos(midLat));
  return [
    Math.max(-180, west - dLng),
    Math.max(-90, south - dLat),
    Math.min(180, east + dLng),
    Math.min(90, north + dLat),
  ];
}

/** Overpass `bounds` → [west, south, east, north]. */
export const fromOverpassBounds = (b: {
  minlat: number;
  minlon: number;
  maxlat: number;
  maxlon: number;
}): BBox => [b.minlon, b.minlat, b.maxlon, b.maxlat];

/** Whether bbox `outer` contains bbox `inner` (edges included). */
export const bboxContains = (outer: BBox, inner: BBox) =>
  inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3];

/** Whether two bboxes overlap (touching counts). */
export const bboxesOverlap = (a: BBox, b: BBox) =>
  a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

/** [west, south, east, north] → Overpass's "south,west,north,east". */
export const toOverpassBbox = ([west, south, east, north]: BBox) =>
  [south, west, north, east].map((n) => n.toFixed(6)).join(',');

/** The overlap of two bboxes. Throws when they don't overlap. */
export function intersectBbox(a: BBox, b: BBox): BBox {
  const out: BBox = [
    Math.max(a[0], b[0]),
    Math.max(a[1], b[1]),
    Math.min(a[2], b[2]),
    Math.min(a[3], b[3]),
  ];
  if (out[0] >= out[2] || out[1] >= out[3]) {
    throw new Error(`Bboxes ${a.join(',')} and ${b.join(',')} don't overlap`);
  }
  return out;
}

/** Whether a point lies inside a bbox (edges included). */
export const inBbox = (lng: number, lat: number, [w, s, e, n]: BBox) =>
  lng >= w && lng <= e && lat >= s && lat <= n;

const bboxSetting = /\[bbox:([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\]/;

/**
 * A query's global `[bbox:…]` setting as [west, south, east, north], and the query without it,
 * or null when it has none.
 */
export function splitOverpassBbox(query: string): { bbox: BBox; rest: string } | null {
  const m = bboxSetting.exec(query);
  if (!m) return null;
  const [south, west, north, east] = m.slice(1).map(Number) as [number, number, number, number];
  return { bbox: [west, south, east, north], rest: query.replace(bboxSetting, '') };
}
