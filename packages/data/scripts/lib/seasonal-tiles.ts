import { join } from 'node:path';
import type { PMTiles } from 'pmtiles';
import { type SeasonConfig, type SeasonalRecord } from '@atlas/shared';
import { SeasonalRecordSchema } from '@atlas/shared/schemas';
import type { AtlasFeature } from '../03-normalize';
import { readFeatures, writeJson } from './io';
import { generateSeasonalBunting } from './seasonal';
import { generateSeasonalInstallations, seasonalRecordGeometry } from './seasonal-installations';
import { geometryOutsideVoid, type Territory } from './territory';
import {
  openOverlayArchive as openUtilityArchive,
  auditOverlayArchive,
  assembleOverlayArchive,
  type OverlayFormat,
} from './overlay-tiles';

/** Admit complete records, including geometry embedded in their serialized payload. */
export function seasonalRecordsInTerritory(
  records: readonly SeasonalRecord[],
  territory?: Territory,
) {
  if (!territory?.void) return [...records];
  return records.filter(
    (r) =>
      geometryOutsideVoid(seasonalRecordGeometry(r), territory) &&
      (r.kind !== 'bunting' ||
        geometryOutsideVoid({ type: 'LineString', coordinates: r.segment }, territory)),
  );
}

const format: OverlayFormat<SeasonalRecord> = {
  layer: 'seasons',
  property: 'seasonal',
  label: 'Seasonal',
  recordName: 'seasonal row',
  duplicateError: 'Duplicate seasonal identities',
  parse: (value) => SeasonalRecordSchema.parse(value),
  id: (r) => r.id,
  geometry: seasonalRecordGeometry,
};

/** Prove every old layer (including utilities) survives, and every exact record is retained. */
export async function auditSeasonalArchive(
  base: PMTiles,
  output: PMTiles,
  records: readonly SeasonalRecord[],
) {
  return auditOverlayArchive(
    base,
    output,
    records.map((r) => format.parse(r)),
    format,
  );
}

export async function buildSeasonalTiles(
  basePath: string,
  output: string,
  mergedPath: string,
  seasons: readonly SeasonConfig[] | undefined,
  buildDir: string,
  territory?: Territory,
) {
  const features: AtlasFeature[] = [];
  for await (const f of readFeatures(mergedPath)) features.push(f as AtlasFeature);
  const generated = generateSeasonalBunting(features, seasons);
  const displays = generateSeasonalInstallations(features, seasons);
  const combined = seasonalRecordsInTerritory(
    [...generated.records, ...displays.records],
    territory,
  );
  const base = await openUtilityArchive(basePath);
  try {
    const audited = await assembleOverlayArchive(
      base.archive,
      basePath,
      output,
      buildDir,
      combined.map((r) => format.parse(r)),
      format,
      8,
      auditSeasonalArchive,
    );
    const report = { corridors: generated.stats, installations: displays.stats, ...audited };
    await writeJson(join(buildDir, 'seasons-report.json'), report, true);
    await writeJson(join(buildDir, 'seasons-manifest.json'), combined);
    console.log(`  seasons: ${JSON.stringify(report)}`);
  } finally {
    await base.close();
  }
}
