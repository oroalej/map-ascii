import { ROOF_PLAN_MIN_TILE_ZOOM } from '@atlas/shared';
import type { AtlasFeature } from '../03-normalize';

/** Keep low-zoom geometry without carrying unused roof JSON; zoom ranges never overlap. */
export function roofTileRecords(feature: AtlasFeature): AtlasFeature[] {
  if (!feature.properties.roof_plan || feature.tippecanoe.minzoom >= ROOF_PLAN_MIN_TILE_ZOOM)
    return [feature];
  const { roof_plan: _plan, ...properties } = feature.properties;
  const low: AtlasFeature = {
    ...feature,
    properties,
    tippecanoe: {
      ...feature.tippecanoe,
      maxzoom: Math.min(feature.tippecanoe.maxzoom, ROOF_PLAN_MIN_TILE_ZOOM - 1),
    },
  };
  if (feature.tippecanoe.maxzoom < ROOF_PLAN_MIN_TILE_ZOOM) return [low];
  return [
    low,
    {
      ...feature,
      tippecanoe: { ...feature.tippecanoe, minzoom: ROOF_PLAN_MIN_TILE_ZOOM },
    },
  ];
}
