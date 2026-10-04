import type { BBox, LngLat } from '@atlas/shared';
import bbox from '@turf/bbox';
import type { Polygon, MultiPolygon } from 'geojson';
import type { AtlasFeature } from '../03-normalize';
import { bboxesOverlap, bufferBbox, clearanceWidth } from './geo';
import { seatingFootprint } from './footprints';

/** Standing mapped and authored roofs, excluding overhead contours. */
export const isStandingBuilding = (feature: AtlasFeature): boolean =>
  (feature.geometry.type === 'Polygon' || feature.geometry.type === 'MultiPolygon') &&
  feature.properties.class.startsWith('building') &&
  (feature.properties.height ?? 0) > 0 &&
  !feature.properties.detail_overhead;

/** Local full-width capsules; the source centreline may lie outside the requested bounds. */
export function nearbyRoadFootprints(source: readonly AtlasFeature[], bounds: BBox, margin = 0) {
  const out: {
    id: string;
    class: AtlasFeature['properties']['class'];
    geometry: Polygon | MultiPolygon;
    bounds: BBox;
  }[] = [];
  for (const feature of source) {
    const { geometry, properties } = feature;
    if (
      geometry.type !== 'LineString' ||
      (!properties.class.startsWith('road') && properties.class !== 'path')
    )
      continue;
    const width = clearanceWidth(properties, margin);
    const padding = width / 1000;
    if (!bboxesOverlap(bounds, bufferBbox(bbox(feature) as BBox, padding))) continue;
    for (let i = 1; i < geometry.coordinates.length; i++) {
      const start = geometry.coordinates[i - 1]!,
        end = geometry.coordinates[i]!;
      if (start[0] === end[0] && start[1] === end[1]) continue;
      const segmentBounds = bufferBbox(
        [
          Math.min(start[0]!, end[0]!),
          Math.min(start[1]!, end[1]!),
          Math.max(start[0]!, end[0]!),
          Math.max(start[1]!, end[1]!),
        ],
        padding,
      );
      if (!bboxesOverlap(bounds, segmentBounds)) continue;
      const shape = seatingFootprint([start, end] as LngLat[], width);
      out.push({
        id: properties.id,
        class: properties.class,
        geometry: shape,
        bounds: bbox(shape) as BBox,
      });
    }
  }
  return out;
}
