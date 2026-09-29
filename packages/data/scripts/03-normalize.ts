import { join } from 'node:path';
import type { AtlasClass, TileLayer } from '@atlas/shared';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import turfBbox from '@turf/bbox';
import turfCentroid from '@turf/centroid';
import type { Feature, FeatureCollection, Geometry, MultiPolygon, Polygon } from 'geojson';
import { buildingHeight, classify, layerFor, type GeometryKind, type Tags } from './lib/classify';
import { parseOsmDate } from './lib/dates';
import { readJson, writeFeatures } from './lib/io';
import { files, type Step } from './step';

/** Properties of a normalized feature, as written into the tiles. */
export type AtlasProperties = {
  id: string;
  class: AtlasClass;
  name?: string;
  height?: number;
  subdivision?: string;
  start_year?: number;
  end_year?: number;
  certainty?: 'exact' | 'circa';
  landmark?: boolean;
  landmark_id?: string;
};

export type AtlasFeature = Feature<Geometry, AtlasProperties> & {
  tippecanoe: { layer: TileLayer };
};

/** osmtogeojson (3.x) flattens OSM tags into properties, alongside an `id` like "way/123". */
const tagsOf = (feature: Feature): Tags => feature.properties ?? {};

const kindOf = (geometry: Geometry): GeometryKind | null => {
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

type Area = { name: string; bbox: number[]; feature: Feature<Polygon | MultiPolygon> };

/** Name of the mapped subdivision containing the feature's center, if any. */
function subdivisionOf(feature: Feature, areas: readonly Area[]): string | undefined {
  if (areas.length === 0) return undefined;
  const point = turfCentroid(feature);
  const [x, y] = point.geometry.coordinates as [number, number];
  for (const area of areas) {
    const [w, s, e, n] = area.bbox as [number, number, number, number];
    if (x < w || x > e || y < s || y > n) continue;
    if (booleanPointInPolygon(point, area.feature)) return area.name;
  }
  return undefined;
}

/**
 * Normalize OSM GeoJSON into atlas features: class, layer, stable id, height, dates from OSM
 * `start_date`/`end_date`, and subdivision. Features without a class are dropped. Subdivisions
 * come only from mapped boundary polygons; features outside them get none.
 */
export function normalize(
  osm: FeatureCollection,
  boundary: Feature<Polygon | MultiPolygon>,
  subdivisionLevel: number,
): AtlasFeature[] {
  const classified: { feature: Feature; kind: GeometryKind; cls: AtlasClass; tags: Tags }[] = [];
  for (const feature of osm.features) {
    const kind = kindOf(feature.geometry);
    const tags = tagsOf(feature);
    if (!kind) continue;
    const cls = classify(tags, kind, subdivisionLevel);
    if (cls) classified.push({ feature, kind, cls, tags });
  }

  const areas: Area[] = classified
    .filter(({ cls, tags }) => cls === 'admin_subdivision' && tags.name)
    .map(({ feature, tags }) => ({
      name: tags.name!,
      bbox: turfBbox(feature),
      feature: feature as Feature<Polygon | MultiPolygon>,
    }));

  const cityName = tagsOf(boundary).name;
  const out: AtlasFeature[] = [
    {
      type: 'Feature',
      geometry: boundary.geometry,
      properties: {
        id: `osm:${String(boundary.id)}`,
        class: 'admin_city',
        ...(cityName && { name: cityName }),
      },
      tippecanoe: { layer: 'admin' },
    },
  ];

  for (const { feature, kind, cls, tags } of classified) {
    const properties: AtlasProperties = { id: `osm:${String(feature.id)}`, class: cls };
    if (tags.name) properties.name = tags.name;
    const height = buildingHeight(tags, cls);
    if (height !== undefined) properties.height = height;
    if (cls !== 'admin_subdivision') {
      const subdivision = subdivisionOf(feature, areas);
      if (subdivision) properties.subdivision = subdivision;
    }
    const start = parseOsmDate(tags.start_date);
    const end = parseOsmDate(tags.end_date);
    if (start) properties.start_year = start.year;
    if (end && (!start || end.year > start.year)) properties.end_year = end.year;
    if (start || end) {
      properties.certainty =
        start?.certainty === 'circa' || end?.certainty === 'circa' ? 'circa' : 'exact';
    }
    out.push({
      type: 'Feature',
      geometry: feature.geometry,
      properties,
      tippecanoe: { layer: layerFor(cls, kind) },
    });
  }
  return out;
}

// Map OSM tags to atlas classes, heights, ids, dates, and subdivisions
export const step: Step = {
  name: '03-normalize',
  async run({ city, buildDir }) {
    const osm = await readJson<FeatureCollection>(join(buildDir, files.osm));
    const boundary = await readJson<Feature<Polygon | MultiPolygon>>(
      join(buildDir, files.boundary),
    );
    const features = normalize(osm, boundary, city.subdivision.admin_level);

    const byLayer = new Map<string, number>();
    let withSubdivision = 0;
    for (const f of features) {
      byLayer.set(f.tippecanoe.layer, (byLayer.get(f.tippecanoe.layer) ?? 0) + 1);
      if (f.properties.subdivision) withSubdivision++;
    }
    await writeFeatures(join(buildDir, files.normalized), features);
    console.log(
      `  ${features.length} features (${[...byLayer].map(([l, n]) => `${l} ${n}`).join(', ')}); ` +
        `${withSubdivision} inside a mapped subdivision`,
    );
  },
};
