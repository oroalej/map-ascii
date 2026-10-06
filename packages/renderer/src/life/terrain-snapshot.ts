import type { LifeWorld } from './simulate';
import { FrozenPolygonIndex, type FlatPolygonIndex } from './occupancy';
export { flattenPolygons, unflattenPolygons, type FlatPolygons } from './flat-polygons';

type CellTerrain = NonNullable<ReturnType<LifeWorld['cellTerrain']>>;
export type TerrainSnapshot = {
  ref: CellTerrain['ref'];
  blocked: FlatPolygonIndex;
  forbidden: FlatPolygonIndex;
  roads: FlatPolygonIndex;
  trees: FlatPolygonIndex;
};
export function snapshotOf(terrain: CellTerrain) {
  const snapshot: TerrainSnapshot = {
    ref: terrain.ref,
    blocked: terrain.blocked.toFlat(),
    forbidden: terrain.forbidden.toFlat(),
    roads: terrain.roads.toFlat(),
    trees: terrain.trees.toFlat(),
  };
  // Only these newly allocated buffers are transferred; the world's polygons stay intact.
  const transferables = [
    snapshot.blocked,
    snapshot.forbidden,
    snapshot.roads,
    snapshot.trees,
  ].flatMap(
    (flat) =>
      [
        flat.polygons.coords.buffer,
        flat.polygons.rings.buffer,
        flat.polygons.polys.buffer,
        flat.bounds.buffer,
        flat.keys.buffer,
        flat.starts.buffer,
        flat.items.buffer,
      ] as ArrayBuffer[],
  );
  return { snapshot, transferables };
}

export function cellTerrainFrom(snapshot: TerrainSnapshot) {
  return {
    ref: snapshot.ref,
    blocked: new FrozenPolygonIndex(snapshot.blocked),
    access: {
      roads: new FrozenPolygonIndex(snapshot.roads),
      forbidden: new FrozenPolygonIndex(snapshot.forbidden),
    },
    trees: new FrozenPolygonIndex(snapshot.trees),
  };
}
