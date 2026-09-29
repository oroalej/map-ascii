import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ContentBundle } from '@atlas/content';
import type { City } from '@atlas/shared';

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
  /** Use cached downloads only. */
  offline: boolean;
};

export type Step = {
  name: string;
  run: (ctx: StepContext) => Promise<void>;
};

export const cityContext = (city: City, content: ContentBundle, offline: boolean): StepContext => ({
  city,
  content,
  rawDir: join(paths.raw, city.slug),
  buildDir: join(paths.build, city.slug),
  outDir: paths.webTiles,
  offline,
});

/** Intermediate files passed between steps, relative to `buildDir` (or `rawDir` for downloads). */
export const files = {
  rawBoundary: 'boundary.osm.json',
  rawDetail: 'detail.osm.json',
  rawRegion: 'region.osm.json',
  boundary: 'boundary.geojson',
  osm: 'osm.geojson',
  geography: 'geography.json',
  normalized: 'normalized.geojsonl',
  merged: 'merged.geojsonl',
};
