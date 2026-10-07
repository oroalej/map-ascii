import { buildUtilityTiles } from './lib/utility-tiles';
import { buildSeasonalTiles } from './lib/seasonal-tiles';
import { utilityCoverageBounds } from './lib/utilities';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { CityMeta, SubdivisionAreas, normalizeCredits, type City } from '@atlas/shared';
import type { Geography } from './02-convert';
import { EVENT_ACCESS_TAGS, TILE_ZOOMS, type AtlasFeature } from './03-normalize';
import { readFeatures, readJson, writeJson, writeFeatures } from './lib/io';
import { roofTileRecords } from './lib/roof-tiles';
import { landcoverCredits } from './lib/landcover';
import { cemeteryCredits } from './lib/cemeteries';
import { planCredits } from './lib/plan';
import { detailCredits } from './lib/site-detail';
import { publishDetailLayouts, readDetailLayouts } from './lib/detail-layout';
import { tippecanoe } from './lib/tippecanoe';
import { files, type Step } from './step';
import { Territory, type Territory as TerritoryType } from './lib/territory';
import { displayFeatures } from './lib/display';

/** Pure production tile-input path, before the external tile compiler. */
export const tileRecords = (features: readonly AtlasFeature[], territory: TerritoryType) =>
  displayFeatures(features, territory).flatMap(roofTileRecords);

/** Earliest dated year in the data (or `now` if nothing is dated) through `now`. */
export function yearRange(records: readonly AtlasFeature[], now: number): [number, number] {
  let earliest = now;
  for (const f of records) {
    const { start_year, end_year } = f.properties;
    for (const year of [start_year, end_year]) {
      if (year !== undefined && year < earliest) earliest = year;
    }
  }
  return [earliest, now];
}

/**
 * The city's meta. `credits` are sources beyond OSM that the city pack drew on (e.g. the imagery
 * curated trees and land cover were traced from); they join the geography's credits in the attribution.
 */
export function buildMeta(
  city: City,
  geography: Geography,
  years: [number, number],
  credits: readonly string[] = [],
): CityMeta {
  return CityMeta.parse({
    slug: city.slug,
    name: city.name,
    subdivisionLabel: city.subdivision.label,
    languages: city.languages,
    bounds: geography.bounds,
    regionBounds: geography.regionBounds,
    defaultCamera: { ...geography.center, zoom: geography.zoom },
    yearRange: years,
    attribution: normalizeCredits([...(geography.attribution ?? []), ...credits]),
  });
}

// Build <city>.pmtiles with tippecanoe and write the city's metadata and detail fingerprints.
export const step: Step = {
  name: '05-tiles',
  async run(ctx) {
    const { city, content, buildDir, outDir } = ctx;
    const layouts = await readDetailLayouts(ctx);
    const merged = join(buildDir, files.merged);
    const territory = Territory.parse(await readJson(join(buildDir, files.territory)));
    const geography = await readJson<Geography>(join(buildDir, files.geography));
    const features: AtlasFeature[] = [];
    for await (const feature of readFeatures(merged)) features.push(feature as AtlasFeature);
    const records = tileRecords(features, territory);
    const years = yearRange(records, new Date().getFullYear());
    const meta = buildMeta(city, geography, years, [
      ...landcoverCredits(content.landcover),
      ...cemeteryCredits(content.cemeteries),
      ...detailCredits(content.details),
      ...planCredits(content.plans),
    ]);

    const pmtiles = join(buildDir, `${city.slug}.pmtiles`);
    const seasonal = city.life?.seasons?.some(
      (s) => s.bunting?.corridors?.length || s.installations?.length,
    );
    const base =
      city.streets?.utilities?.derive || seasonal
        ? join(buildDir, `${city.slug}.base.pmtiles`)
        : pmtiles;
    const utilityOutput = seasonal ? join(buildDir, `${city.slug}.utility-base.pmtiles`) : pmtiles;
    const tileInput = join(buildDir, 'tile-input.geojsonseq');
    await writeFeatures(tileInput, records);
    tippecanoe(tileInput, base, [
      '-o',
      '{out}',
      '--force',
      '--read-parallel',
      `--minimum-zoom=${TILE_ZOOMS.min}`,
      `--maximum-zoom=${TILE_ZOOMS.max}`,
      '--drop-densest-as-needed',
      ...EVENT_ACCESS_TAGS.map((tag) => `--exclude=${tag}`),
      '--exclude=event_path_width',
      `--name=${city.name.en}`,
      '--attribution=© OpenStreetMap contributors',
      '{in}',
    ]);

    if (city.streets?.utilities?.derive)
      await buildUtilityTiles(
        base,
        utilityOutput,
        merged,
        utilityCoverageBounds(geography.bounds, geography.regionBounds),
        buildDir,
        territory,
      );

    if (seasonal)
      await buildSeasonalTiles(
        city.streets?.utilities?.derive ? utilityOutput : base,
        pmtiles,
        merged,
        city.life?.seasons,
        buildDir,
        territory,
      );

    await mkdir(outDir, { recursive: true });
    await copyFile(pmtiles, join(outDir, `${city.slug}.pmtiles`));
    await writeJson(join(outDir, `${city.slug}.meta.json`), meta, true);
    await publishDetailLayouts(ctx, layouts);
    // Validated here, as meta is above, because the browser only checks its shape (lib/guards.ts).
    const areas = SubdivisionAreas.parse(await readJson(join(buildDir, files.subdivisions)));
    await writeJson(join(outDir, `${city.slug}.subdivisions.json`), areas);
    const mb = (await stat(pmtiles)).size / 1e6;
    console.log(
      `  wrote ${city.slug}.pmtiles (${mb.toFixed(1)} MB), .meta.json, .detail-layouts.json, and .subdivisions.json to ${outDir}`,
    );
    if (mb > 40)
      console.warn(`  ! ${city.slug}.pmtiles is over the 40 MB budget (ARCHITECTURE.md §8)`);
  },
};
