import { copyFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import type { PMTiles } from 'pmtiles';
import type { Feature } from 'geojson';
import { SeasonalRecordSchema, type SeasonConfig, type SeasonalRecord } from '@atlas/shared';
import type { AtlasFeature } from '../03-normalize';
import { readFeatures, writeFeatures, writeJson } from './io';
import { tippecanoe } from './tippecanoe';
import { generateSeasonalBunting } from './seasonal';
import {
  openUtilityArchive,
  ordinaryContent,
  preserveArchiveBounds,
  utilityArchiveTiles,
} from './utility-tiles';

/** Prove every old layer (including utilities) survives, and every exact span is retained. */
export async function auditSeasonalArchive(
  base: PMTiles,
  output: PMTiles,
  records: readonly SeasonalRecord[],
) {
  const expected = new Map(
    records.map((r) => [r.id, JSON.stringify(SeasonalRecordSchema.parse(r))]),
  );
  if (expected.size !== records.length) throw new Error('Duplicate seasonal identities');
  const a = await base.getHeader(),
    b = await output.getHeader();
  for (const key of [
    'minZoom',
    'maxZoom',
    'minLon',
    'minLat',
    'maxLon',
    'maxLat',
    'centerZoom',
    'centerLon',
    'centerLat',
  ] as const)
    if (a[key] !== b[key]) throw new Error(`Seasonal merge changed archive ${key}`);
  for await (const { tile, parsed } of utilityArchiveTiles(base, true)) {
    const data = await output.getZxy(tile.z, tile.x, tile.y);
    if (!data) throw new Error(`Seasonal merge lost tile ${JSON.stringify(tile)}`);
    const merged = new VectorTile(new PbfReader(new Uint8Array(data.data)));
    if (ordinaryContent(parsed, 'seasons') !== ordinaryContent(merged, 'seasons'))
      throw new Error(`Seasonal merge changed base geometry ${JSON.stringify(tile)}`);
  }
  const found = new Set<string>();
  let tiles = 0;
  for await (const { tile, parsed } of utilityArchiveTiles(output)) {
    const layer = parsed.layers.seasons;
    if (!layer) continue;
    tiles++;
    for (let i = 0; i < layer.length; i++) {
      const record = SeasonalRecordSchema.parse(
        JSON.parse(String(layer.feature(i).properties.seasonal)),
      );
      if (expected.get(record.id) !== JSON.stringify(record))
        throw new Error(
          `Unexpected or changed seasonal row ${record.id} in ${JSON.stringify(tile)}`,
        );
      found.add(record.id);
    }
  }
  for (const id of expected.keys())
    if (!found.has(id)) throw new Error(`Tiling lost seasonal row ${id}`);
  return { tiles, records: found.size };
}

export async function buildSeasonalTiles(
  basePath: string,
  output: string,
  mergedPath: string,
  seasons: readonly SeasonConfig[] | undefined,
  buildDir: string,
) {
  const features: AtlasFeature[] = [];
  for await (const f of readFeatures(mergedPath)) features.push(f as AtlasFeature);
  const generated = generateSeasonalBunting(features, seasons);
  const base = await openUtilityArchive(basePath);
  try {
    const header = await base.archive.getHeader();
    const records: Feature[] = generated.records.map((r) => ({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [r.from, r.to] },
      properties: { seasonal: JSON.stringify(SeasonalRecordSchema.parse(r)) },
    }));
    const input = join(buildDir, 'seasons.geojsonl'),
      layer = join(buildDir, 'seasons.pmtiles');
    await writeFeatures(input, records);
    if (records.length) {
      tippecanoe(input, layer, [
        '-o',
        '{out}',
        '--force',
        '--layer=seasons',
        `--minimum-zoom=${header.maxZoom}`,
        `--maximum-zoom=${header.maxZoom}`,
        '--drop-rate=1',
        '--no-feature-limit',
        '--no-tile-size-limit',
        '--buffer=8',
        '{in}',
      ]);
      tippecanoe(
        basePath,
        output,
        ['-o', '{out}', '--force', '--no-tile-size-limit', '{in}', '{second}'],
        layer,
      );
      await preserveArchiveBounds(basePath, output);
    } else await copyFile(basePath, output);
    const result = await openUtilityArchive(output);
    try {
      const audit = await auditSeasonalArchive(base.archive, result.archive, generated.records);
      const report = {
        corridors: generated.stats,
        audit,
        baseBytes: (await stat(basePath)).size,
        outputBytes: (await stat(output)).size,
      };
      await writeJson(join(buildDir, 'seasons-report.json'), report, true);
      await writeJson(join(buildDir, 'seasons-manifest.json'), generated.records);
      console.log(`  seasons: ${JSON.stringify(report)}`);
    } finally {
      await result.close();
    }
  } finally {
    await base.close();
  }
}
