/** Decode real archive tiles in Node; timings exclude file IO and PMTiles decompression. */
import { open, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpus, platform, release } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PMTiles, type Source } from 'pmtiles';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { buildTileGeometry, createIdRegistry } from '../src/raster/geometry';
import { currentSourceHash } from './snapshot';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const arg = (name: string, fallback: string) =>
  process.argv.find((v) => v.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const city = arg('city', 'naga');
if (!/^[a-z0-9-]+$/.test(city)) throw new Error('Invalid city slug');
const rounds = Number(arg('rounds', '5'));
if (!Number.isInteger(rounds) || rounds < 1) throw new Error('Invalid round count');
const path = resolve(root, `apps/web/public/tiles/${city}.pmtiles`);
const sourceHash = await currentSourceHash(root);
const archiveHash = createHash('sha256')
  .update(await readFile(path))
  .digest('hex');
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
const quantile = (values: number[], q: number) => {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]! : null;
};
const summary = (values: number[]) => ({
  medianMs: quantile(values, 0.5),
  p95Ms: quantile(values, 0.95),
  maxMs: quantile(values, 1),
});
const tileX = (lng: number, n: number) =>
  Math.max(0, Math.min(n - 1, Math.floor(((lng + 180) / 360) * n)));
const tileY = (lat: number, n: number) => {
  const radians = (Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI) / 180;
  return Math.max(
    0,
    Math.min(n - 1, Math.floor(((1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2) * n)),
  );
};
try {
  const archive = new PMTiles(source);
  const header = await archive.getHeader();
  const tiles: {
    key: string;
    z: number;
    featureCount: number;
    parseMs: number;
    buildMs: number;
  }[] = [];
  for (let z = Math.max(header.minZoom, 15); z <= header.maxZoom; z++) {
    const n = 2 ** z;
    for (let y = tileY(header.maxLat, n); y <= tileY(header.minLat, n); y++)
      for (let x = tileX(header.minLon, n); x <= tileX(header.maxLon, n); x++) {
        const response = await archive.getZxy(z, x, y);
        if (!response) continue;
        const data = new Uint8Array(response.data);
        const parse: number[] = [],
          build: number[] = [];
        let featureCount = 0;
        for (let round = 0; round < rounds; round++) {
          const parseStart = performance.now();
          const parsed = new VectorTile(new PbfReader(data));
          featureCount = 0;
          for (const layer of Object.values(parsed.layers))
            for (let i = 0; i < layer.length; i++) {
              const feature = layer.feature(i);
              void feature.properties;
              feature.loadGeometry();
              featureCount++;
            }
          parse.push(performance.now() - parseStart);
          const registry = createIdRegistry();
          const buildStart = performance.now();
          const tile = new VectorTile(new PbfReader(data));
          buildTileGeometry(tile.layers, registry, { z, x, y }, header.maxZoom);
          build.push(performance.now() - buildStart);
        }
        tiles.push({
          key: `${z}/${x}/${y}`,
          z,
          featureCount,
          parseMs: quantile(parse, 0.5)!,
          buildMs: quantile(build, 0.5)!,
        });
      }
  }
  if (!tiles.length) throw new Error('No tiles at zoom 15 or higher');
  if ((await currentSourceHash(root)) !== sourceHash)
    throw new Error('Runtime source changed during capture');
  const zooms = [...new Set(tiles.map((tile) => tile.z))].map((zoom) => {
    const rows = tiles.filter((tile) => tile.z === zoom);
    return {
      zoom,
      count: rows.length,
      build: summary(rows.map((t) => t.buildMs)),
      parse: summary(rows.map((t) => t.parseMs)),
      over16ms: rows.filter((t) => t.buildMs > 16).length,
      slowest: rows
        .slice()
        .sort((a, b) => b.buildMs - a.buildMs)
        .slice(0, 10),
    };
  });
  const report = {
    version: 1,
    at: new Date().toISOString(),
    city,
    sourceHash,
    archiveHash,
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    lockHash: execFileSync('git', ['hash-object', 'pnpm-lock.yaml'], {
      cwd: root,
      encoding: 'utf8',
    }).trim(),
    environment: {
      node: process.version,
      platform: platform(),
      os: release(),
      cpu: cpus()[0]?.model,
    },
    parameters: { rounds, minZoom: Math.max(header.minZoom, 15), maxZoom: header.maxZoom },
    zooms,
    tiles,
  };
  const output = resolve(root, arg('output', 'test-results/tiles-decode.json'));
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2));
  console.table(
    zooms.map(({ zoom, count, build, parse, over16ms }) => ({
      zoom,
      count,
      buildMedian: build.medianMs,
      buildP95: build.p95Ms,
      buildMax: build.maxMs,
      parseMedian: parse.medianMs,
      parseP95: parse.p95Ms,
      over16ms,
    })),
  );
  console.log(`Report: ${output}`);
} finally {
  await file.close();
}
