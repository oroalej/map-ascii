import { join } from 'node:path';
import {
  CLASS_ZOOM,
  type ShopAnchor,
  featureZoomBand,
  REGION_TILE_MAX_ZOOM,
  tileZoomRange,
  type AtlasClass,
  type BBox,
  type SubdivisionArea,
  type TileLayer,
  type ZoomBand,
} from '@atlas/shared';
import { Frontage as FrontageSchema } from '@atlas/shared/schemas';
import turfBbox from '@turf/bbox';
import turfCentroid from '@turf/centroid';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import type {
  Feature,
  FeatureCollection,
  Geometry,
  MultiLineString,
  MultiPolygon,
  Point,
  Polygon,
  Position,
} from 'geojson';
import type { DerivedProperties, Geography } from './02-convert';
import { includesBoundary } from './lib/geo';
import {
  buildingHeight,
  classify,
  detailTags,
  kindOf,
  layerFor,
  roadWidth,
  sidewalkOf,
  onewayOf,
  treeSize,
  variantOf,
  type GeometryKind,
  type Tags,
} from './lib/classify';
import { parseOsmDate } from './lib/dates';
import { assignFrontages, frontageOf, shopAnchor, type Frontage } from './lib/frontage';
import { markSite, siteOfTags } from './lib/life-sites';
import { bboxesOverlap } from './lib/geo';
import { readJson, writeFeatures, writeJson } from './lib/io';
import { areaAt, isSubdivisionPlace, subdivisionAreas, type Area } from './lib/subdivisions';
import { files, type Step } from './step';

/** The zoom range of the tiles (DATA.md §2 step 05). */
export const TILE_ZOOMS = { min: 6, max: 16 } as const;
/** Full-source event routing tags, excluded from display tiles after route baking. */
export const EVENT_ACCESS_TAGS = [
  'highway',
  'foot',
  'access',
  'vehicle',
  'motor_vehicle',
  'motorcar',
  'motorcycle',
  'hgv',
  'bridge',
] as const satisfies readonly (keyof AtlasProperties)[];

/** Properties of a normalized feature, as written into the tiles. */
export type AtlasProperties = Partial<ShopAnchor> & {
  /** Versioned RoofPlan JSON, calculated on the complete footprint before tiling. */
  roof_plan?: string;
  /** Original road classification, independent of display tag precedence. */
  highway?: string;
  foot?: string;
  access?: string;
  vehicle?: string;
  motor_vehicle?: string;
  motorcar?: string;
  motorcycle?: string;
  hgv?: string;
  bridge?: string;
  event_path_width?: number;
  detail_route?: boolean;
  detail_blocked?: boolean;
  /** Elevated structure cover: rendered normally, but excluded from ground obstacles. */
  detail_overhead?: boolean;
  /** Selection identity of a walkable surface authored inside an OSM area. */
  detail_parent?: string;
  /** Bounded canonical selection metadata, available even before the target tile loads. */
  detail_selection?: string;
  seat_bearing?: number;
  /** Country flag design explicitly supplied by a city detail pack. */
  flag?: 'PH';
  lamp_bearing?: number;
  lamp_reach?: number;
  lamp_heads?: number;
  lamp_style?: 'streetlight' | 'lantern';
  sidewalk?: 'both' | 'left' | 'right' | 'none';
  sidewalk_width?: number;
  sidewalk_left_width?: number;
  sidewalk_right_width?: number;
  sidewalk_src?: 'mapped' | 'derived';
  oneway?: -1 | 1;
  oneway_source?: string;
  stop_direction?: 'forward' | 'backward';
  stop_bearing?: number;
  stop_width?: number;
  stop_road?: AtlasClass;
  stop_src?: 'mapped' | 'signalized';
  arrow_bearing?: number;
  arrow_width?: number;
  arrow_road?: AtlasClass;
  frontage?: Frontage;
  crossing_bearing?: number;
  crossing_width?: number;
  crossing_road?: AtlasClass;
  crossing_signal?: string;
  crossing_signal_at?: string;
  crossing_signal_seed?: number;
  crossing_mid?: boolean;
  crossing_walk?: 'a' | 'b';
  crossing_signal_control?: string;
  signal_seed?: number;
  signal_stops?: string;
  life_signal?: 'mapped' | 'derived';
  signal_a?: number;
  signal_b?: number;
  signal_radius?: number;
  /** JSON-encoded SignalLayout; scalar string survives vector tile encoding. */
  signal_layout?: string;
  source?: string;
  life_site?: 'stop' | 'terminal' | 'shelter';
  life_modes?: number;
  life_covered?: boolean;
  life_lng?: number;
  life_lat?: number;
  id: string;
  class: AtlasClass;
  name?: string;
  /** Buildings and trees, in meters. */
  height?: number;
  /** Trees: crown diameter in meters (`treeSize`). */
  crown?: number;
  /** Roads: carriageway width in meters (the renderer draws it from Place level). */
  width?: number;
  /** Renderer glyph variant: the kind of furniture or barrier, or a roof shape (`variantOf`). */
  variant?: string;
  /** The tag that defines the feature, e.g. `amenity=school` (info panel). */
  kind?: string;
  subdivision?: string;
  /** The subdivision comes from an approximate area, not a mapped boundary. */
  subdivision_approx?: boolean;
  start_year?: number;
  end_year?: number;
  certainty?: 'exact' | 'circa';
  landmark?: boolean;
  landmark_id?: string;
  /** Additional category for curated heritage landmarks; geographic identity is unchanged. */
  heritage?: boolean;
  /** A curated landmark with facts, or a heritage site: draws the landmark marker. */
  notable?: boolean;
  /** A landmark's OSM name, when the curated name replaced it. */
  osm_name?: string;
  /** Place labels: the OSM `place` value, or `province`. */
  place?: string;
  /** Place labels that name one of the city's subdivisions. */
  subdivision_label?: boolean;
  /** Terrain: the band's lowest elevation in meters. */
  elevation_min?: number;
  /** Where the renderer anchors the feature's name label. */
  label_lng?: number;
  label_lat?: number;
  /** From the region download (or derived from it): tiled only to `REGION_TILE_MAX_ZOOM`. */
  region?: boolean;
} & { [tag in (typeof detailTags)[number]]?: string };

export type AtlasFeature = Feature<Geometry, AtlasProperties> & {
  tippecanoe: { layer: TileLayer; minzoom: number; maxzoom: number };
};

/** osmtogeojson (3.x) flattens OSM tags into properties, alongside an `id` like "way/123". */
const tagsOf = (feature: Feature): Tags => feature.properties ?? {};

const kindOfGeometry = (geometry: Geometry): GeometryKind | null => {
  switch (geometry.type) {
    case 'Point':
    case 'MultiPoint':
      return 'point';
    case 'LineString':
    case 'MultiLineString':
      return 'line';
    case 'Polygon':
    case 'MultiPolygon':
      return 'area';
    default:
      return null;
  }
};

/** An admin boundary's rings as lines, so tile clipping doesn't add edges along tile seams. */
const outline = (geometry: Polygon | MultiPolygon): MultiLineString => ({
  type: 'MultiLineString',
  coordinates: geometry.type === 'Polygon' ? geometry.coordinates : geometry.coordinates.flat(),
});

const centerOf = (feature: Feature): Position => turfCentroid(feature).geometry.coordinates;

type Classified = { feature: Feature; kind: GeometryKind; cls: AtlasClass; tags: Tags };

function classifyAll(osm: FeatureCollection, subdivisionLevel: number): Classified[] {
  const out: Classified[] = [];
  for (const feature of osm.features) {
    const kind = kindOfGeometry(feature.geometry);
    if (!kind) continue;
    const tags = tagsOf(feature);
    const cls = classify(tags, kind, subdivisionLevel);
    if (cls) out.push({ feature, kind, cls, tags });
    // A transit site mapped as an area or line with no class of its own (a station's grounds, a
    // platform) still gets its glyph: as a point at its center, never filling its grounds.
    else if (kind !== 'point') {
      const point = classify(tags, 'point', subdivisionLevel);
      if (point && siteOfTags(tags)) {
        const geometry: Point = { type: 'Point', coordinates: centerOf(feature) };
        out.push({ feature: { ...feature, geometry }, kind: 'point', cls: point, tags });
      }
    }
  }
  return out;
}

const withZoom = (
  geometry: Geometry,
  properties: AtlasProperties,
  layer: TileLayer,
  band: ZoomBand,
): AtlasFeature => ({
  type: 'Feature',
  geometry,
  properties,
  tippecanoe: { layer, ...tileZoomRange(band, TILE_ZOOMS) },
});

/**
 * A region-only feature: flagged `region`, and tiled no deeper than `REGION_TILE_MAX_ZOOM`;
 * the renderer draws it from that zoom's tiles when the view is deeper.
 */
const regionOnly = (f: AtlasFeature): AtlasFeature => ({
  ...f,
  properties: { ...f.properties, region: true },
  tippecanoe: {
    ...f.tippecanoe,
    minzoom: Math.min(f.tippecanoe.minzoom, REGION_TILE_MAX_ZOOM),
    maxzoom: Math.min(f.tippecanoe.maxzoom, REGION_TILE_MAX_ZOOM),
  },
});

/**
 * Normalize OSM GeoJSON into atlas features: class, layer, tile zooms, stable id, height, kind
 * and detail tags, dates from OSM `start_date`/`end_date`, and subdivision. Features without a
 * class are dropped. Region features (and derived ones: sea, terrain, provinces) are added
 * unless the detail data has the same feature. Also returns the subdivision areas.
 */
export function normalize(
  osm: FeatureCollection,
  boundary: Feature<Polygon | MultiPolygon>,
  subdivisionLevel: number,
  region: { osm: FeatureCollection; derived: Feature<Geometry, DerivedProperties>[] } = {
    osm: { type: 'FeatureCollection', features: [] },
    derived: [],
  },
  restrictSubdivisions = false,
): { features: AtlasFeature[]; areas: Area[] } {
  // Eligibility uses the original relation centroid, before any display subtraction.
  const detail = classifyAll(assignFrontages(osm), subdivisionLevel).filter(
    ({ cls, feature }) =>
      !restrictSubdivisions ||
      cls !== 'admin_subdivision' ||
      booleanPointInPolygon(centerOf(feature), boundary),
  );
  const detailIds = new Set(detail.map((c) => String(c.feature.id)));
  const regional = classifyAll(region.osm, subdivisionLevel).filter(
    (c) => !detailIds.has(String(c.feature.id)) && c.cls !== 'admin_subdivision',
  );

  const mapped = detail
    .filter(({ cls, tags }) => cls === 'admin_subdivision' && tags.name)
    .map(({ feature, tags }) => ({
      name: tags.name!,
      feature: feature as Feature<Polygon | MultiPolygon>,
    }));
  const places = detail
    .filter(({ cls, tags }) => cls === 'place_label' && isSubdivisionPlace(tags, subdivisionLevel))
    .map(({ feature, tags }) => ({ name: tags.name!, position: centerOf(feature) }));
  const areas = subdivisionAreas(boundary, mapped, places, restrictSubdivisions);
  const areaNames = new Set(areas.map((a) => a.name));

  const cityName = tagsOf(boundary).name;
  const out: AtlasFeature[] = [
    withZoom(
      outline(boundary.geometry),
      {
        id: `osm:${String(boundary.id)}`,
        class: 'admin_city',
        ...(cityName && { name: cityName }),
      },
      'admin',
      CLASS_ZOOM.admin_city,
    ),
  ];

  const fromRegion = new Set(regional);
  for (const item of [...detail, ...regional]) {
    const { feature, kind, cls, tags } = item;
    const properties: AtlasProperties = { id: `osm:${String(feature.id)}`, class: cls };
    if (cls.startsWith('road_') || cls === 'path') {
      for (const tag of EVENT_ACCESS_TAGS) if (tags[tag]) properties[tag] = tags[tag];
    }
    if (cls.startsWith('building')) {
      const frontage = fromRegion.has(item)
        ? frontageOf(tags)
        : (tags.frontage ?? frontageOf(tags));
      if (frontage) properties.frontage = FrontageSchema.parse(frontage);
    }
    if (
      properties.frontage ||
      cls === 'building_market' ||
      (cls === 'furniture' && variantOf(tags, cls)?.startsWith('shop_'))
    )
      Object.assign(properties, shopAnchor(feature));
    if (tags.name) properties.name = tags.name;
    const featureKind = kindOf(tags);
    if (featureKind) properties.kind = featureKind;
    for (const tag of detailTags) {
      const value = tags[tag];
      if (value) properties[tag] = value;
    }
    const height = buildingHeight(tags, cls);
    if (height !== undefined) properties.height = height;
    if (cls === 'tree') Object.assign(properties, treeSize(tags));
    const width = roadWidth(tags, cls);
    if (width !== undefined) properties.width = width;
    if (cls === 'path') {
      const pathWidth = Number.parseFloat(tags.width ?? '');
      if (Number.isFinite(pathWidth) && pathWidth > 0) properties.event_path_width = pathWidth;
    }
    if (cls.startsWith('road_')) {
      const sidewalk = sidewalkOf(tags);
      if (sidewalk)
        Object.assign(properties, {
          sidewalk: sidewalk.sidewalk,
          sidewalk_width: sidewalk.width,
          sidewalk_left_width: sidewalk.leftWidth,
          sidewalk_right_width: sidewalk.rightWidth,
          sidewalk_src: 'mapped',
        });
      const oneway = onewayOf(tags);
      if (oneway) properties.oneway = oneway;
    }
    if (tags.highway === 'stop' && (tags.direction === 'forward' || tags.direction === 'backward'))
      properties.stop_direction = tags.direction;
    const variant = variantOf(tags, cls);
    if (variant !== undefined) properties.variant = variant;
    if (cls === 'place_label') {
      properties.place = tags.place!;
      if (
        areaNames.has(tags.name!) &&
        isSubdivisionPlace(tags, subdivisionLevel) &&
        (!restrictSubdivisions || booleanPointInPolygon(centerOf(feature), boundary))
      ) {
        properties.subdivision_label = true;
      }
    }
    if (cls !== 'admin_subdivision') {
      const area = areaAt(centerOf(feature), areas);
      if (area) {
        properties.subdivision = area.name;
        if (area.approximate) properties.subdivision_approx = true;
      }
    }
    const start = parseOsmDate(tags.start_date);
    const end = parseOsmDate(tags.end_date);
    if (start) properties.start_year = start.year;
    if (end && (!start || end.year > start.year)) properties.end_year = end.year;
    if (start || end) {
      properties.certainty =
        start?.certainty === 'circa' || end?.certainty === 'circa' ? 'circa' : 'exact';
    }
    const geometry =
      cls === 'admin_subdivision'
        ? outline(feature.geometry as Polygon | MultiPolygon)
        : feature.geometry;
    const tiled = withZoom(
      geometry,
      properties,
      layerFor(cls, kind),
      featureZoomBand(cls, {
        place: tags.place,
        subdivision_label: properties.subdivision_label,
      }),
    );
    const site = siteOfTags(tags);
    if (site) markSite(tiled, site, centerOf(feature));
    out.push(fromRegion.has(item) ? regionOnly(tiled) : tiled);
  }

  for (const feature of region.derived) {
    const p = feature.properties;
    const kind = kindOfGeometry(feature.geometry);
    if (!kind) continue;
    out.push(
      regionOnly(
        withZoom(feature.geometry, { ...p }, layerFor(p.class, kind), featureZoomBand(p.class, p)),
      ),
    );
  }
  return { features: out, areas };
}

const round5 = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(round5)
    : typeof value === 'number'
      ? Math.round(value * 1e5) / 1e5
      : value;

/** Subdivision areas for the HUD (`<city>.subdivisions.json`), with coordinates rounded. */
export const areasFile = (areas: readonly Area[]): SubdivisionArea[] =>
  areas.map((a) => ({
    name: a.name,
    approximate: a.approximate,
    geometry: {
      type: a.feature.geometry.type,
      coordinates: round5(a.feature.geometry.coordinates) as unknown[],
    },
  }));

/**
 * The features that reach into the region. A saved download can cover more than the region
 * (DATA.md §2 step 01); what lies wholly outside it can never be seen, so it isn't tiled.
 */
export const clipToRegion = (fc: FeatureCollection, region: BBox): FeatureCollection => ({
  ...fc,
  features: fc.features.filter((f) => f.geometry && bboxesOverlap(turfBbox(f) as BBox, region)),
});

const readOptional = <T>(path: string, fallback: T): Promise<T> =>
  readJson<T>(path).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  });

// Map OSM tags to atlas classes, tile zooms, heights, ids, dates, and subdivisions
export const step: Step = {
  name: '03-normalize',
  async run({ city, buildDir }) {
    const empty: FeatureCollection = { type: 'FeatureCollection', features: [] };
    const { regionBounds } = await readJson<Geography>(join(buildDir, files.geography));
    const osm = clipToRegion(
      await readJson<FeatureCollection>(join(buildDir, files.osm)),
      regionBounds,
    );
    const boundary = await readJson<Feature<Polygon | MultiPolygon>>(
      join(buildDir, files.boundary),
    );
    const regionOsm = clipToRegion(
      await readOptional(join(buildDir, files.regionOsm), empty),
      regionBounds,
    );
    const derived = await readOptional(join(buildDir, files.derived), empty);
    const { features, areas } = normalize(
      osm,
      boundary,
      city.subdivision.admin_level,
      {
        osm: regionOsm,
        derived: derived.features as Feature<Geometry, DerivedProperties>[],
      },
      includesBoundary(city),
    );

    const byLayer = new Map<string, number>();
    let withSubdivision = 0;
    for (const f of features) {
      byLayer.set(f.tippecanoe.layer, (byLayer.get(f.tippecanoe.layer) ?? 0) + 1);
      if (f.properties.subdivision) withSubdivision++;
    }
    await writeFeatures(join(buildDir, files.normalized), features);
    await writeJson(join(buildDir, files.subdivisions), areasFile(areas));
    const approximate = areas.filter((a) => a.approximate).length;
    console.log(
      `  ${features.length} features (${[...byLayer].map(([l, n]) => `${l} ${n}`).join(', ')}); ` +
        `${withSubdivision} inside a subdivision`,
    );
    console.log(
      `  subdivisions: ${areas.length - approximate} mapped, ${approximate} approximate ` +
        `(${
          areas
            .filter((a) => a.approximate)
            .map((a) => a.name)
            .join(', ') || 'none'
        })`,
    );
  },
};
