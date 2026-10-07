import type { Geometry, Position } from 'geojson';
import type { AtlasFeature } from '../03-normalize';
import { interiorPoint } from './frontage';
import { inVoid, removeVoid, type Territory } from './territory';

/** A surviving anchor, without taking a centroid across disconnected visible pieces. */
function anchor(g: Geometry): Position | undefined {
  switch (g.type) {
    case 'Point':
      return g.coordinates;
    case 'MultiPoint':
      return g.coordinates[0];
    case 'Polygon':
    case 'MultiPolygon':
      return interiorPoint(g);
    case 'LineString':
      return g.coordinates[Math.floor(g.coordinates.length / 2)];
    case 'MultiLineString':
      return anchor({
        type: 'LineString',
        coordinates: g.coordinates.reduce((a, b) => (a.length >= b.length ? a : b), []),
      });
    case 'GeometryCollection':
      return g.geometries.flatMap((g) => (anchor(g) ? [anchor(g)!] : []))[0];
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
    let result = clipped;
    for (const prefix of ['label', 'shop', 'life'] as const) {
      const lng = result.properties[`${prefix}_lng`],
        lat = result.properties[`${prefix}_lat`];
      if (lng === undefined || lat === undefined || !inVoid([lng, lat], territory)) continue;
      const position = anchor(result.geometry);
      result = { ...result, properties: { ...result.properties } };
      if (position && !inVoid(position, territory)) {
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
