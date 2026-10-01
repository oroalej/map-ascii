import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ContentBundle } from '@atlas/content';
import type { City } from '@atlas/shared';
import type { FetchOptions } from './lib/overpass';

/** Absolute paths shared by pipeline steps. */
export const paths = {
  raw: fileURLToPath(new URL('../raw/', import.meta.url)),
  build: fileURLToPath(new URL('../build/', import.meta.url)),
  webTiles: fileURLToPath(new URL('../../../apps/web/public/tiles/', import.meta.url)),
};

/** Everything a step needs to process one city. */
export type StepContext = {
  city: City;
  content: ContentBundle;
  /** Raw downloads for this city (`raw/<slug>/`). */
  rawDir: string;
  /** Intermediates for this city (`build/<slug>/`). */
  buildDir: string;
  /** Where final outputs go (`apps/web/public/tiles/`). */
  outDir: string;
  /** Use saved downloads only. */
  offline: boolean;
  /** Download OSM data again, replacing the saved copies. */
  refresh: boolean;
};

export type Step = {
  name: string;
  run: (ctx: StepContext) => Promise<void>;
};

export const cityContext = (
  city: City,
  content: ContentBundle,
  { offline, refresh }: FetchOptions,
): StepContext => ({
  city,
  content,
  rawDir: join(paths.raw, city.slug),
  buildDir: join(paths.build, city.slug),
  outDir: paths.webTiles,
  offline,
  refresh: refresh ?? false,
});

/** Intermediate files passed between steps, relative to `buildDir` (or `rawDir` for downloads). */
export const files = {
  rawBoundary: 'boundary.osm.json',
  rawDetail: 'detail.osm.json',
  /** Railways in the detail bbox, fetched on their own (01-fetch.ts `railQuery`). */
  rawDetailRail: 'detail-rail.osm.json',
  rawDetailLife: 'detail-life.osm.json',
  rawDetailTraffic: 'detail-traffic.osm.json',
  rawDetailNeighborhood: 'detail-neighborhood.osm.json',
  rawDetailGrounds: 'detail-grounds.osm.json',
  /** The region relation lookup (tags and bounds only). */
  rawRegionRelation: 'region-relation.osm.json',
  /** Region-wide low-detail layers: coastline, major roads, rivers, lakes, places. */
  rawRegion: 'region.osm.json',
  /** Copernicus DEM tiles for the region. */
  rawDem: 'dem',
  boundary: 'boundary.geojson',
  osm: 'osm.geojson',
  regionOsm: 'region-osm.geojson',
  /** Features built from other data, already classified: sea, terrain, province labels. */
  derived: 'derived.geojson',
  geography: 'geography.json',
  normalized: 'normalized.geojsonl',
  subdivisions: 'subdivisions.json',
  merged: 'merged.geojsonl',
};
