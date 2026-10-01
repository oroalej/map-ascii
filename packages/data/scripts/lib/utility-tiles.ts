/** Bake against the unchanged lamp catalog, tile separately, and audit the merged archive. */
import { copyFile, open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { PMTiles, type Source } from 'pmtiles';
import {
  UTILITY,
  UTILITY_EXTENT,
  placeLampSupports,
  lampSupportKey,
  utilityTileMeters,
  utilityTilePoint,
  utilityRecordId,
  UtilityRecordSchema,
  type BBox,
  type LitLine,
  type UtilityRecord,
} from '@atlas/shared';
import type { Feature } from 'geojson';
import type { AtlasFeature } from '../03-normalize';
import { readFeatures, writeFeatures, writeJson } from './io';
import { tippecanoe } from './tippecanoe';
import { generateUtilities, type UtilityLamp } from './utilities';

export async function openUtilityArchive(path: string) {
  const file = await open(path, 'r');
  const source: Source = {
    getKey: () => path,
    async getBytes(offset, length) {
      const bytes = new Uint8Array(length);
      let read = 0;
      while (read < length) {
        const result = await file.read(bytes, read, length - read, offset + read);
        if (!result.bytesRead) break;
        read += result.bytesRead;
      }
      return { data: bytes.slice(0, read).buffer };
    },
  };
  return { archive: new PMTiles(source), close: () => file.close() };
}
export async function* utilityArchiveTiles(archive: PMTiles, allZooms = false) {
  const h = await archive.getHeader();
  for (let z = allZooms ? h.minZoom : h.maxZoom; z <= h.maxZoom; z++) {
    const n = 2 ** z;
    const tx = (lng: number) => Math.max(0, Math.min(n - 1, Math.floor(((lng + 180) / 360) * n)));
    const ty = (lat: number) =>
      Math.max(
        0,
        Math.min(
          n - 1,
          Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n),
        ),
      );
    for (let y = ty(h.maxLat); y <= ty(h.minLat); y++)
      for (let x = tx(h.minLon); x <= tx(h.maxLon); x++) {
        const data = await archive.getZxy(z, x, y);
        if (data)
          yield {
            tile: { z, x, y },
            parsed: new VectorTile(new PbfReader(new Uint8Array(data.data))),
          };
      }
  }
}

export async function utilityLampCatalog(archive: PMTiles): Promise<UtilityLamp[]> {
  const lamps: UtilityLamp[] = [];
  for await (const { tile, parsed } of utilityArchiveTiles(archive)) {
    const lines: (LitLine & { road: string })[] = [];
    // Match the renderer's layer/feature order; junction precedence and minGap depend on it.
    for (const layer of Object.values(parsed.layers))
      for (let i = 0; i < layer.length; i++) {
        const feature = layer.feature(i),
          p = feature.properties;
        if (
          p.region === true ||
          feature.type !== 2 ||
          !['road_major', 'road_mid'].includes(String(p.class))
        )
          continue;
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

/** Compare decoded content, including feature order; compressed archive bytes may differ. */
function ordinaryContent(tile: VectorTile): string {
  return JSON.stringify(
    Object.entries(tile.layers)
      .filter(([name]) => name !== 'utilities')
      .map(([name, layer]) => [
        name,
        layer.extent,
        Array.from({ length: layer.length }, (_, i) => {
          const f = layer.feature(i);
          return [
            f.id,
            f.type,
            Object.entries(f.properties).sort(([a], [b]) => a.localeCompare(b)),
            f.loadGeometry().map((r) => r.map((p) => [p.x, p.y])),
          ];
        }),
      ]),
  );
}
export async function auditUtilityArchive(
  base: PMTiles,
  output: PMTiles,
  expected: readonly UtilityRecord[],
) {
  const manifest = new Map(expected.map((r) => [utilityRecordId(r), JSON.stringify(r)]));
  if (manifest.size !== expected.length) throw new Error('Duplicate generated utility identities');
  const found = new Set<string>();
  let tiles = 0;
  const baseHeader = await base.getHeader(),
    header = await output.getHeader();
  for (const key of ['minZoom', 'maxZoom', 'minLon', 'minLat', 'maxLon', 'maxLat'] as const)
    if (header[key] !== baseHeader[key]) throw new Error(`Utility merge changed archive ${key}`);
  for await (const { tile, parsed } of utilityArchiveTiles(base, true)) {
    const data = await output.getZxy(tile.z, tile.x, tile.y);
    if (!data) throw new Error(`Utility merge lost tile ${JSON.stringify(tile)}`);
    const merged = new VectorTile(new PbfReader(new Uint8Array(data.data)));
    if (ordinaryContent(parsed) !== ordinaryContent(merged))
      throw new Error(`Utility merge changed base geometry ${JSON.stringify(tile)}`);
  }
  for await (const { tile, parsed } of utilityArchiveTiles(output)) {
    const layer = parsed.layers.utilities;
    if (!layer) continue;
    tiles++;
    for (let i = 0; i < layer.length; i++) {
      const record = UtilityRecordSchema.parse(
        JSON.parse(String(layer.feature(i).properties.utility)),
      );
      const id = utilityRecordId(record);
      if (manifest.get(id) !== JSON.stringify(record))
        throw new Error(`Unexpected or changed utility ${id} in ${JSON.stringify(tile)}`);
      found.add(id);
    }
  }
  for (const id of manifest.keys())
    if (!found.has(id)) throw new Error(`Tiling lost utility ${id}`);
  const poles = new Map(
    expected.filter((r) => r.kind === 'pole').map((r) => [r.pole.id, JSON.stringify(r.pole)]),
  );
  for (const record of expected)
    if (record.kind === 'span')
      for (const p of [record.span.from, record.span.to])
        if (poles.get(p.id) !== JSON.stringify(p))
          throw new Error(`Dangling or conflicting support ${p.id}`);
  return { tiles, records: found.size };
}

export async function buildUtilityTiles(
  basePath: string,
  output: string,
  mergedPath: string,
  bounds: BBox,
  buildDir: string,
) {
  const base = await openUtilityArchive(basePath);
  try {
    const features: AtlasFeature[] = [];
    for await (const f of readFeatures(mergedPath)) features.push(f as AtlasFeature);
    const catalog = await utilityLampCatalog(base.archive);
    const generated = generateUtilities(features, bounds, catalog);
    const header = await base.archive.getHeader();
    const geojson = join(buildDir, 'utilities.geojsonl');
    const records: Feature[] = generated.records.map((record) => ({
      type: 'Feature',
      geometry:
        record.kind === 'pole'
          ? { type: 'Point', coordinates: record.pole.at }
          : { type: 'LineString', coordinates: [record.span.from.at, record.span.to.at] },
      properties: { utility: JSON.stringify(record) },
    }));
    await writeFeatures(geojson, records);
    const utilityPath = join(buildDir, 'utilities.pmtiles');
    const worstLatitude = Math.max(Math.abs(bounds[1]), Math.abs(bounds[3]));
    const tileMeters =
      (40_075_016.686 * Math.cos((worstLatitude * Math.PI) / 180)) / 2 ** header.maxZoom;
    const buffer = Math.max(5, Math.ceil((UTILITY.buffer / tileMeters) * 256));
    if (records.length) {
      tippecanoe(geojson, utilityPath, [
        '-o',
        '{out}',
        '--force',
        '--layer=utilities',
        `--minimum-zoom=${header.maxZoom}`,
        `--maximum-zoom=${header.maxZoom}`,
        '--drop-rate=1',
        '--no-feature-limit',
        '--no-tile-size-limit',
        `--buffer=${buffer}`,
        '{in}',
      ]);
      tippecanoe(
        basePath,
        output,
        ['-o', '{out}', '--force', '--no-tile-size-limit', '{in}', '{second}'],
        utilityPath,
      );
      // tile-join recomputes bounds from quantized, buffered geometry. Preserve the base
      // archive's advertised extent/center (PMTiles v3 bytes 102–126), without touching tiles.
      // Bounds/center live only in the fixed header, not the PMTiles JSON metadata.
      if (header.specVersion !== 3) throw new Error('Utility merge requires PMTiles v3');
      const source = await open(basePath, 'r'),
        target = await open(output, 'r+');
      try {
        const boundsBytes = new Uint8Array(25);
        const read = await source.read(boundsBytes, 0, 25, 102);
        if (read.bytesRead !== 25) throw new Error('Incomplete base PMTiles header');
        await target.write(boundsBytes, 0, 25, 102);
      } finally {
        await source.close();
        await target.close();
      }
    } else await copyFile(basePath, output);
    const result = await openUtilityArchive(output);
    try {
      const audit = await auditUtilityArchive(base.archive, result.archive, generated.records);
      const report = {
        ...generated.stats,
        projection: generated.projection,
        audit,
        baseBytes: (await stat(basePath)).size,
        outputBytes: (await stat(output)).size,
      };
      await writeJson(join(buildDir, 'utilities-report.json'), report, true);
      await writeJson(join(buildDir, 'utilities-manifest.json'), generated.records);
      console.log(`  utilities: ${JSON.stringify(report)}`);
    } finally {
      await result.close();
    }
  } finally {
    await base.close();
  }
}
