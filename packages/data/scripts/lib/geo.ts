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
