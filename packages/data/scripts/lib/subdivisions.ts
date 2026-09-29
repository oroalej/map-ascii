/**
 * Subdivision areas (ROADMAP open decision, settled in Phase 2). Mapped boundary polygons win.
 * The rest of the city is split among the subdivision `place` nodes that have no mapped
 * boundary: each gets the Voronoi cell around its node, clipped to the city boundary minus the
 * mapped areas, and flagged approximate.
 */
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import turfBbox from '@turf/bbox';
import { featureCollection, point } from '@turf/helpers';
import turfVoronoi from '@turf/voronoi';
import type { Feature, MultiPolygon, Polygon, Position } from 'geojson';
import { difference, intersection, type Geom } from 'polyclip-ts';
import type { Tags } from './classify';

export type Area = {
  name: string;
  approximate: boolean;
  feature: Feature<Polygon | MultiPolygon>;
  bbox: [number, number, number, number];
};

type PlaceNode = { name: string; position: Position };

/** Place kinds that can stand for a subdivision when the node has no `admin_level`. */
const subdivisionPlaces = new Set(['quarter', 'village', 'suburb']);

/**
 * Whether a `place` node names a subdivision: its `admin_level` is the subdivision level, or
 * it has none and is a quarter, village, or suburb.
 */
export function isSubdivisionPlace(tags: Tags, subdivisionLevel: number): boolean {
  if (!tags.place || !tags.name) return false;
  if (tags.admin_level !== undefined) return tags.admin_level === String(subdivisionLevel);
  return subdivisionPlaces.has(tags.place);
}

const asGeom = (geometry: Polygon | MultiPolygon): Geom => geometry.coordinates as Geom;

const toFeature = (coordinates: Position[][][]): Feature<Polygon | MultiPolygon> => ({
  type: 'Feature',
  properties: {},
  geometry:
    coordinates.length === 1
      ? { type: 'Polygon', coordinates: coordinates[0]! }
      : { type: 'MultiPolygon', coordinates },
});

const area = (name: string, approximate: boolean, feature: Feature<Polygon | MultiPolygon>) => ({
  name,
  approximate,
  feature,
  bbox: turfBbox(feature) as Area['bbox'],
});

/**
 * All subdivision areas: the mapped ones, then approximate ones for `places` inside the city
 * that have no mapped area of the same name.
 */
export function subdivisionAreas(
  city: Feature<Polygon | MultiPolygon>,
  mapped: readonly { name: string; feature: Feature<Polygon | MultiPolygon> }[],
  places: readonly PlaceNode[],
): Area[] {
  const out: Area[] = mapped.map((m) => area(m.name, false, m.feature));
  const mappedNames = new Set(mapped.map((m) => m.name));
  const seen = new Set<string>();
  const nodes = places.filter((p) => {
    if (mappedNames.has(p.name) || seen.has(p.name)) return false;
    if (!booleanPointInPolygon(p.position, city)) return false;
    // A node inside a mapped area belongs to that area (e.g. a sitio), not a new one.
    if (mapped.some((m) => booleanPointInPolygon(p.position, m.feature))) return false;
    seen.add(p.name);
    return true;
  });
  if (nodes.length === 0) return out;

  const cityGeom = asGeom(city.geometry);
  const available =
    mapped.length > 0
      ? difference(cityGeom, ...mapped.map((m) => asGeom(m.feature.geometry)))
      : cityGeom;
  const [w, s, e, n] = turfBbox(city);
  const cells = turfVoronoi(
    featureCollection(nodes.map((p) => point(p.position as [number, number]))),
    { bbox: [w - 0.01, s - 0.01, e + 0.01, n + 0.01] },
  );
  nodes.forEach((node, i) => {
    const cell = cells.features[i];
    if (!cell) return;
    const clipped = intersection(asGeom(cell.geometry), available);
    if (clipped.length > 0) out.push(area(node.name, true, toFeature(clipped)));
  });
  return out;
}

/** The area containing a point, mapped areas first. */
export function areaAt(position: Position, areas: readonly Area[]): Area | undefined {
  const [x, y] = position as [number, number];
  for (const a of areas) {
    const [w, s, e, n] = a.bbox;
    if (x < w || x > e || y < s || y > n) continue;
    if (booleanPointInPolygon(position, a.feature)) return a;
  }
  return undefined;
}
