import type { BBox } from '@atlas/shared';

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
