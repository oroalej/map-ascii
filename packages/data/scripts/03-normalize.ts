import { join } from 'node:path';
import {
  CLASS_ZOOM,
  tileZoomRange,
  type AtlasClass,
  type SubdivisionArea,
  type TileLayer,
  type ZoomBand,
} from '@atlas/shared';
import turfCentroid from '@turf/centroid';
import type {
  Feature,
  FeatureCollection,
  Geometry,
  MultiLineString,
  MultiPolygon,
  Polygon,
  Position,
} from 'geojson';
import type { DerivedProperties } from './02-convert';
import {
  buildingHeight,
  classify,
  detailTags,
  kindOf,
  layerFor,
  roadWidth,
  variantOf,
  type GeometryKind,
  type Tags,
} from './lib/classify';
import { parseOsmDate } from './lib/dates';
import { readJson, writeFeatures, writeJson } from './lib/io';
import { areaAt, isSubdivisionPlace, subdivisionAreas, type Area } from './lib/subdivisions';
import { files, type Step } from './step';

/** The zoom range of the tiles (DATA.md §2 step 05). */
export const TILE_ZOOMS = { min: 6, max: 16 } as const;

/** Properties of a normalized feature, as written into the tiles. */
export type AtlasProperties = {
  id: string;
  class: AtlasClass;
  name?: string;
  height?: number;
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

/** When a feature shows: its class's band, refined by tags where one class spans levels. */
export function zoomBandFor(cls: AtlasClass, props: { place?: string; waterway?: string; subdivision_label?: boolean }): ZoomBand {
  if (cls === 'water_river') return props.waterway === 'river' ? { min: 8 } : { min: 12.5 };
  if (cls === 'place_label') {
    if (props.place === 'province') return { min: 0, max: 9.5 };
    if (props.place === 'city' || props.place === 'town') return { min: 0, max: 13 };
    if (props.subdivision_label) return { min: 10.5, max: 16 };
    return { min: 13.5 };
  }
  return CLASS_ZOOM[cls];
}

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
): { features: AtlasFeature[]; areas: Area[] } {
  const detail = classifyAll(osm, subdivisionLevel);
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
  const areas = subdivisionAreas(boundary, mapped, places);
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

  for (const { feature, kind, cls, tags } of [...detail, ...regional]) {
    const properties: AtlasProperties = { id: `osm:${String(feature.id)}`, class: cls };
    if (tags.name) properties.name = tags.name;
    const featureKind = kindOf(tags);
    if (featureKind) properties.kind = featureKind;
    for (const tag of detailTags) {
      const value = tags[tag];
      if (value) properties[tag] = value;
    }
    const height = buildingHeight(tags, cls);
    if (height !== undefined) properties.height = height;
    const width = roadWidth(tags, cls);
    if (width !== undefined) properties.width = width;
    const variant = variantOf(tags, cls);
    if (variant !== undefined) properties.variant = variant;
    if (cls === 'place_label') {
      properties.place = tags.place!;
      if (areaNames.has(tags.name!) && isSubdivisionPlace(tags, subdivisionLevel)) {
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
      cls === 'admin_subdivision' ? outline(feature.geometry as Polygon | MultiPolygon) : feature.geometry;
    out.push(
      withZoom(
        geometry,
        properties,
        layerFor(cls, kind),
        zoomBandFor(cls, { place: tags.place, waterway: tags.waterway, subdivision_label: properties.subdivision_label }),
      ),
    );
  }

  for (const feature of region.derived) {
    const p = feature.properties;
    const kind = kindOfGeometry(feature.geometry);
    if (!kind) continue;
    out.push(withZoom(feature.geometry, { ...p }, layerFor(p.class, kind), zoomBandFor(p.class, p)));
  }
  return { features: out, areas };
}

const round5 = (value: unknown): unknown =>
  Array.isArray(value) ? value.map(round5) : typeof value === 'number' ? Math.round(value * 1e5) / 1e5 : value;

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
    const osm = await readJson<FeatureCollection>(join(buildDir, files.osm));
    const boundary = await readJson<Feature<Polygon | MultiPolygon>>(
      join(buildDir, files.boundary),
    );
    const regionOsm = await readOptional(join(buildDir, files.regionOsm), empty);
    const derived = await readOptional(join(buildDir, files.derived), empty);
    const { features, areas } = normalize(osm, boundary, city.subdivision.admin_level, {
      osm: regionOsm,
      derived: derived.features as Feature<Geometry, DerivedProperties>[],
    });

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
        `(${areas.filter((a) => a.approximate).map((a) => a.name).join(', ') || 'none'})`,
    );
  },
};
