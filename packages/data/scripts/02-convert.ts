import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AtlasClass, BBox, City } from '@atlas/shared';
import turfBbox from '@turf/bbox';
import turfCentroid from '@turf/centroid';
import type { Feature, FeatureCollection, Geometry, MultiPolygon, Polygon } from 'geojson';
import osmtogeojson from 'osmtogeojson';
import { seaPolygons, type Position } from './lib/coastline';
import { DEM_ATTRIBUTION } from './lib/dem';
import { fromOverpassBounds, configuredRegionBounds, includesBoundary } from './lib/geo';
import { createTerritory } from './lib/territory';
import { readJson, writeJson } from './lib/io';
import { onlyRelation, type OverpassResponse } from './lib/overpass';
import { readDemGrid, terrainBands } from './lib/terrain';
import { mergeResponses } from './01-fetch';
import { files, type Step } from './step';

/** The city's geography, derived from OSM, that later steps and the meta need. */
export type Geography = {
  boundaryId: string;
  /** Boundary bbox. */
  bounds: BBox;
  regionBounds: BBox;
  /** Where the camera opens: the focus feature's center, else the boundary centroid. */
  center: { lat: number; lng: number };
  zoom: number;
  /** Credits for the sources the city's layers used, beyond OpenStreetMap. */
  attribution: string[];
};

/** A feature built by the pipeline rather than read from OSM tags, already classified. */
export type DerivedProperties = {
  id: string;
  class: AtlasClass;
  name?: string;
  /** Terrain band (1 = lowest), stored where buildings keep their height. */
  height?: number;
  elevation_min?: number;
  place?: string;
};

const defaultZoom = 13;

async function regionBounds(city: City, rawDir: string, boundary: BBox): Promise<BBox> {
  if ('bbox' in city.region) return configuredRegionBounds(city.region, boundary);
  const { name, osm_relation } = city.region;
  const region = await readJson<OverpassResponse>(join(rawDir, files.rawRegionRelation));
  const match = onlyRelation(region, 'Region', osm_relation ? {} : { name });
  if (!match.bounds) throw new Error('Region relation came back without bounds');
  return fromOverpassBounds(match.bounds);
}

const centerOf = (feature: Feature) => {
  const [lng, lat] = turfCentroid(feature).geometry.coordinates as [number, number];
  return { lat, lng };
};

const readOptional = <T>(path: string): Promise<T | undefined> =>
  readJson<T>(path).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return undefined;
    throw err;
  });

const inBbox = ([x, y]: Position, [w, s, e, n]: BBox) => x >= w && x <= e && y >= s && y <= n;

/**
 * Features the region needs that aren't plain OSM features: the sea (from the coastline),
 * province label points (from their relations' centers), and nothing else.
 */
export function regionDerived(
  region: OverpassResponse,
  bbox: BBox,
): Feature<Geometry, DerivedProperties>[] {
  const nodes = new Map<number, Position>();
  for (const e of region.elements) {
    if (e.type === 'node' && e.lat !== undefined && e.lon !== undefined) {
      nodes.set(e.id, [e.lon, e.lat]);
    }
  }
  const coastWays = region.elements
    .filter((e) => e.type === 'way' && e.tags?.natural === 'coastline' && e.nodes)
    .map((e) => e.nodes!);
  const out: Feature<Geometry, DerivedProperties>[] = [];

  const sea = seaPolygons(coastWays, (id) => nodes.get(id), bbox);
  if (sea.ok) {
    sea.sea.forEach((polygon, i) => {
      out.push({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: polygon },
        properties: { id: `sea/${i + 1}`, class: 'water_sea' },
      });
    });
    console.log(`  sea: ${sea.sea.length} polygons from ${coastWays.length} coastline ways`);
  } else {
    console.warn(`  ! no sea polygons (${sea.reason}); drawing the coastline only`);
  }

  for (const e of region.elements) {
    if (e.type !== 'relation' || !e.center || !e.tags?.name) continue;
    const point: Position = [e.center.lon, e.center.lat];
    if (!inBbox(point, bbox)) continue;
    out.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: point },
      properties: {
        id: `osm:relation/${e.id}`,
        class: 'place_label',
        name: e.tags.name,
        place: 'province',
      },
    });
  }
  return out;
}

/** Elevation bands from the cached DEM tiles, if any. */
async function terrain(
  rawDir: string,
  bbox: BBox,
): Promise<Feature<Geometry, DerivedProperties>[]> {
  const dir = join(rawDir, files.rawDem);
  const tiles = (await readdir(dir).catch(() => [] as string[]))
    .filter((f) => f.endsWith('.tif'))
    .map((f) => join(dir, f));
  if (tiles.length === 0) return [];
  const bands = terrainBands(await readDemGrid(tiles, bbox));
  console.log(`  terrain: ${bands.length} bands from ${tiles.length} DEM tiles`);
  return bands.map((band) => ({
    type: 'Feature',
    geometry: band.geometry,
    properties: {
      id: `terrain/${band.properties.band}`,
      class: 'terrain',
      height: band.properties.band,
      elevation_min: band.properties.elevation_min,
    },
  }));
}

// OSM → GeoJSON, the region's derived layers, and the city's bounds and default view
export const step: Step = {
  name: '02-convert',
  async run({ city, rawDir, buildDir }) {
    const boundaryRaw = await readJson<OverpassResponse>(join(rawDir, files.rawBoundary));
    const relation = onlyRelation(boundaryRaw, 'Boundary', {
      boundary: 'administrative',
      name: city.boundary.name,
      admin_level: String(city.boundary.admin_level),
    });
    const boundaryId = `relation/${relation.id}`;
    const boundary = osmtogeojson(boundaryRaw).features.find(
      (f): f is Feature<Polygon | MultiPolygon> =>
        f.id === boundaryId &&
        (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon'),
    );
    if (!boundary) throw new Error(`Could not build a polygon for the boundary ${boundaryId}`);
    await writeJson(join(buildDir, files.boundary), boundary);

    // Railways come in their own download (01-fetch.ts `railQuery`); a city fetched before it
    // existed just has none.
    const rail = await readOptional<OverpassResponse>(join(rawDir, files.rawDetailRail));
    const sites = await readOptional<OverpassResponse>(join(rawDir, files.rawDetailLife));
    const traffic = await readOptional<OverpassResponse>(join(rawDir, files.rawDetailTraffic));
    const neighborhood = await readOptional<OverpassResponse>(
      join(rawDir, files.rawDetailNeighborhood),
    );
    const detailRaw = await readJson<OverpassResponse>(join(rawDir, files.rawDetail));
    const grounds = await readOptional<OverpassResponse>(join(rawDir, files.rawDetailGrounds));
    const pools = await readOptional<OverpassResponse>(join(rawDir, files.rawDetailPools));
    const detail: FeatureCollection = osmtogeojson(
      mergeResponses([
        detailRaw,
        ...(rail ? [rail] : []),
        ...(sites ? [sites] : []),
        ...(traffic ? [traffic] : []),
        ...(neighborhood ? [neighborhood] : []),
        ...(grounds ? [grounds] : []),
        ...(pools ? [pools] : []),
      ]),
    );
    await writeJson(join(buildDir, files.osm), detail);
    console.log(`  ${detail.features.length} GeoJSON features`);

    const bounds = await regionBounds(city, rawDir, turfBbox(boundary) as BBox);
    await writeJson(
      join(buildDir, files.territory),
      createTerritory(
        bounds,
        boundary.geometry,
        includesBoundary(city) ? city.region.bbox : undefined,
      ),
    );
    const regionRaw = await readOptional<OverpassResponse>(join(rawDir, files.rawRegion));
    const regionOsm: FeatureCollection = regionRaw
      ? osmtogeojson(regionRaw)
      : { type: 'FeatureCollection', features: [] };
    await writeJson(join(buildDir, files.regionOsm), regionOsm);
    const derived = [
      ...(regionRaw ? regionDerived(regionRaw, bounds) : []),
      ...(await terrain(rawDir, bounds)),
    ];
    await writeJson(join(buildDir, files.derived), {
      type: 'FeatureCollection',
      features: derived,
    } satisfies FeatureCollection);
    console.log(`  region: ${regionOsm.features.length} OSM features, ${derived.length} derived`);

    let center = centerOf(boundary);
    let zoom = defaultZoom;
    if (city.focus) {
      const focusId = city.focus.osm_id.replace(/^osm:/, '');
      const focus = detail.features.find((f) => f.id === focusId);
      if (!focus) throw new Error(`Focus feature ${city.focus.osm_id} is not in the detail data`);
      center = centerOf(focus);
      zoom = city.focus.zoom;
    }

    const geography: Geography = {
      boundaryId,
      bounds: turfBbox(boundary) as BBox,
      regionBounds: bounds,
      center,
      zoom,
      attribution: derived.some((f) => f.properties.class === 'terrain') ? [DEM_ATTRIBUTION] : [],
    };
    await writeJson(join(buildDir, files.geography), geography, true);
  },
};
