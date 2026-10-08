import { type BBox, type LandmarkArt } from '@atlas/shared';
import { CityArt } from '@atlas/shared/schemas';
import turfBbox from '@turf/bbox';
import turfCentroid from '@turf/centroid';
import type { Feature, Geometry } from 'geojson';

/** Meters per degree of latitude (and of longitude at the equator). */
const METERS_PER_DEGREE = 111_320;

/** A square of `meters` around a point, as a bbox. */
export function bboxAround([lng, lat]: [number, number], meters: number): BBox {
  const dLat = meters / 2 / METERS_PER_DEGREE;
  const dLng = meters / 2 / (METERS_PER_DEGREE * Math.cos((lat * Math.PI) / 180));
  return [lng - dLng, lat - dLat, lng + dLng, lat + dLat];
}

type Placed = Feature<Geometry, { id: string; label_lng?: number; label_lat?: number }>;

const round = (v: number) => Math.round(v * 1e7) / 1e7;

/**
 * Place each art piece on its OSM feature: the feature's footprint (or `footprint_m` around a
 * point) and its label anchor. Fails loudly if a piece's feature is not in the data, or if a
 * point feature's piece has no `footprint_m`.
 */
export function placeArt(features: readonly Placed[], art: readonly LandmarkArt[]): CityArt {
  const byId = new Map(features.map((f) => [f.properties.id, f]));
  const problems: string[] = [];
  const pieces: CityArt['pieces'] = [];
  for (const piece of art) {
    const feature = byId.get(piece.osm_id);
    if (!feature) {
      problems.push(`${piece.id}: ${piece.osm_id} is not in the OSM data`);
      continue;
    }
    const { label_lng, label_lat } = feature.properties;
    const anchor: [number, number] =
      label_lng !== undefined && label_lat !== undefined
        ? [label_lng, label_lat]
        : (turfCentroid(feature).geometry.coordinates as [number, number]);
    const isPoint = feature.geometry.type === 'Point';
    if (isPoint && piece.footprint_m === undefined) {
      problems.push(`${piece.id}: ${piece.osm_id} is a point, so the piece needs footprint_m`);
      continue;
    }
    const bbox = isPoint ? bboxAround(anchor, piece.footprint_m!) : (turfBbox(feature) as BBox);
    pieces.push({
      id: piece.id,
      osm_id: piece.osm_id,
      title: piece.title,
      status: piece.status,
      priority: piece.priority ?? 0,
      bbox: bbox.map(round) as BBox,
      anchor: [round(anchor[0]), round(anchor[1])],
      palette: piece.palette,
      variants: piece.variants,
    });
  }
  if (problems.length > 0) throw new Error(`Landmark art:\n  ${problems.join('\n  ')}`);
  return CityArt.parse({ pieces });
}
