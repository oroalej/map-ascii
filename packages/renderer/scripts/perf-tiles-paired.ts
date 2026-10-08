import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus, platform, release } from 'node:os';
import { dirname, join } from 'node:path';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { archiveHash, openArchive } from './archive';
import { currentSourceHash, snapshotRevision, snapshotWorkingTree } from './snapshot';
import { compareTilePairs, firstArm, type TilePair } from './perf-tiles-protocol';
import type * as Geometry from '../src/raster/geometry';

type LoadedTile = { key: string; z: number; x: number; y: number; data: Uint8Array; hash: string };
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const tileX = (lng: number, n: number) =>
  Math.max(0, Math.min(n - 1, Math.floor(((lng + 180) / 360) * n)));
const tileY = (lat: number, n: number) => {
  const radians = (Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI) / 180;
  return Math.max(
    0,
    Math.min(n - 1, Math.floor(((1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2) * n)),
  );
};

/** Identical preloaded bytes, independent source graphs, two warmups, balanced paired rounds. */
export async function runPairedTiles(options: {
  root: string;
  city: string;
  baseline?: string;
  control: boolean;
  rounds: number;
  scratch: string;
  output: string;
}) {
  const { root, city, baseline, control, rounds, scratch, output } = options;
  if (!Number.isInteger(rounds) || rounds < 2 || rounds % 2)
    throw new Error('Paired tile measurements require an even round count of at least two');
  await mkdir(scratch, { recursive: true });
  const sourceHash = await currentSourceHash(root);
  const lockBytes = await readFile(join(root, 'pnpm-lock.yaml'));
  const cityBytes = await readFile(join(root, `packages/content/cities/${city}/city.json`));
  const pack = JSON.parse(cityBytes.toString('utf8')) as { life?: { folklore?: unknown } };
  const candidate = await snapshotWorkingTree(root, join(scratch, 'candidate'));
  const before = control
    ? await snapshotWorkingTree(root, join(scratch, 'control'))
    : await snapshotRevision(root, baseline!, join(scratch, 'baseline'));
  const a = (await import(before.path('raster/geometry.ts'))) as typeof Geometry;
  const b = (await import(candidate.path('raster/geometry.ts'))) as typeof Geometry;
  const local = await openArchive(city, root);
  try {
    const { archive, header } = local;
    const tiles: LoadedTile[] = [];
    for (let z = Math.max(header.minZoom, 15); z <= header.maxZoom; z++) {
      const n = 2 ** z;
      for (let y = tileY(header.maxLat, n); y <= tileY(header.minLat, n); y++)
        for (let x = tileX(header.minLon, n); x <= tileX(header.maxLon, n); x++) {
          const response = await archive.getZxy(z, x, y);
          if (response) {
            const data = new Uint8Array(response.data);
            tiles.push({ key: `${z}/${x}/${y}`, z, x, y, data, hash: hash(data) });
          }
        }
    }
    if (!tiles.length) throw new Error('No tiles at zoom 15 or higher');
    const pairs: TilePair[] = [];
    const measure = (module: typeof Geometry, tile: LoadedTile) => {
      const registry = module.createIdRegistry();
      const start = performance.now();
      const parsed = new VectorTile(new PbfReader(tile.data));
      module.buildTileGeometry(
        parsed.layers,
        registry,
        tile,
        header.maxZoom,
        false,
        !!pack.life?.folklore,
      );
      return performance.now() - start;
    };
    for (let round = -2; round < rounds; round++) {
      for (const [i, tile] of tiles.entries()) {
        const first = firstArm(i, round + 2);
        let baselineMs: number, candidateMs: number;
        if (first === 'baseline') {
          baselineMs = measure(a, tile);
          candidateMs = measure(b, tile);
        } else {
          candidateMs = measure(b, tile);
          baselineMs = measure(a, tile);
        }
        if (round >= 0)
          pairs.push({ key: tile.key, z: tile.z, round, first, baselineMs, candidateMs });
      }
      console.log(
        `tile decode ${round < 0 ? 'warmup' : 'measured'} round ${round + 1}: ${tiles.length} tiles`,
      );
    }
    const stable =
      sourceHash === (await currentSourceHash(root)) &&
      local.hash === (await archiveHash(local.path)) &&
      hash(lockBytes) === hash(await readFile(join(root, 'pnpm-lock.yaml'))) &&
      hash(cityBytes) ===
        hash(await readFile(join(root, `packages/content/cities/${city}/city.json`)));
    const summary = compareTilePairs(pairs);
    const zooms = [...new Set(tiles.map((t) => t.z))].map((zoom) => {
      const rows = pairs.filter((p) => p.z === zoom);
      return {
        zoom,
        ...compareTilePairs(rows),
        over16ms: {
          baseline: rows.filter((p) => p.baselineMs > 16).length,
          candidate: rows.filter((p) => p.candidateMs > 16).length,
        },
      };
    });
    const report = {
      version: 2,
      at: new Date().toISOString(),
      city,
      control,
      stable,
      revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      baseline: control ? null : baseline,
      sourceHashes: { baseline: before.hash, candidate: candidate.hash },
      archiveHash: local.hash,
      lockHash: hash(lockBytes),
      cityHash: hash(cityBytes),
      environment: {
        node: process.version,
        platform: platform(),
        os: release(),
        cpu: cpus()[0]?.model,
      },
      parameters: {
        rounds,
        warmups: 2,
        interleaved: true,
        minZoom: Math.max(header.minZoom, 15),
        maxZoom: header.maxZoom,
        folklore: !!pack.life?.folklore,
      },
      summary,
      zooms,
      tiles: tiles.map(({ data: _data, ...identity }) => identity),
      pairs,
    };
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2));
    console.table(
      zooms.map(({ zoom, baselineMs, candidateMs, changePercent }) => ({
        zoom,
        baselineMs,
        candidateMs,
        changePercent,
      })),
    );
    console.log(
      `overall build change: ${summary.changePercent.toFixed(2)}%; control spread: ${summary.spreadPercent.toFixed(2)}%; stable: ${stable}\nReport: ${output}`,
    );
    if (!stable) throw new Error('Inputs changed during paired tile measurement');
  } finally {
    await local.close();
  }
}
