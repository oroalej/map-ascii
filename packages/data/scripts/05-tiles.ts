import { copyFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { CityMeta, type City } from '@atlas/shared';
import type { Geography } from './02-convert';
import { TILE_ZOOMS, type AtlasProperties } from './03-normalize';
import { readFeatures, readJson, writeJson } from './lib/io';
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

export function buildMeta(city: City, geography: Geography, years: [number, number]): CityMeta {
  return CityMeta.parse({
    slug: city.slug,
    name: city.name,
    subdivisionLabel: city.subdivision.label,
    languages: city.languages,
    bounds: geography.bounds,
    regionBounds: geography.regionBounds,
    defaultCamera: { ...geography.center, zoom: geography.zoom, pitch: 0, bearing: 0 },
    yearRange: years,
    attribution: geography.attribution ?? [],
  });
}

// Build <city>.pmtiles with tippecanoe and write <city>.meta.json
export const step: Step = {
  name: '05-tiles',
  async run({ city, buildDir, outDir }) {
    const merged = join(buildDir, files.merged);
    const geography = await readJson<Geography>(join(buildDir, files.geography));
    const meta = buildMeta(city, geography, await yearRange(merged, new Date().getFullYear()));

    const pmtiles = join(buildDir, `${city.slug}.pmtiles`);
    tippecanoe(merged, pmtiles, [
      '-o',
      '{out}',
      '--force',
      '--read-parallel',
      `--minimum-zoom=${TILE_ZOOMS.min}`,
      `--maximum-zoom=${TILE_ZOOMS.max}`,
      '--drop-densest-as-needed',
      `--name=${city.name.en}`,
      '--attribution=© OpenStreetMap contributors',
      '{in}',
    ]);

    await mkdir(outDir, { recursive: true });
    await copyFile(pmtiles, join(outDir, `${city.slug}.pmtiles`));
    await writeJson(join(outDir, `${city.slug}.meta.json`), meta, true);
    await copyFile(
      join(buildDir, files.subdivisions),
      join(outDir, `${city.slug}.subdivisions.json`),
    );
    const mb = (await stat(pmtiles)).size / 1e6;
    console.log(
      `  wrote ${city.slug}.pmtiles (${mb.toFixed(1)} MB), .meta.json, and .subdivisions.json to ${outDir}`,
    );
    if (mb > 40)
      console.warn(`  ! ${city.slug}.pmtiles is over the 40 MB budget (ARCHITECTURE.md §8)`);
  },
};
