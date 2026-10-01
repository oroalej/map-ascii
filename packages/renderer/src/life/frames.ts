import type { TileId } from '../tiles';
import { ancestorAt } from '../tiles';
import { EXTENT } from '../raster/geometry';

/** Affine transform from one tile's units to another, including different zoom levels. */
export function frameBetween(from: TileId, to: TileId) {
  const scale = 2 ** (to.z - from.z);
  return { x: (from.x * scale - to.x) * EXTENT, y: (from.y * scale - to.y) * EXTENT, scale };
}

export function overlaps(a: TileId, b: TileId): boolean {
  const z = Math.min(a.z, b.z);
  const aa = ancestorAt(a, z),
    bb = ancestorAt(b, z);
  return aa.x === bb.x && aa.y === bb.y;
}

/** Half-open geographic ownership, including negative buffered coordinates. */
export function insideFootprint(from: TileId, p: { x: number; y: number }, footprint: TileId) {
  const f = frameBetween(from, footprint);
  const x = f.x + p.x * f.scale,
    y = f.y + p.y * f.scale;
  return x >= 0 && x < EXTENT && y >= 0 && y < EXTENT;
}

export function masked(from: TileId, p: { x: number; y: number }, masks?: readonly TileId[]) {
  return !!masks?.some((tile) => insideFootprint(from, p, tile));
}

/** Store a union without duplicates/descendants; four siblings collapse to their parent. */
export function cede(masks: TileId[], footprint: TileId, owner: TileId): void {
  if (!overlaps(footprint, owner)) return;
  let next = footprint.z < owner.z ? owner : footprint;
  if (masks.some((m) => m.z <= next.z && overlaps(m, next))) return;
  for (let i = masks.length - 1; i >= 0; i--)
    if (masks[i]!.z >= next.z && overlaps(masks[i]!, next)) masks.splice(i, 1);
  masks.push(next);
  while (next.z > owner.z) {
    const parent = ancestorAt(next, next.z - 1);
    const siblings = masks.filter((m) => m.z === next.z && overlaps(m, parent));
    if (siblings.length !== 4) break;
    for (const sibling of siblings) masks.splice(masks.indexOf(sibling), 1);
    masks.push(parent);
    next = parent;
  }
}

/** Disjoint quadtree regions owned by a tile when finer loaded footprints cover part of it. */
export function ownedFootprints(tile: TileId, masks: readonly TileId[] = []): TileId[] {
  const relevant = masks.filter((m) => overlaps(tile, m));
  if (!relevant.length) return [tile];
  if (relevant.some((m) => m.z <= tile.z)) return [];
  const out: TileId[] = [];
  for (let dy = 0; dy < 2; dy++)
    for (let dx = 0; dx < 2; dx++)
      out.push(
        ...ownedFootprints({ z: tile.z + 1, x: tile.x * 2 + dx, y: tile.y * 2 + dy }, relevant),
      );
  return out;
}
