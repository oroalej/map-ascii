/** Bake against the unchanged lamp catalog, tile separately, and audit the merged archive. */
import { join } from 'node:path';
import type { PMTiles } from 'pmtiles';
import {
  UTILITY,
  UTILITY_EXTENT,
  UTILITY_MERCATOR_METERS,
  isLitRoad,
  placeLampSupports,
  lampSupportKey,
  utilityTileMeters,
  utilityTilePoint,
  utilityRecordId,
  type BBox,
  type LitLine,
  type UtilityRecord,
} from '@atlas/shared';
import { UtilityRecordSchema } from '@atlas/shared/schemas';
import type { AtlasFeature } from '../03-normalize';
import { readFeatures, writeJson } from './io';
import { generateUtilities, type UtilityLamp } from './utilities';
import type { Territory } from './territory';

import {
  openOverlayArchive as openUtilityArchive,
  overlayArchiveTiles as utilityArchiveTiles,
  auditOverlayArchive,
  assembleOverlayArchive,
  type OverlayFormat,
} from './overlay-tiles';
export {
  openOverlayArchive as openUtilityArchive,
  overlayArchiveTiles as utilityArchiveTiles,
  ordinaryContent,
  preserveArchiveBounds,
} from './overlay-tiles';

const format: OverlayFormat<UtilityRecord> = {
  layer: 'utilities',
  property: 'utility',
  label: 'Utility',
  recordName: 'utility',
  duplicateError: 'Duplicate generated utility identities',
  parse: (value) => UtilityRecordSchema.parse(value),
  id: utilityRecordId,
  geometry: (r) =>
    r.kind === 'pole'
      ? { type: 'Point', coordinates: r.pole.at }
      : { type: 'LineString', coordinates: [r.span.from.at, r.span.to.at] },
};

export async function utilityLampCatalog(archive: PMTiles): Promise<UtilityLamp[]> {
  const lamps: UtilityLamp[] = [];
  for await (const { tile, parsed } of utilityArchiveTiles(archive)) {
    const lines: (LitLine & { road: string })[] = [];
    // Match the renderer's layer/feature order; junction precedence and minGap depend on it.
    for (const layer of Object.values(parsed.layers))
      for (let i = 0; i < layer.length; i++) {
        const feature = layer.feature(i),
          p = feature.properties;
        if (feature.type !== 2 || !isLitRoad(p.class, p.region)) continue;
        for (const line of feature.loadGeometry())
          lines.push({
            road: String(p.id),
            width: Number(p.width ?? 0),
            points: line.map((p) => ({
              x: (p.x * UTILITY_EXTENT) / layer.extent,
              y: (p.y * UTILITY_EXTENT) / layer.extent,
            })),
          });
      }
    for (const lamp of placeLampSupports(lines, utilityTileMeters(tile), UTILITY_EXTENT, {
      x: tile.x * UTILITY_EXTENT,
      y: tile.y * UTILITY_EXTENT,
    })) {
      if (lamp.junction) continue;
      lamps.push({
        key: lampSupportKey(tile, lamp.x, lamp.y),
        road: lines[lamp.line]!.road,
        at: utilityTilePoint(tile, { x: Math.fround(lamp.x), y: Math.fround(lamp.y) }),
      });
    }
  }
  return lamps;
}

export async function auditUtilityArchive(
  base: PMTiles,
  output: PMTiles,
  expected: readonly UtilityRecord[],
) {
  const audit = await auditOverlayArchive(base, output, expected, format);
  const poles = new Map(
    expected.filter((r) => r.kind === 'pole').map((r) => [r.pole.id, JSON.stringify(r.pole)]),
  );
  for (const record of expected)
    if (record.kind === 'span')
      for (const p of [record.span.from, record.span.to])
        if (poles.get(p.id) !== JSON.stringify(p))
          throw new Error(`Dangling or conflicting support ${p.id}`);
  return audit;
}

export async function buildUtilityTiles(
  basePath: string,
  output: string,
  mergedPath: string,
  bounds: BBox,
  buildDir: string,
  territory?: Territory,
) {
  const base = await openUtilityArchive(basePath);
  try {
    const features: AtlasFeature[] = [];
    for await (const f of readFeatures(mergedPath)) features.push(f as AtlasFeature);
    const catalog = await utilityLampCatalog(base.archive);
    const generated = generateUtilities(features, bounds, catalog, territory);
    const header = await base.archive.getHeader();
    const worstLatitude = Math.max(Math.abs(bounds[1]), Math.abs(bounds[3]));
    const tileMeters =
      (UTILITY_MERCATOR_METERS * Math.cos((worstLatitude * Math.PI) / 180)) / 2 ** header.maxZoom;
    const buffer = Math.max(5, Math.ceil((UTILITY.buffer / tileMeters) * 256));
    const audited = await assembleOverlayArchive(
      base.archive,
      basePath,
      output,
      buildDir,
      generated.records,
      format,
      buffer,
      auditUtilityArchive,
    );
    const report = { ...generated.stats, projection: generated.projection, ...audited };
    await writeJson(join(buildDir, 'utilities-report.json'), report, true);
    await writeJson(join(buildDir, 'utilities-manifest.json'), generated.records);
    console.log(`  utilities: ${JSON.stringify(report)}`);
  } finally {
    await base.close();
  }
}
