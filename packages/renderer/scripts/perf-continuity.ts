/** Manual matched-population preparation/activation benchmark; no browser or GPU required. */
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { cpus } from 'node:os';
import { resolve } from 'node:path';
import * as Comlink from 'comlink';
import { City } from '@atlas/shared/schemas';
import { openArchive, decodeLifeTiles, realPanStrip } from './archive';
import { currentSourceHash } from './snapshot';
import { tileToLngLat } from '../src/raster/geometry';
import { viewportFor } from '../src/camera';
import { activityLevels } from '../src/life/config';
import { spawnMargin } from '../src/life/births';
import { DEFAULT_CELLS, cellStep, stepCell } from '../src/density';
import { metersPerCssPx } from '../src/grid';
import type { LifeTile } from '../src/life/simulate';
import type { LifeWorkerApi, FrameInput, FrameReply } from '../src/life/worker-api';
const require = createRequire(import.meta.url);
// Comlink ships this Node adapter without an export-map declaration for its .mjs entry.
const nodeEndpoint = require('comlink/dist/umd/node-adapter.js') as (
  port: Worker,
) => Comlink.Endpoint;
const root = fileURLToPath(new URL('../../../', import.meta.url));
const arg = (key: string, fallback = '') =>
  process.argv.find((value) => value.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback;
const output = arg('output');
if (!output) throw new Error('Provide --output=<task-folder>/preparation.json');
const runs = Number(arg('runs', '5'));
if (!Number.isInteger(runs) || runs < 1) throw new Error('Invalid run count');
const control = process.argv.includes('--control');
const slug = arg('city', 'naga');
const source = await currentSourceHash(root);
const config = City.parse(
  JSON.parse(await readFile(resolve(root, `packages/content/cities/${slug}/city.json`), 'utf8')),
);
const archive = await openArchive(slug);
const tiles = await decodeLifeTiles(archive.archive, realPanStrip(slug));
const initial = tiles.filter(({ tile }) => tile.x >= 55190 && tile.x < 55194);
const pan = tiles.filter(({ tile }) => tile.x >= 55191 && tile.x < 55195);
const parentIds = [
  ...new Map(
    initial.map(({ tile }) => {
      const parent = { z: tile.z - 1, x: Math.floor(tile.x / 2), y: Math.floor(tile.y / 2) };
      return [`${parent.z}/${parent.x}/${parent.y}`, parent] as const;
    }),
  ).values(),
];
const parents = await decodeLifeTiles(archive.archive, parentIds);
await archive.close();
if (initial.length !== 16 || parents.length !== 4 || pan.length !== 16)
  throw new Error('Incomplete real 4x4 fixture');
const summary = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: values.length,
    median: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
    p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
    total: values.reduce((sum, value) => sum + value, 0),
  };
};
type Inspection = { hash: string; movers: number; pending: number; tiles: number };
type Api = LifeWorkerApi & { inspect(): Inspection };
const workerCode = `
const { parentPort, workerData } = require('node:worker_threads');
require(workerData.tsx);
const Comlink = require(workerData.comlink);
const nodeEndpoint = require(workerData.adapter);
const { createHash } = require('node:crypto');
const { LifeWorld } = require(workerData.simulate);
const { LifePreparation } = require(workerData.preparation);
const { createLifeWorkerApi } = require(workerData.api);
let world;
const sync = LifeWorld.prototype.sync;
LifeWorld.prototype.sync = function(...args) { world = this; return sync.apply(this, args); };
if (workerData.eager) LifePreparation.prototype.schedule = function() {
  const started = performance.now(), profile = this.profiler, record = profile?.preparationSlice;
  if (profile) profile.preparationSlice = () => record.call(profile, performance.now() - started);
  try { this.slice(); } finally { if (profile) profile.preparationSlice = record; }
};
const api = createLifeWorkerApi(workerData.eager ? () => 0 : undefined);
Comlink.expose({ ...api, inspect() {
  const tiles = [...world.tiles].sort(([a], [b]) => a.localeCompare(b));
  return {
    hash: createHash('sha256').update(JSON.stringify(tiles.map(([key, tile]) => [key, tile.movers, tile.pending, tile.stalls, tile.gatherers]))).digest('hex'),
    movers: tiles.reduce((sum, [, tile]) => sum + tile.movers.length, 0),
    pending: tiles.reduce((sum, [, tile]) => sum + tile.pending.length, 0), tiles: tiles.length
  };
}}, nodeEndpoint(parentPort));
`;
async function measure(from: LifeTile[], to: LifeTile[], eager: boolean) {
  const worker = new Worker(workerCode, {
    eval: true,
    workerData: {
      eager,
      tsx: require.resolve('tsx/cjs'),
      comlink: require.resolve('comlink/dist/umd/comlink.js'),
      adapter: require.resolve('comlink/dist/umd/node-adapter.js'),
      simulate: resolve(root, 'packages/renderer/src/life/simulate.ts'),
      preparation: resolve(root, 'packages/renderer/src/life/preparation.ts'),
      api: resolve(root, 'packages/renderer/src/life/worker-api.ts'),
    },
  });
  const remote = Comlink.wrap<Api>(nodeEndpoint(worker));
  try {
    await remote.init({ traffic: config.traffic, processions: [], profiling: true });
    await remote.sync(from);
    await remote.sync(to);
    await remote.init({ traffic: config.traffic, processions: [], profiling: true });
    // Initial population is deliberately identical and outside timing. Only loading is measured.
    await remote.sync(from);
    const center = tileToLngLat({ z: 16, x: 55192, y: 30264 }, { x: 0, y: 0 });
    const camera = { lng: center[0], lat: center[1], zoom: 18 },
      size = { width: 1920, height: 1080 };
    const [[west, south], [east, north]] = viewportFor(camera, size).getBounds() as [
      [number, number],
      [number, number],
    ];
    const bounds: [number, number, number, number] = [west, south, east, north];
    const cell = stepCell(DEFAULT_CELLS, cellStep(DEFAULT_CELLS, camera.zoom));
    const minimum = metersPerCssPx(camera) * cell.width;
    const input: FrameInput = {
      gust: {
        camera,
        size,
        cssCell: { w: cell.width, h: cell.height },
        time: 0,
        wind: { dir: [1, 0], strength: 0 },
      },
      step: {
        dt: 0,
        zoom: 18,
        bounds,
        wind: undefined,
        weather: { rain: 0, minutes: 720 },
        cellMeters: minimum,
      },
      visible: [18, activityLevels(1), center, { rain: 0, sunAltitude: 40 }, bounds],
    };
    await remote.frame(input);
    const timings: Record<string, number[]> = {},
      ages: number[] = [],
      latency: number[] = [];
    let lastPosted = performance.now(),
      busy = false,
      quiet = 0,
      frames = 0;
    await remote.sync(to, center, {
      bounds,
      spawnMarginM: spawnMargin(minimum, cell.height / cell.width),
    });
    await new Promise<void>((done, reject) => {
      const started = performance.now();
      const timer = setInterval(() => {
        const now = performance.now();
        ages.push(now - lastPosted);
        if (now - started > 60000) {
          clearInterval(timer);
          reject(new Error('Preparation did not quiesce'));
          return;
        }
        if (busy) return;
        busy = true;
        const posted = now;
        remote.frame(input).then(
          (reply: FrameReply) => {
            frames++;
            latency.push(performance.now() - posted);
            lastPosted = posted;
            for (const [stage, value] of Object.entries(reply.profile?.ms ?? {})) {
              if (stage !== 'prepareSlice') (timings[stage] ??= []).push(value);
            }
            (timings.prepareSlice ??= []).push(...(reply.profile?.preparationSlices ?? []));
            quiet =
              reply.profile?.ms.prepareSlice === undefined &&
              reply.profile?.ms.activation === undefined
                ? quiet + 1
                : 0;
            busy = false;
            if (quiet >= 8) {
              clearInterval(timer);
              done();
            }
          },
          (error: unknown) => {
            clearInterval(timer);
            reject(error instanceof Error ? error : new Error(String(error)));
          },
        );
      }, 16);
    });
    return {
      eager,
      frames,
      acceptedAge: summary(ages),
      latency: summary(latency),
      stages: Object.fromEntries(
        Object.entries(timings).map(([stage, values]) => [stage, summary(values)]),
      ),
      population: await remote.inspect(),
    };
  } finally {
    remote[Comlink.releaseProxy]();
    await worker.terminate();
  }
}
const results = [];
for (const [name, from, to] of [
  ['pan', initial, pan],
  ['zoom', parents, initial],
] as const) {
  const cold = [await measure(from, to, !control), await measure(from, to, false)];
  const pairs = [];
  for (let run = 0; run < runs; run++) {
    const first = await measure(from, to, run % 2 === 0 && !control);
    const second = await measure(from, to, run % 2 !== 0 && !control);
    const [eager, staged] = run % 2 ? [second, first] : [first, second];
    pairs.push({
      eager,
      staged,
      populationMatched: eager.population.hash === staged.population.hash,
    });
    console.log(
      `${name} pair ${run + 1}/${runs}: matched=${eager.population.hash === staged.population.hash}, activation=${staged.stages.activation?.p95.toFixed(2)}ms, slice=${staged.stages.prepareSlice?.p95.toFixed(2)}ms`,
    );
  }
  results.push({ name, cold, pairs });
}
if ((await currentSourceHash(root)) !== source) throw new Error('Source changed during capture');
await writeFile(
  output,
  JSON.stringify(
    {
      source,
      archiveHash: archive.hash,
      node: process.version,
      cpu: cpus()[0]?.model,
      runs,
      control,
      dt: 0,
      frameIntervalMs: 16,
      reference: control
        ? 'same corrected implementation, staged preparation on both sides'
        : 'same corrected implementation, synchronous preparation with identical ready batches',
      results,
    },
    null,
    2,
  ),
);
console.log(`Report: ${output}`);
