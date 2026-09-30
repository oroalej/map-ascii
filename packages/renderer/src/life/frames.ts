import type { TileId } from '../tiles';
import { EXTENT } from '../raster/geometry';

/** Affine transform from one tile's units to another, including different zoom levels. */
export function frameBetween(from: TileId, to: TileId) {
  const scale = 2 ** (to.z - from.z);
  return { x: (from.x * scale - to.x) * EXTENT, y: (from.y * scale - to.y) * EXTENT, scale };
}
