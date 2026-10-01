/** Reproducible CPU comparison; results are not browser FPS or phone GPU measurements. */
import { deepStrictEqual } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { viewportFor } from '../src/camera';
import { LifeBuilder, LifeLine } from '../src/life/geometry';
import * as current from '../src/life/simulate';
import { tileToLngLat } from '../src/raster/geometry';
import type { LngLatBounds } from '../src/life/procession';
import { snapshotRevision } from './snapshot';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const revision =
  process.argv.find((arg) => arg.startsWith('--baseline='))?.split('=')[1] ?? '68310a7';
if (!/^[\w./-]+$/.test(revision)) throw new Error('Invalid baseline revision');
const output = process.argv.find((arg) => arg.startsWith('--output='))?.slice(9);
const baselineFile = process.argv.find((arg) => arg.startsWith('--baseline-file='))?.slice(16);
const candidates = process.argv.includes('--candidates');
const following = process.argv.includes('--following');
const allowDiff = process.argv.includes('--allow-diff');
if (allowDiff) console.log('behavior differs from baseline: timing only');
const casePrefix = process.argv.find((arg) => arg.startsWith('--case='))?.slice(7) ?? '';
const scratchRoot = resolve(
  process.argv.find((arg) => arg.startsWith('--scratch='))?.slice(10) ?? tmpdir(),
);
await mkdir(scratchRoot, { recursive: true });
const temporary = await mkdtemp(join(scratchRoot, 'atlas-life-perf-'));
async function removeBenchmarkDirectory() {
  if (
    dirname(resolve(temporary)) !== scratchRoot ||
    !basename(temporary).startsWith('atlas-life-perf-')
  )
    throw new Error('Refusing to remove an unexpected benchmark directory');
  await rm(temporary, { recursive: true, force: true });
}
type Simulation = typeof current;
const tile = { z: 16, x: 55192, y: 30266 };
const center = tileToLngLat(tile, { x: 2048, y: 2048 });
const b = new LifeBuilder();
for (let i = 0; i < 20; i++) {
  const o = 100 + i * 150;
  b.line(
    [
      { x: o, y: o },
      { x: 4000 - i * 10, y: o },
      { x: 4000 - i * 10, y: 4000 - i * 10 },
      { x: o, y: o },
    ],
    LifeLine.plaza,
  );
}
b.line(
  [
    { x: 0, y: 2048 },
    { x: 4095, y: 2048 },
  ],
  LifeLine.roadMajor,
  14,
);
b.roost({ x: 2048, y: 2048 });
const geometry = b.finish();
const camera = { lng: center[0], lat: center[1], zoom: 18 };
const boundsFor = (width: number, height: number): LngLatBounds => {
  const [[west, south], [east, north]] = viewportFor(camera, { width, height }).getBounds() as [
    [number, number],
    [number, number],
  ];
  return [west, south, east, north];
};
const quantile = (values: number[], q: number) => {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
};
function measure(action: () => unknown, warmup: number, batch: number) {
  for (let i = 0; i < warmup; i++) action();
  const samples: number[] = [];
  for (let i = 0; i < 160; i++) {
    const start = performance.now();
    for (let i = 0; i < batch; i++) action();
    samples.push((performance.now() - start) / batch);
  }
  return { median: quantile(samples, 0.5), p95: quantile(samples, 0.95) };
}
function compare(before: () => unknown, after: () => unknown) {
  const cost = (action: () => unknown) => {
    const start = performance.now();
    for (let i = 0; i < 20; i++) action();
    return (performance.now() - start) / 20;
  };
  const estimatedMs = Math.max(cost(before), cost(after), 0.001);
  const batch = Math.max(1, Math.min(50, Math.ceil(1 / estimatedMs)));
  const warmup = Math.max(10, Math.min(500, Math.ceil(40 / estimatedMs)));
  const old: ReturnType<typeof measure>[] = [],
    next: ReturnType<typeof measure>[] = [];
  for (let run = 0; run < 5; run++) {
    if (run % 2) {
      next.push(measure(after, warmup, batch));
      old.push(measure(before, warmup, batch));
    } else {
      old.push(measure(before, warmup, batch));
      next.push(measure(after, warmup, batch));
    }
  }
  const result = (runs: typeof old) => ({
    median: quantile(
      runs.map((r) => r.median),
      0.5,
    ),
    p95: quantile(
      runs.map((r) => r.p95),
      0.5,
    ),
  });
  const baseline = result(old),
    changed = result(next);
  return {
    baseline,
    current: changed,
    medianGain: 1 - changed.median / baseline.median,
    p95Change: changed.p95 / baseline.p95 - 1,
    warmup,
    batch,
  };
}

try {
  const sourcePath = 'packages/renderer/src/life/simulate.ts';
  const frozenRoot = join(temporary, 'baseline-snapshot');
  const frozen = baselineFile ? undefined : await snapshotRevision(root, revision, frozenRoot);
  const rawSource = baselineFile
    ? await readFile(resolve(root, baselineFile), 'utf8')
    : execFileSync('git', ['show', `${revision}:${sourcePath}`], { cwd: root, encoding: 'utf8' });
  const source = rawSource.replace(/\r\n/g, '\n');
  const rewrite = (source: string) =>
    source.replace(
      /(from\s+)(['"])([^'"]+)\2/g,
      (whole, prefix: string, quote: string, specifier: string) => {
        const path =
          specifier === '@atlas/shared'
            ? join(frozen ? frozenRoot : root, 'packages/shared/src/index.ts')
            : specifier.startsWith('.')
              ? resolve(
                  frozen && !specifier.startsWith('../../scripts/') ? frozenRoot : root,
                  dirname(sourcePath),
                  specifier,
                )
              : undefined;
        return path ? `${prefix}${quote}${pathToFileURL(path).href}${quote}` : whole;
      },
    );
  const baselinePath = join(temporary, 'baseline.mts');
  await writeFile(baselinePath, rewrite(source));
  const baseline = (await import(
    frozen?.path('life/simulate.ts') ?? pathToFileURL(baselinePath).href
  )) as Simulation;
  let changed: Simulation = current;
  let changedSource = await readFile(join(root, sourcePath), 'utf8');
  if (candidates || following) {
    let prototype = source;
    if (candidates) {
      prototype =
        `import { VisibleCandidates, collectVisible } from '../../scripts/prototypes/visible-candidates';\n` +
        prototype;
      prototype = prototype.replace(
        'export class LifeWorld {',
        'export class LifeWorld {\n private readonly candidates = new VisibleCandidates();',
      );
      const start = prototype.indexOf(
        '    for (const life of this.tiles.values()) {',
        prototype.indexOf('  visible('),
      );
      const end = prototype.lastIndexOf('    return kept;') + '    return kept;'.length;
      if (start < 0 || end < start) throw new Error('Visible prototype no longer matches source');
      prototype =
        prototype.slice(0, start) +
        '    return collectVisible(this.candidates, this.tiles.values(), zoom, levels, umbrellas, bounds, !!scene, staged, center);' +
        prototype.slice(end);
      prototype = prototype.replace('    const out: VisibleAgent[] = [];\n', '');
    }
    if (following) {
      prototype =
        `import { FollowingGroups, bucketFollow } from '../../scripts/prototypes/following';\n` +
        prototype;
      prototype = prototype.replace(
        'export class TileLife {',
        'export class TileLife {\n private readonly followGroups = new FollowingGroups();',
      );
      prototype = prototype.replace(
        'const groups = new Map<number, number[]>();',
        'const groups = this.followGroups.reset();',
      );
      const start = prototype.indexOf('      for (let k = 0; k < group.length - 1; k++) {');
      const end = prototype.indexOf('\n    }\n    return speeds;', start);
      if (start < 0 || end < start) throw new Error('Following prototype no longer matches source');
      prototype =
        prototype.slice(0, start) +
        '      bucketFollow(group, progress, offsets, movers, speeds, perMeter);' +
        prototype.slice(end);
    }
    const prototypePath = join(temporary, 'prototype.mts');
    await writeFile(prototypePath, rewrite(prototype));
    changed = (await import(pathToFileURL(prototypePath).href)) as Simulation;
    changedSource = prototype;
  }
  const rows: { name: string; timings: ReturnType<typeof compare> }[] = [];
  for (const count of [1, 4, 16, 64]) {
    for (const view of ['desktop', 'mobile', 'over-cap'] as const) {
      if (!`visible/${view}/${count}`.startsWith(casePrefix)) continue;
      const bounds = view === 'mobile' ? boundsFor(390, 844) : boundsFor(1920, 1080);
      const tiles = Array.from({ length: count }, (_, i) => ({
        key: `busy${i}`,
        tile:
          view === 'over-cap'
            ? tile
            : { ...tile, x: tile.x + (i % 8), y: tile.y + Math.floor(i / 8) },
        life: geometry,
      }));
      const make = (module: Simulation) => {
        const world = new module.LifeWorld();
        if (view === 'over-cap') {
          // This artificial placement stress case duplicates coordinates. Populate tile
          // simulations directly so cross-tile collision settling doesn't remove the crowd.
          const storage = (world as unknown as { tiles: Map<string, current.TileLife> }).tiles;
          for (const { key, tile, life } of tiles)
            storage.set(key, new module.TileLife(tile, life, module.hashString(key)));
        } else world.sync(tiles);
        return world;
      };
      const old = make(baseline),
        next = make(changed);
      for (let frame = 0; frame < 40; frame++) {
        const weather = { rain: frame % 2, sunAltitude: frame % 3 ? 40 : -10 };
        const zoom = [14, 16, 18, 20][frame % 4]!;
        if (!allowDiff)
          deepStrictEqual(
            next.visible(zoom, 1, center, weather, bounds),
            old.visible(zoom, 1, center, weather, bounds),
          );
        if (view === 'over-cap') {
          for (const world of [old, next])
            for (const life of (
              world as unknown as { tiles: Map<string, current.TileLife> }
            ).tiles.values())
              life.step(1 / 30);
        } else {
          old.step(1 / 30, undefined, zoom, bounds);
          next.step(1 / 30, undefined, zoom, bounds);
        }
      }
      const action = (world: current.LifeWorld) => () =>
        world.visible(18, 1, center, undefined, bounds);
      const timings = compare(action(old), action(next));
      const name = `visible/${view}/${count}`;
      rows.push({ name, timings });
      console.log(
        `${name}: median ${(timings.medianGain * 100).toFixed(1)}% reduction; p95 ${(timings.p95Change * 100).toFixed(1)}% change`,
      );
    }
  }
  for (const count of [16, 120, 600]) {
    if (!`traffic/${count}`.startsWith(casePrefix)) continue;
    const line = new LifeBuilder();
    line.line(
      [
        { x: 0, y: 2048 },
        { x: 4095, y: 2048 },
      ],
      LifeLine.roadMajor,
      14,
    );
    const geo = line.finish();
    const make = (module: Simulation) => {
      const life = new module.TileLife(tile, geo, 1);
      life.movers.length = 0;
      life.flocks.length = 0;
      const vehicles = ['car', 'bicycle', 'bus', 'motorcycle'] as const;
      for (let i = 0; i < count; i++)
        life.movers.push({
          kind: 'vehicle',
          vehicle: vehicles[i % 4],
          line: 0,
          from: 0,
          dir: 1,
          d: (i * 4090) / count,
          speed: 50,
          paint: 0,
          lane: (i % 3) / 3 + 0.1,
          pause: 0,
          rank: 0,
          x: (i * 4090) / count,
          y: 2048,
          hx: 1,
          hy: 0,
        });
      return life;
    };
    const old = make(baseline),
      next = make(changed);
    for (let frame = 0; frame < 100; frame++) {
      old.step(1 / 30);
      next.step(1 / 30);
      if (!allowDiff) deepStrictEqual(next.movers, old.movers);
    }
    const timings = compare(
      () => old.step(1 / 30),
      () => next.step(1 / 30),
    );
    rows.push({ name: `traffic/${count}`, timings });
    console.log(
      `traffic/${count}: median ${(timings.medianGain * 100).toFixed(1)}% reduction; p95 ${(timings.p95Change * 100).toFixed(1)}% change`,
    );
  }
  const report = {
    baseline: baselineFile ?? revision,
    allowDiff,
    baselineGraphHash: frozen?.hash,
    candidates,
    following,
    baselineHash: createHash('sha256').update(source).digest('hex'),
    sourceHash: createHash('sha256').update(changedSource).digest('hex'),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    fixture: 'seeded plazas and mixed traffic; over-cap duplicates tile positions deliberately',
    repetitions: 5,
    samples: 160,
    calibration: '20 calls per variant, shared batch targeting 1 ms, shared warmup targeting 40 ms',
    rows,
  };
  if (output) {
    const path = resolve(root, output);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(report, null, 2));
  }
} finally {
  await removeBenchmarkDirectory();
}
