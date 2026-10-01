/** Legacy tile projection shared by the worker and pipeline. Keep arithmetic identical. */
export const TILE_EXTENT = 4096;
/** The world's width in Mercator meters. */
export const MERCATOR_METERS = 40_075_016.686;
export type TileAddress = { z: number; x: number; y: number };

export function tileToLngLat(
  { z, x, y }: TileAddress,
  p: { x: number; y: number },
): [number, number] {
  const n = 2 ** z;
  const wx = (x + p.x / TILE_EXTENT) / n;
  const wy = (y + p.y / TILE_EXTENT) / n;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * wy))) * 180) / Math.PI;
  return [wx * 360 - 180, lat];
}

export function lngLatToTile({ z, x, y }: TileAddress, lng: number, lat: number) {
  const n = 2 ** z;
  const phi = (lat * Math.PI) / 180;
  const wy = (1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2;
  return { x: (((lng + 180) / 360) * n - x) * TILE_EXTENT, y: (wy * n - y) * TILE_EXTENT };
}

/** Meters per tile unit at the tile's center latitude. */
export function metersPerUnit({ z, y }: TileAddress): number {
  const n = Math.PI - (2 * Math.PI * (y + 0.5)) / 2 ** z;
  const lat = Math.atan(Math.sinh(n));
  return (MERCATOR_METERS * Math.cos(lat)) / 2 ** z / TILE_EXTENT;
}
