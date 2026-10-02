/** Generic PMTiles overlay assembly and lossless ordinary-layer audit. */
import { copyFile, open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { PMTiles, type Source } from 'pmtiles';
import type { Geometry } from 'geojson';
import { writeFeatures } from './io';
import { tippecanoe } from './tippecanoe';

export async function openOverlayArchive(path: string) {
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
export async function* overlayArchiveTiles(archive: PMTiles, allZooms = false) {
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

/** Compare decoded content, including feature order; compressed archive bytes may differ. */
export function ordinaryContent(tile: VectorTile, excludedLayer = 'utilities'): string {
  return JSON.stringify(
    Object.entries(tile.layers)
      .filter(([name]) => name !== excludedLayer)
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

/** tile-join recomputes bounds from buffered geometry; retain the original v3 header. */
export async function preserveArchiveBounds(basePath: string, output: string) {
  const source = await open(basePath, 'r'),
    target = await open(output, 'r+');
  try {
    const magic = new Uint8Array(8);
    await source.read(magic, 0, 8, 0);
    if (magic[7] !== 3) throw new Error('Overlay merge requires PMTiles v3');
    const boundsBytes = new Uint8Array(25);
    const read = await source.read(boundsBytes, 0, 25, 102);
    if (read.bytesRead !== 25) throw new Error('Incomplete base PMTiles header');
    await target.write(boundsBytes, 0, 25, 102);
  } finally {
    await source.close();
    await target.close();
  }
}

export type OverlayFormat<T> = {
  layer: string;
  property: string;
  label: string;
  recordName: string;
  duplicateError: string;
  parse: (value: unknown) => T;
  id: (record: T) => string;
  geometry: (record: T) => Geometry;
};

export async function auditOverlayArchive<T>(
  base: PMTiles,
  output: PMTiles,
  records: readonly T[],
  format: OverlayFormat<T>,
) {
  const expected = new Map(records.map((r) => [format.id(r), JSON.stringify(r)]));
  if (expected.size !== records.length) throw new Error(format.duplicateError);
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
    if (a[key] !== b[key]) throw new Error(`${format.label} merge changed archive ${key}`);
  for await (const { tile, parsed } of overlayArchiveTiles(base, true)) {
    const data = await output.getZxy(tile.z, tile.x, tile.y);
    if (!data) throw new Error(`${format.label} merge lost tile ${JSON.stringify(tile)}`);
    const merged = new VectorTile(new PbfReader(new Uint8Array(data.data)));
    if (ordinaryContent(parsed, format.layer) !== ordinaryContent(merged, format.layer))
      throw new Error(`${format.label} merge changed base geometry ${JSON.stringify(tile)}`);
  }
  const found = new Set<string>();
  let tiles = 0;
  for await (const { tile, parsed } of overlayArchiveTiles(output)) {
    const layer = parsed.layers[format.layer];
    if (!layer) continue;
    tiles++;
    for (let i = 0; i < layer.length; i++) {
      const record = format.parse(JSON.parse(String(layer.feature(i).properties[format.property])));
      const id = format.id(record);
      if (expected.get(id) !== JSON.stringify(record))
        throw new Error(
          `Unexpected or changed ${format.recordName} ${id} in ${JSON.stringify(tile)}`,
        );
      found.add(id);
    }
  }
  for (const id of expected.keys())
    if (!found.has(id)) throw new Error(`Tiling lost ${format.recordName} ${id}`);
  return { tiles, records: found.size };
}

/** Domain wrappers supply their record parser, geometry, buffer and extra audit checks. */
export async function assembleOverlayArchive<T>(
  base: PMTiles,
  basePath: string,
  output: string,
  buildDir: string,
  records: readonly T[],
  format: OverlayFormat<T>,
  buffer: number,
  audit: (
    base: PMTiles,
    output: PMTiles,
    records: readonly T[],
  ) => Promise<{ tiles: number; records: number }>,
) {
  const header = await base.getHeader();
  const input = join(buildDir, `${format.layer}.geojsonl`),
    layer = join(buildDir, `${format.layer}.pmtiles`);
  await writeFeatures(
    input,
    records.map((r) => ({
      type: 'Feature' as const,
      geometry: format.geometry(r),
      properties: { [format.property]: JSON.stringify(r) },
    })),
  );
  if (records.length) {
    tippecanoe(input, layer, [
      '-o',
      '{out}',
      '--force',
      `--layer=${format.layer}`,
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
      layer,
    );
    await preserveArchiveBounds(basePath, output);
  } else await copyFile(basePath, output);
  const result = await openOverlayArchive(output);
  try {
    return {
      audit: await audit(base, result.archive, records),
      baseBytes: (await stat(basePath)).size,
      outputBytes: (await stat(output)).size,
    };
  } finally {
    await result.close();
  }
}
