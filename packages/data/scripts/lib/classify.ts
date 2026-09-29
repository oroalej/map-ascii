import type { AtlasClass, TileLayer } from '@atlas/shared';

export type Tags = Readonly<Record<string, string | undefined>>;
export type GeometryKind = 'point' | 'line' | 'area';

const oneOf = (value: string | undefined, ...options: string[]) =>
  value !== undefined && options.includes(value);

const highwayClass = (highway: string | undefined): AtlasClass | null => {
  const base = highway?.replace(/_link$/, '');
  if (oneOf(base, 'motorway', 'trunk', 'primary')) return 'road_major';
  if (oneOf(base, 'secondary', 'tertiary')) return 'road_mid';
  if (oneOf(highway, 'residential', 'unclassified', 'service', 'living_street')) {
    return 'road_minor';
  }
  if (oneOf(highway, 'footway', 'path', 'pedestrian', 'steps', 'track')) return 'path';
  return null;
};

/** The specific building class a feature's tags imply, if any (ignoring `building=*`). */
const buildingKind = (tags: Tags): AtlasClass | null => {
  if (oneOf(tags.building, 'church', 'cathedral', 'chapel')) return 'building_religious';
  if (tags.amenity === 'place_of_worship') return 'building_religious';
  if (oneOf(tags.amenity, 'school', 'university', 'college')) return 'building_school';
  if (tags.amenity === 'marketplace' || oneOf(tags.shop, 'mall', 'supermarket')) {
    return 'building_market';
  }
  return null;
};

const placeLabels = ['city', 'town', 'village', 'suburb', 'quarter', 'neighbourhood'];

/**
 * Map a feature's OSM tags to an atlas class (DATA.md §3), or null to drop it.
 * `subdivisionLevel` is the city's `subdivision.admin_level`.
 */
export function classify(
  tags: Tags,
  kind: GeometryKind,
  subdivisionLevel: number,
): AtlasClass | null {
  if (tags.boundary === 'administrative') {
    return kind === 'area' && tags.admin_level === String(subdivisionLevel)
      ? 'admin_subdivision'
      : null;
  }

  if (kind === 'point') {
    if (oneOf(tags.place, ...placeLabels) && tags.name) return 'place_label';
    return buildingKind(tags);
  }

  if (kind === 'line') {
    if (tags.highway) return highwayClass(tags.highway);
    if (oneOf(tags.waterway, 'river', 'stream', 'canal')) return 'water_river';
    return null;
  }

  // Areas
  if (tags.building && tags.building !== 'no') return buildingKind(tags) ?? 'building';
  const kindOfBuilding = buildingKind(tags);
  if (kindOfBuilding) return kindOfBuilding;
  if (tags.natural === 'water' || tags.water !== undefined) return 'water_area';
  if (tags.waterway === 'riverbank') return 'water_area';
  if (oneOf(tags.leisure, 'park', 'garden', 'playground') || tags.place === 'square') return 'park';
  if (tags.natural === 'wood' || tags.landuse === 'forest') return 'trees';
  if (oneOf(tags.landuse, 'farmland', 'paddy') || tags.crop === 'rice') return 'farmland';
  return null;
}

/** The tile layer a class is written to. Point features other than labels go to `poi`. */
export function layerFor(atlasClass: AtlasClass, kind: GeometryKind): TileLayer {
  if (atlasClass === 'place_label') return 'labels';
  if (kind === 'point') return 'poi';
  if (atlasClass.startsWith('water_')) return 'water';
  if (atlasClass.startsWith('road_') || atlasClass === 'path') return 'roads';
  if (atlasClass.startsWith('building')) return 'buildings';
  if (atlasClass.startsWith('admin_')) return 'admin';
  return 'landuse';
}

const defaultHeights: Partial<Record<AtlasClass, number>> = {
  building: 6,
  building_religious: 15,
  building_school: 9,
  building_market: 8,
};

/**
 * Building height in meters: `height`, else `building:levels` × 3, else a class default.
 * Only actual buildings have one: a school or church *ground* (e.g. `amenity=school` on a
 * campus polygon without `building=*`) shares the building class but gets no height, which
 * is how the renderer tells grounds from buildings.
 */
export function buildingHeight(tags: Tags, atlasClass: AtlasClass): number | undefined {
  if (!atlasClass.startsWith('building')) return undefined;
  if (!tags.building || tags.building === 'no') return undefined;
  const height = Number.parseFloat(tags.height ?? '');
  if (Number.isFinite(height) && height > 0) return Math.round(height * 10) / 10;
  const levels = Number.parseFloat(tags['building:levels'] ?? '');
  if (Number.isFinite(levels) && levels > 0) return levels * 3;
  return defaultHeights[atlasClass];
}
