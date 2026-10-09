/** Reproducible CPU comparison; results are not browser FPS or phone GPU measurements. */
import { deepStrictEqual, ok } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, getPriority } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { viewportFor } from '../src/camera';
import { LifeBuilder, LifeLine } from '../src/life/geometry';
import type * as current from '../src/life/simulate';
import { tileToLngLat } from '../src/raster/geometry';
import type { LngLatBounds } from '../src/life/procession';
import { snapshotRevision, snapshotWorkingTree, currentSourceHash } from './snapshot';
import { pairedRuns, pooledSummary, summary, withinControl } from './paired';
import {
  makePeddlerPerfWorld,
  peddlerPerfCounts,
  peddlerPerfCenter,
  peddlerPerfWeather,
  peddlerPerfGrid,
} from './peddler-fixture';
import { adaptPuffPacking } from './puff-packing';
import type * as drawModule from '../src/life/draw';
import type * as themeModule from '../src/theme';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const revision =
  process.argv.find((arg) => arg.startsWith('--baseline='))?.split('=')[1] ?? '68310a7';
if (!/^[\w./-]+$/.test(revision)) throw new Error('Invalid baseline revision');
const output = process.argv.find((arg) => arg.startsWith('--output='))?.slice(9);
const baselineFile = process.argv.find((arg) => arg.startsWith('--baseline-file='))?.slice(16);
const candidates = process.argv.includes('--candidates');
const following = process.argv.includes('--following');
const control = process.argv.includes('--control');
const interleaved = process.argv.includes('--interleaved');
if (control && (baselineFile || candidates || following))
  throw new Error('--control requires two unchanged complete source graphs');
const allowDiff = process.argv.includes('--allow-diff');
if (allowDiff) console.log('behavior differs from baseline: timing only');
const casePrefix = process.argv.find((arg) => arg.startsWith('--case='))?.slice(7) ?? '';
const samples = Number(process.argv.find((arg) => arg.startsWith('--samples='))?.slice(10) ?? 160);
const runs = Number(process.argv.find((arg) => arg.startsWith('--runs='))?.slice(7) ?? 6);
if (![samples, runs].every((n) => Number.isInteger(n) && n > 0) || runs % 2)
  throw new Error('Use positive sample and even paired run counts');
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
function compare(before: () => () => unknown, after: () => () => unknown) {
  const cost = (action: () => unknown) => {
    const start = performance.now();
    for (let i = 0; i < 20; i++) action();
    return (performance.now() - start) / 20;
  };
  const estimatedMs = Math.max(cost(before()), cost(after()), 0.001);
  const batch = Math.max(1, Math.min(50, Math.ceil(1 / estimatedMs)));
  const warmup = Math.max(90, Math.min(500, Math.ceil(40 / estimatedMs)));
  const sample = (action: () => unknown, retained?: number[]) => {
    const start = retained ? performance.now() : 0;
    for (let i = 0; i < batch; i++) action();
    if (retained) retained.push((performance.now() - start) / batch);
  };
  const arm = (factory: () => () => unknown) => {
    const action = factory(),
      retained: number[] = [];
    return {
      sample(_frame: number, keep: boolean) {
        sample(action, keep ? retained : undefined);
      },
      result() {
        return { ...summary(retained), samples: retained };
      },
    };
  };
  const { oldRuns: old, currentRuns: next } = pairedRuns(
    () => arm(before),
    () => arm(after),
    { calibration: 250, warmup, samples, runs, interleaved },
  );
  const baseline = pooledSummary(old, (run) => run.samples),
    changed = pooledSummary(next, (run) => run.samples);
  return {
    baseline,
    oldRuns: old,
    currentRuns: next,
    current: changed,
    medianGain: 1 - changed.median / baseline.median,
    p95Change: changed.p95 / baseline.p95 - 1,
    warmup,
    batch,
  };
}

try {
  const currentHash = await currentSourceHash(root);
  const frozenCurrent = await snapshotWorkingTree(root, join(temporary, 'current-snapshot'));
  const current = (await import(frozenCurrent.path('life/simulate.ts'))) as Simulation;
  const sourcePath = 'packages/renderer/src/life/simulate.ts';
  const frozenRoot = join(temporary, 'baseline-snapshot');
  const frozen = baselineFile
    ? undefined
    : control
      ? await snapshotWorkingTree(root, frozenRoot)
      : await snapshotRevision(root, revision, frozenRoot);
  const rawSource = baselineFile
    ? await readFile(resolve(root, baselineFile), 'utf8')
    : control
      ? await readFile(join(root, sourcePath), 'utf8')
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
  const rows: {
    name: string;
    timings: ReturnType<typeof compare>;
    counts?: Record<string, number>;
  }[] = [];
  if ('peddlers/hot-afternoon'.startsWith(casePrefix)) {
    if (!frozen) throw new Error('Peddler acceptance requires complete frozen source graphs');
    const counts = peddlerPerfCounts(makePeddlerPerfWorld(changed));
    ok(counts.sorbetes && counts['bote-dyaryo'], 'Required peddlers did not spawn');
    if (control) deepStrictEqual(peddlerPerfCounts(makePeddlerPerfWorld(baseline)), counts);
    const factory = async (
      module: Simulation,
      graph: typeof frozenCurrent,
      configured: boolean,
    ) => {
      const draw = (await import(graph.path('life/draw.ts'))) as typeof drawModule;
      const theme = (await import(graph.path('theme.ts'))) as typeof themeModule;
      const glyphs = ['', ...theme.mapGlyphs(theme.themes.dark)];
      const indices = new Map(glyphs.map((glyph, index) => [glyph, index]));
      const glyphIndex = (glyph: string) => indices.get(glyph) ?? 0;
      const prepared = draw.buildLifeGlyphs(glyphIndex);
      const pack = adaptPuffPacking(
        draw.packLife,
        await readFile(fileURLToPath(graph.path('life/draw.ts')), 'utf8'),
      );
      return () => {
        const world = makePeddlerPerfWorld(module, configured),
          out = new Uint8Array(peddlerPerfGrid.cols * peddlerPerfGrid.rows * 4);
        return () => {
          world.step(1 / 30, undefined, 19, undefined, undefined, peddlerPerfWeather);
          const agents = world.visible(19, 1, peddlerPerfCenter, peddlerPerfWeather);
          return pack(
            out,
            peddlerPerfGrid,
            agents,
            theme.themes.dark,
            glyphIndex,
            undefined,
            prepared,
            world.visiblePuffs,
          );
        };
      };
    };
    const old = await factory(baseline, frozen, control),
      next = await factory(changed, frozenCurrent, true);
    const timings = compare(old, next);
    rows.push({ name: 'peddlers/hot-afternoon', timings, counts });
    console.log(
      `peddlers/hot-afternoon: ${JSON.stringify(counts)}; median ${(-timings.medianGain * 100).toFixed(1)}% cost change; p95 ${(timings.p95Change * 100).toFixed(1)}% change`,
    );
  }
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
      const timings = compare(
        () => action(make(baseline)),
        () => action(make(changed)),
      );
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
      () => {
        const life = make(baseline);
        return () => life.step(1 / 30);
      },
      () => {
        const life = make(changed);
        return () => life.step(1 / 30);
      },
    );
    rows.push({ name: `traffic/${count}`, timings });
    console.log(
      `traffic/${count}: median ${(timings.medianGain * 100).toFixed(1)}% reduction; p95 ${(timings.p95Change * 100).toFixed(1)}% change`,
    );
  }
  if (!rows.length) throw new Error('No fixtures matched --case');
  const report = {
    baseline: baselineFile ?? revision,
    control,
    interleaved,
    currentHash,
    currentGraphHash: frozenCurrent.hash,
    controlPass: control ? rows.every((r) => withinControl(r.timings)) : undefined,
    allowDiff,
    baselineGraphHash: frozen?.hash,
    candidates,
    following,
    baselineHash: createHash('sha256').update(source).digest('hex'),
    sourceHash: createHash('sha256').update(changedSource).digest('hex'),
    node: process.version,
    processPriority: getPriority(),
    platform: process.platform,
    arch: process.arch,
    fixture: casePrefix.startsWith('peddlers/')
      ? 'validated Naga peddlers on eight wide safe paths; dry 13:00, sun altitude 60; combined step/visible/pack; identical seeded ordinary population'
      : 'seeded plazas and mixed traffic; over-cap duplicates tile positions deliberately',
    repetitions: runs,
    samples,
    calibration:
      '20 cost calls per arm; 250 discarded paired batches; shared batch targeting 1 ms; at least 90 warmup batches per fresh pair',
    pairing: `${interleaved ? 'interleaved samples' : 'isolated arm blocks'}; ${runs / 2} A-first and ${runs / 2} B-first runs`,
    aggregation: `median and p95 of all ${runs * samples} retained samples; raw runs preserved`,
    rows,
  };
  if ((await currentSourceHash(root)) !== currentHash)
    throw new Error('Runtime changed during benchmark');
  if (output) {
    const path = resolve(root, output);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(report, null, 2));
  }
} finally {
  await removeBenchmarkDirectory();
}
