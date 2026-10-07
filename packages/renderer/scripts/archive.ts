/** Local archive access shared by the performance scripts; no renderer runtime IO. */
import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PMTiles, type Source } from 'pmtiles';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { buildTileGeometry, createIdRegistry } from '../src/raster/geometry';
import type { TileId } from '../src/tiles';
import type { LifeTile } from '../src/life/simulate';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export async function archiveHash(path: string) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

export async function openArchive(city: string, inputRoot = root) {
  if (!/^[a-z0-9-]+$/.test(city)) throw new Error('Invalid city slug');
  const path = resolve(inputRoot, `apps/web/public/tiles/${city}.pmtiles`);
  const hash = await archiveHash(path);
  const file = await open(path, 'r');
  const source: Source = {
    getKey: () => path,
    async getBytes(offset, length) {
      const buffer = new Uint8Array(length);
      let read = 0;
      while (read < length) {
        const { bytesRead } = await file.read(buffer, read, length - read, offset + read);
        if (!bytesRead) break;
        read += bytesRead;
      }
      return { data: buffer.slice(0, read).buffer };
    },
  };
  try {
    const archive = new PMTiles(source);
    const header = await archive.getHeader();
    return { archive, header, path, hash, close: () => file.close() };
  } catch (error) {
    await file.close();
    throw error;
  }
}

/** The worker shares one registry across arrivals and drains new features after each tile. */
export async function decodeLifeTiles(
  archive: PMTiles,
  ids: readonly TileId[],
  buildGeometry = buildTileGeometry,
): Promise<LifeTile[]> {
  const { maxZoom } = await archive.getHeader();
  const registry = createIdRegistry();
  const tiles: LifeTile[] = [];
  for (const tile of ids) {
    const { z, x, y } = tile;
    const response = await archive.getZxy(z, x, y);
    if (!response) continue;
    const parsed = new VectorTile(new PbfReader(new Uint8Array(response.data)));
    const geometry = buildGeometry(parsed.layers, registry, tile, maxZoom);
    registry.takeNew();
    tiles.push({ key: `${z}/${x}/${y}`, tile, life: geometry.life });
  }
  return tiles;
}

/** Script-only city fixtures: runtime geography still comes entirely from city packs. */
export function realPanStrip(city: string): TileId[] {
  if (city !== 'naga') throw new Error(`No real-pan fixture registered for city: ${city}`);
  return Array.from({ length: 40 }, (_, i) => ({
    z: 16,
    x: 55189 + (i % 10),
    y: 30262 + Math.floor(i / 10),
  }));
}
