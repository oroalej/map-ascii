import type { Polygon, Point } from './occupancy';

/** Sentinel offsets: polygon -> rings -> points. Float64 retains simulation coordinates. */
export type FlatPolygons = { coords: Float64Array; rings: Uint32Array; polys: Uint32Array };
export function flattenPolygons(polygons: readonly Polygon[]): FlatPolygons {
  const coords: number[] = [],
    rings = [0],
    polys = [0];
  for (const polygon of polygons) {
    for (const ring of polygon) {
      for (const point of ring) coords.push(point.x, point.y);
      rings.push(coords.length / 2);
    }
    polys.push(rings.length - 1);
  }
  return {
    coords: new Float64Array(coords),
    rings: new Uint32Array(rings),
    polys: new Uint32Array(polys),
  };
}

export function unflattenPolygons(flat: FlatPolygons): Polygon[] {
  const polygons: Polygon[] = [];
  for (let p = 0; p < flat.polys.length - 1; p++) {
    const rings: Point[][] = [];
    for (let r = flat.polys[p]!; r < flat.polys[p + 1]!; r++) {
      const ring: Point[] = [];
      for (let i = flat.rings[r]!; i < flat.rings[r + 1]!; i++)
        ring.push({ x: flat.coords[2 * i]!, y: flat.coords[2 * i + 1]! });
      rings.push(ring);
    }
    polygons.push(rings);
  }
  return polygons;
}
