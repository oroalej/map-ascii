import { join } from 'node:path';
import type { BBox, City } from '@atlas/shared';
import turfBbox from '@turf/bbox';
import turfCentroid from '@turf/centroid';
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import osmtogeojson from 'osmtogeojson';
import { fromOverpassBounds } from './lib/geo';
import { readJson, writeJson } from './lib/io';
import { onlyRelation, type OverpassResponse } from './lib/overpass';
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
};

const defaultZoom = 13;

async function regionBounds(city: City, rawDir: string): Promise<BBox> {
  if ('bbox' in city.region) return city.region.bbox;
  const { name, osm_relation } = city.region;
  const region = await readJson<OverpassResponse>(join(rawDir, files.rawRegion));
  const match = onlyRelation(region, 'Region', osm_relation ? {} : { name });
  if (!match.bounds) throw new Error('Region relation came back without bounds');
  return fromOverpassBounds(match.bounds);
}

const centerOf = (feature: Feature) => {
  const [lng, lat] = turfCentroid(feature).geometry.coordinates as [number, number];
  return { lat, lng };
};

// OSM → GeoJSON, plus the city's bounds and default view
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

    const detail: FeatureCollection = osmtogeojson(
      await readJson<OverpassResponse>(join(rawDir, files.rawDetail)),
    );
    await writeJson(join(buildDir, files.osm), detail);
    console.log(`  ${detail.features.length} GeoJSON features`);

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
      regionBounds: await regionBounds(city, rawDir),
      center,
      zoom,
    };
    await writeJson(join(buildDir, files.geography), geography, true);
  },
};
