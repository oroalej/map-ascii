import type { Geometry, Position } from 'geojson';
import { intersection, type Geom } from 'polyclip-ts';
import type { AtlasFeature } from '../03-normalize';
import { clipLine } from './coastline';
import { interiorPoint } from './frontage';
import { bboxPolygon, inTerritory, removeVoid, type Territory } from './territory';

/** Choose from reachable geometry only; candidate clipping never changes display geometry. */
export function territoryAnchor(g: Geometry, territory: Territory): Position | undefined {
  const admitted = (p: Position) => inTerritory(p[0]!, p[1]!, territory);
  switch (g.type) {
    case 'Point':
      return admitted(g.coordinates) ? g.coordinates : undefined;
    case 'MultiPoint':
      return g.coordinates.find(admitted);
    case 'Polygon':
    case 'MultiPolygon': {
      const coordinates = intersection(
        g.coordinates as Geom,
        bboxPolygon(territory.regionBounds).coordinates as Geom,
        ...(territory.territory ? [territory.territory.coordinates as Geom] : []),
      );
      if (!coordinates.length) return undefined;
      const point = interiorPoint({ type: 'MultiPolygon', coordinates });
      return admitted(point) ? point : undefined;
    }
    case 'LineString':
    case 'MultiLineString': {
      const pieces = (g.type === 'LineString' ? [g.coordinates] : g.coordinates)
        .flatMap((line) =>
          clipLine(
            line.map((p): [number, number] => [p[0]!, p[1]!]),
            territory.regionBounds,
          ),
        )
        .sort((a, b) => b.coords.length - a.coords.length);
      for (const { coords } of pieces) {
        const middle = coords[Math.floor(coords.length / 2)]!;
        if (admitted(middle)) return middle;
        const point = coords.find(admitted);
        if (point) return point;
      }
      return undefined;
    }
    case 'GeometryCollection':
      for (const child of g.geometries) {
        const position = territoryAnchor(child, territory);
        if (position) return position;
      }
      return undefined;
  }
}

/** Late display subtraction: full derivation inputs, roof plans and stable identities survive. */
export function displayFeatures(
  features: readonly AtlasFeature[],
  territory: Territory,
): AtlasFeature[] {
  return features.flatMap((source) => {
    const clipped = removeVoid(source, territory);
    if (!clipped) return [];
    const repairs = (['label', 'shop', 'life'] as const).filter((prefix) => {
      const lng = clipped.properties[`${prefix}_lng`],
        lat = clipped.properties[`${prefix}_lat`];
      return (
        territory.territory &&
        lng !== undefined &&
        lat !== undefined &&
        !inTerritory(lng, lat, territory)
      );
    });
    if (!repairs.length) return [clipped];
    const position = territoryAnchor(clipped.geometry, territory);
    const result = { ...clipped, properties: { ...clipped.properties } };
    for (const prefix of repairs) {
      if (position) {
        result.properties[`${prefix}_lng`] = position[0]!;
        result.properties[`${prefix}_lat`] = position[1]!;
      } else {
        delete result.properties[`${prefix}_lng`];
        delete result.properties[`${prefix}_lat`];
      }
    }
    return [result];
  });
}
