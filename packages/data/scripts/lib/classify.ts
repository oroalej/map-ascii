import type { AtlasClass, TileLayer } from '@atlas/shared';
import { siteOfTags } from './life-sites';

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
  if (tags.building === 'train_station' || oneOf(tags.railway, 'station', 'halt')) {
    return 'building_station';
  }
  if (tags.public_transport === 'station' && (tags.train === 'yes' || tags.railway)) {
    return 'building_station';
  }
  return null;
};

/** Statues, memorials, monuments, and public art. */
const isMonument = (tags: Tags) =>
  oneOf(tags.historic, 'monument', 'memorial') ||
  oneOf(tags.memorial, 'statue', 'bust') ||
  tags.tourism === 'artwork';

/** Small street furniture, with the kind the renderer draws. */
const furnitureKinds = ['bench', 'fountain', 'flagpole'] as const;
const barrierKinds = ['fence', 'wall', 'hedge', 'gate'] as const;
const sidingKinds = ['siding', 'spur', 'yard'] as const;

/** Tree kinds the renderer draws with their own glyphs (SPEC.md §4). */
export type TreeKind = 'palm' | 'needleleaved' | 'broadleaved';

/** Palm genera (and the family), matched against a tree's taxonomy tags. */
const PALM =
  /\b(palm|arecaceae|cocos|areca|roystonea|elaeis|phoenix|livistona|caryota|washingtonia|nypa|corypha|metroxylon)\b/i;

/**
 * What kind of tree a `natural=tree`, `tree_row`, or wood is: a palm if its taxonomy names one
 * (OSM's `leaf_type` has no palm value), else its `leaf_type`, else unknown.
 */
export function treeKind(tags: Tags): TreeKind | undefined {
  const taxonomy = [tags.genus, tags.species, tags['species:en'], tags.taxon, tags['taxon:en']];
  if (taxonomy.some((value) => value !== undefined && PALM.test(value))) return 'palm';
  if (tags.leaf_type === 'needleleaved' || tags.leaf_type === 'broadleaved') return tags.leaf_type;
  return undefined;
}

/** Typical tree height and crown diameter in meters, by kind, when OSM gives neither. */
const treeDefaults: Record<TreeKind | 'unknown', { height: number; crown: number }> = {
  broadleaved: { height: 10, crown: 8 },
  unknown: { height: 10, crown: 8 },
  palm: { height: 12, crown: 6 },
  needleleaved: { height: 12, crown: 5 },
};

const positive = (value: string | undefined) => {
  const n = Number.parseFloat(value ?? '');
  return Number.isFinite(n) && n > 0 ? Math.round(n * 10) / 10 : undefined;
};

/**
 * A tree's height and crown diameter in meters (the renderer draws its crown, and the height
 * casts its shadow): `height` and `diameter_crown`, else typical values for its kind. Heights are
 * capped at 255, the renderer's height byte.
 */
export function treeSize(tags: Tags): { height: number; crown: number } {
  const fallback = treeDefaults[treeKind(tags) ?? 'unknown'];
  return {
    height: Math.min(255, positive(tags.height) ?? fallback.height),
    crown: Math.min(60, positive(tags.diameter_crown) ?? fallback.crown),
  };
}

/**
 * The renderer's glyph variant for a feature: the kind of `furniture` or `barrier`, a tree's
 * or wood's kind (`treeKind`), a building's roof shape (`roof:shape`), or a track's `service`
 * when it is a siding, spur, or yard, if any.
 */
export function variantOf(tags: Tags, atlasClass: AtlasClass): string | undefined {
  if (atlasClass === 'path' && tags.footway === 'crossing' && tags.crossing !== 'unmarked')
    return 'crossing';
  if (atlasClass === 'tree' || atlasClass === 'trees') return treeKind(tags);
  if (atlasClass === 'furniture') {
    if (tags.highway === 'traffic_signals') return 'signals';
    if (markedCrossing(tags)) return 'crossing';
    return (
      siteOfTags(tags)?.kind ??
      furnitureKinds.find((k) => tags.amenity === k || tags.man_made === k)
    );
  }
  if (atlasClass === 'barrier') return barrierKinds.find((k) => tags.barrier === k);
  // Sidings, spurs, and yards, where trains stand by (the renderer's life layer).
  if (atlasClass === 'rail') return sidingKinds.find((k) => tags.service === k);
  if (atlasClass.startsWith('building') && tags['roof:shape']) return tags['roof:shape'];
  return undefined;
}

const isFurniture = (tags: Tags) =>
  oneOf(tags.amenity, 'bench', 'fountain') || tags.man_made === 'flagpole';
export const markedCrossing = (tags: Tags) =>
  oneOf(tags.crossing, 'zebra', 'marked', 'uncontrolled', 'traffic_signals') ||
  (tags['crossing:markings'] !== undefined && tags['crossing:markings'] !== 'no');
const isBarrier = (tags: Tags) => oneOf(tags.barrier, ...barrierKinds);

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
  // A transit point draws as its furniture glyph; areas (a station's grounds) classify as usual
  // and keep only their site anchor (03-normalize.ts).
  if (kind === 'point' && !tags.building && siteOfTags(tags))
    return tags.entrance ? 'entrance' : 'furniture';
  if (tags.boundary === 'administrative') {
    return kind === 'area' && tags.admin_level === String(subdivisionLevel)
      ? 'admin_subdivision'
      : null;
  }

  if (kind === 'point') {
    if (tags.highway === 'traffic_signals' || markedCrossing(tags)) return 'furniture';
    if (oneOf(tags.place, ...placeLabels) && tags.name) return 'place_label';
    const building = buildingKind(tags);
    if (building) return building;
    if (isMonument(tags)) return 'monument';
    if (tags.natural === 'tree') return 'tree';
    if (isFurniture(tags)) return 'furniture';
    if (tags.entrance !== undefined) return 'entrance';
    if (isBarrier(tags)) return 'barrier';
    return null;
  }

  if (kind === 'line') {
    if (tags.natural === 'coastline') return 'coastline';
    if (tags.highway) return highwayClass(tags.highway);
    if (oneOf(tags.railway, 'rail', 'narrow_gauge', 'light_rail')) return 'rail';
    if (tags.waterway === 'river') return 'water_river';
    if (oneOf(tags.waterway, 'stream', 'canal')) return 'water_stream';
    if (tags.natural === 'tree_row') return 'tree';
    if (isBarrier(tags)) return 'barrier';
    return null;
  }

  // Areas
  if (tags.building && tags.building !== 'no') return buildingKind(tags) ?? 'building';
  const kindOfBuilding = buildingKind(tags);
  if (kindOfBuilding) return kindOfBuilding;
  // Church grounds (e.g. "Cathedral Grounds"); without building=* they get no height.
  if (tags.landuse === 'religious') return 'building_religious';
  if (isMonument(tags)) return 'monument';
  if (tags.natural === 'water' || tags.water !== undefined) return 'water_area';
  if (tags.waterway === 'riverbank') return 'water_area';
  if (oneOf(tags.leisure, 'park', 'garden', 'playground') || tags.place === 'square') return 'park';
  if (tags.natural === 'wood' || tags.landuse === 'forest') return 'trees';
  if (oneOf(tags.landuse, 'grass', 'meadow', 'village_green')) return 'grass';
  if (tags.natural === 'grassland' || tags.leisure === 'recreation_ground') return 'grass';
  if (oneOf(tags.landuse, 'farmland', 'paddy') || tags.crop === 'rice') return 'farmland';
  if (tags.amenity === 'parking') return 'parking';
  if (tags.leisure === 'pitch') return 'pitch';
  if (tags.amenity === 'fountain') return 'furniture';
  if (isBarrier(tags)) return 'barrier';
  return null;
}

/** Typical carriageway widths in meters, when OSM gives neither `width` nor `lanes`. */
const defaultRoadWidths: Partial<Record<AtlasClass, number>> = {
  road_major: 14,
  road_mid: 10,
  road_minor: 6,
};

/** Road width in meters: `width`, else `lanes` × 3.2, else a class default. */
export function roadWidth(tags: Tags, atlasClass: AtlasClass): number | undefined {
  const fallback = defaultRoadWidths[atlasClass];
  if (fallback === undefined) return undefined;
  const width = Number.parseFloat(tags.width ?? '');
  if (Number.isFinite(width) && width > 0) return Math.round(width * 10) / 10;
  const lanes = Number.parseFloat(tags.lanes ?? '');
  if (Number.isFinite(lanes) && lanes > 0) return Math.round(lanes * 3.2 * 10) / 10;
  return fallback;
}

/** The tile layer a class is written to. Point features other than labels go to `poi`. */
export function layerFor(atlasClass: AtlasClass, kind: GeometryKind): TileLayer {
  if (atlasClass === 'place_label') return 'labels';
  if (kind === 'point') return 'poi';
  if (atlasClass === 'terrain') return 'terrain';
  if (atlasClass.startsWith('water_') || atlasClass === 'coastline') return 'water';
  if (atlasClass.startsWith('road_') || atlasClass === 'path' || atlasClass === 'rail') {
    return 'roads';
  }
  if (atlasClass.startsWith('building')) return 'buildings';
  if (atlasClass.startsWith('admin_')) return 'admin';
  return 'landuse';
}

const defaultHeights: Partial<Record<AtlasClass, number>> = {
  building: 6,
  building_religious: 15,
  building_school: 9,
  building_market: 8,
  building_station: 8,
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

/** Tags whose value says what a feature is, most telling first. */
const kindKeys = [
  'amenity',
  'shop',
  'leisure',
  'historic',
  'memorial',
  'tourism',
  'building',
  'railway',
  'highway',
  'waterway',
  'natural',
  'water',
  'landuse',
  'place',
  'boundary',
];

/** The tag that defines what a feature is, e.g. `amenity=university`, for the info panel. */
export function kindOf(tags: Tags): string | undefined {
  for (const key of kindKeys) {
    const value = tags[key];
    if (value && value !== 'yes') return `${key}=${value}`;
  }
  return tags.building ? 'building=yes' : undefined;
}

/** OSM tags copied into the tiles as-is, for the info panel (keep this short: tile size). */
export const detailTags = [
  'alt_name',
  'old_name',
  'official_name',
  'addr:street',
  'website',
  'wikipedia',
  'wikidata',
  'denomination',
  'operator',
  'building:levels',
] as const;
