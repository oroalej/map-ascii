/** Controlled roof decode comparison; all archive zooms, identical bytes and revision-local registries. */
import type * as Decoder from '../src/raster/geometry';
import { execFileSync } from 'node:child_process';
import { cpus, release } from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { snapshotRevision, currentSourceHash } from './snapshot';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const arg = (name: string, fallback = '') =>
  process.argv.find((v) => v.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const output = arg('output');
if (!output) throw new Error('Specify --output in the task handoff folder');
const city = arg('city', 'naga'),
  baselineRevision = arg('baseline', 'c229e02');
const rounds = Number(arg('rounds', '10'));
if (!Number.isInteger(rounds) || rounds < 10)
  throw new Error('At least ten measured rounds are required');
const sourceHash = await currentSourceHash(root);
const snapshot = await snapshotRevision(
  root,
  baselineRevision,
  resolve(dirname(output), `baseline-${basename(output, '.json')}`),
);
const baseline = (await import(snapshot.path('raster/geometry.ts'))) as typeof Decoder;
const control = (await import(snapshot.path('raster/geometry.ts') + '?control')) as typeof Decoder;
const candidate = (await import(
  pathToFileURL(resolve(root, 'packages/renderer/src/raster/geometry.ts')).href
)) as typeof Decoder;
if ((await currentSourceHash(root)) !== sourceHash)
  throw new Error('Source changed while loading candidate');
const { openArchive, archiveHash } = await import('./archive');
const local = await openArchive(city);
const quantile = (values: number[], q: number) => {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
};
const summary = (values: number[]) => ({
  count: values.length,
  medianMs: quantile(values, 0.5),
  p95Ms: quantile(values, 0.95),
});
const tileX = (lng: number, n: number) =>
  Math.max(0, Math.min(n - 1, Math.floor(((lng + 180) / 360) * n)));
const tileY = (lat: number, n: number) =>
  Math.max(
    0,
    Math.min(
      n - 1,
      Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n),
    ),
  );
try {
  const { archive, header } = local;
  const tiles: {
    z: number;
    x: number;
    y: number;
    key: string;
    data: Uint8Array;
    features: number;
    times: number[][];
    bytes: number[];
  }[] = [];
  for (let z = header.minZoom; z <= header.maxZoom; z++) {
    const n = 2 ** z;
    for (let y = tileY(header.maxLat, n); y <= tileY(header.minLat, n); y++)
      for (let x = tileX(header.minLon, n); x <= tileX(header.maxLon, n); x++) {
        const result = await archive.getZxy(z, x, y);
        if (!result) continue;
        const data = new Uint8Array(result.data),
          parsed = new VectorTile(new PbfReader(data));
        const features = Object.values(parsed.layers).reduce((sum, layer) => sum + layer.length, 0);
        tiles.push({
          z,
          x,
          y,
          key: `${z}/${x}/${y}`,
          data,
          features,
          times: [[], [], []],
          bytes: [],
        });
      }
  }
  if (!tiles.length) throw new Error('No archive tiles');
  const decoders = [baseline, candidate, control];
  // Tile bytes/decompression and snapshot creation are outside every timed region.
  for (let round = -2; round < rounds; round++) {
    for (const tile of tiles)
      for (const variant of round % 2 ? [2, 1, 0] : [0, 1, 2]) {
        const decoder = decoders[variant]!,
          registry = decoder.createIdRegistry();
        const start = performance.now();
        const parsed = new VectorTile(new PbfReader(tile.data));
        const geometry = decoder.buildTileGeometry(parsed.layers, registry, tile, header.maxZoom);
        const elapsed = performance.now() - start;
        if (round >= 0) tile.times[variant]!.push(elapsed);
        if (round === 0)
          tile.bytes[variant] = decoder
            .transferables(geometry)
            .reduce((sum, b) => sum + b.byteLength, 0);
      }
    console.log(
      `roof decode: ${round < 0 ? 'warmup' : 'measured'} round ${round + 3}/${rounds + 2}, ${tiles.length} tiles`,
    );
  }
  const stable =
    (await currentSourceHash(root)) === sourceHash &&
    (await archiveHash(local.path)) === local.hash;
  // Match the original building handoff's thirty-tile central fixture; other zooms remain diagnostic.
  const fixture = tiles.filter(
    (t) =>
      city === 'naga' && t.z === 16 && t.x >= 55191 && t.x <= 55196 && t.y >= 30262 && t.y <= 30266,
  );
  if (fixture.length !== 30)
    throw new Error(`Expected all 30 central tiles; found ${fixture.length}`);
  const stats = decoders.map((_, i) => summary(fixture.flatMap((t) => t.times[i]!)));
  const growth = (value: number, reference: number) => (value / reference - 1) * 100;
  const controlGrowth = {
    medianPct: growth(stats[2]!.medianMs, stats[0]!.medianMs),
    p95Pct: growth(stats[2]!.p95Ms, stats[0]!.p95Ms),
  };
  const candidateGrowth = {
    medianPct: growth(stats[1]!.medianMs, stats[0]!.medianMs),
    p95Pct: growth(stats[1]!.p95Ms, stats[0]!.p95Ms),
  };
  const quiet = Math.abs(controlGrowth.medianPct) <= 5 && Math.abs(controlGrowth.p95Pct) <= 5;
  const status =
    !stable || !quiet
      ? 'pending'
      : candidateGrowth.medianPct > 10 || candidateGrowth.p95Pct > 5
        ? 'fail'
        : 'pass';
  const report = {
    version: 1,
    status,
    at: new Date().toISOString(),
    baselineRevision,
    baselineHash: snapshot.hash,
    sourceHash,
    archiveHash: local.hash,
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    lockHash: execFileSync('git', ['hash-object', 'pnpm-lock.yaml'], {
      cwd: root,
      encoding: 'utf8',
    }).trim(),
    environment: { node: process.version, cpu: cpus()[0]?.model, os: release() },
    parameters: {
      city,
      rounds,
      warmups: 2,
      minZoom: header.minZoom,
      maxZoom: header.maxZoom,
      fixture: fixture.map((t) => t.key),
    },
    stable,
    quiet,
    primary: {
      baseline: stats[0],
      candidate: stats[1],
      control: stats[2],
      controlGrowth,
      candidateGrowth,
    },
    transferredBytes: decoders.map((_, i) => tiles.reduce((sum, t) => sum + t.bytes[i]!, 0)),
    zooms: [...new Set(tiles.map((t) => t.z))].map((z) => ({
      z,
      variants: decoders.map((_, i) => ({
        ...summary(tiles.filter((t) => t.z === z).flatMap((t) => t.times[i]!)),
        over16ms: tiles
          .filter((t) => t.z === z && quantile(t.times[i]!, 0.5) > 16)
          .map((t) => t.key),
      })),
    })),
    tiles: tiles.map(({ data: _data, ...tile }) => tile),
    notes:
      'Build timers include vector-tile parsing and geometry; exclude archive IO/decompression. Transferred bytes count typed-array buffers. Candidate includes the current checkout; concurrent non-roof changes are not attributed solely to roofs.',
  };
  await mkdir(dirname(resolve(output)), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify({
      status,
      stable,
      quiet,
      primary: report.primary,
      transferredBytes: report.transferredBytes,
    }),
  );
  process.exitCode = status === 'pass' ? 0 : status === 'fail' ? 1 : 2;
} finally {
  await local.close();
}
