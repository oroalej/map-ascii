import { buildUtilityTiles } from './lib/utility-tiles';
import { buildSeasonalTiles } from './lib/seasonal-tiles';
import { utilityCoverageBounds } from './lib/utilities';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { CityMeta, SubdivisionAreas, type City } from '@atlas/shared';
import type { Geography } from './02-convert';
import { TILE_ZOOMS, type AtlasProperties, type AtlasFeature } from './03-normalize';
import { readFeatures, readJson, writeJson, writeFeatures } from './lib/io';
import { roofTileRecords } from './lib/roof-tiles';
import { landcoverCredits } from './lib/landcover';
import { planCredits } from './lib/plan';
import { detailCredits } from './lib/site-detail';
import { tippecanoe } from './lib/tippecanoe';
import { files, type Step } from './step';

/** Earliest dated year in the data (or `now` if nothing is dated) through `now`. */
async function yearRange(mergedPath: string, now: number): Promise<[number, number]> {
  let earliest = now;
  for await (const f of readFeatures(mergedPath)) {
    const { start_year, end_year } = f.properties as AtlasProperties;
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
    attribution: [...new Set([...(geography.attribution ?? []), ...credits])],
  });
}

// Build <city>.pmtiles with tippecanoe and write <city>.meta.json
export const step: Step = {
  name: '05-tiles',
  async run({ city, content, buildDir, outDir }) {
    const merged = join(buildDir, files.merged);
    const geography = await readJson<Geography>(join(buildDir, files.geography));
    const years = await yearRange(merged, new Date().getFullYear());
    const meta = buildMeta(city, geography, years, [
      ...landcoverCredits(content.landcover),
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
    const records: AtlasFeature[] = [];
    for await (const feature of readFeatures(merged))
      records.push(...roofTileRecords(feature as AtlasFeature));
    await writeFeatures(tileInput, records);
    tippecanoe(tileInput, base, [
      '-o',
      '{out}',
      '--force',
      '--read-parallel',
      `--minimum-zoom=${TILE_ZOOMS.min}`,
      `--maximum-zoom=${TILE_ZOOMS.max}`,
      '--drop-densest-as-needed',
      '--exclude=highway',
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
      );

    if (seasonal)
      await buildSeasonalTiles(
        city.streets?.utilities?.derive ? utilityOutput : base,
        pmtiles,
        merged,
        city.life?.seasons,
        buildDir,
      );

    await mkdir(outDir, { recursive: true });
    await copyFile(pmtiles, join(outDir, `${city.slug}.pmtiles`));
    await writeJson(join(outDir, `${city.slug}.meta.json`), meta, true);
    // Validated here, as meta is above, because the browser only checks its shape (lib/guards.ts).
    const areas = SubdivisionAreas.parse(await readJson(join(buildDir, files.subdivisions)));
    await writeJson(join(outDir, `${city.slug}.subdivisions.json`), areas);
    const mb = (await stat(pmtiles)).size / 1e6;
    console.log(
      `  wrote ${city.slug}.pmtiles (${mb.toFixed(1)} MB), .meta.json, and .subdivisions.json to ${outDir}`,
    );
    if (mb > 40)
      console.warn(`  ! ${city.slug}.pmtiles is over the 40 MB budget (ARCHITECTURE.md §8)`);
  },
};
