import { deepStrictEqual } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { cpus, platform, release, getPriority } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotRevision, snapshotCurrent, currentSourceHash } from './snapshot';
import {
  scenarioTilesAt,
  worldTiles,
  worldTerrainStats,
  SCENARIOS,
  SCENARIO_DIALOGUE,
} from '../src/life/testing/scenarios';
import type * as Simulation from '../src/life/simulate';
import type * as Draw from '../src/life/draw';
import type * as Scenarios from '../src/life/testing/scenarios';
import { themes } from '../src/theme';
import { FrameProfiler } from '../src/profile';
import { tileToLngLat } from '../src/raster/geometry';
import { spawnMargin } from '../src/life/births';
import { metersPerCssPx } from '../src/grid';
import { DEFAULT_CELLS, cellStep, stepCell } from '../src/density';
import { viewportFor } from '../src/camera';
import { withoutDecorations } from './decorations';
import { classId } from '../src/classes';
import { PersonPart } from '../src/life/people';
import { City } from '@atlas/shared';
import { activityLevels } from '../src/life/config';
import type * as Snapshot from '../src/life/terrain-snapshot';
import { openArchive, decodeLifeTiles, realPanStrip, archiveHash } from './archive';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const arg = (name: string, fallback = '') =>
  process.argv.find((v) => v.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const matchesCase = (name: string) =>
  arg('case')
    .split(',')
    .some((prefix) => name.startsWith(prefix));
const baseline = arg('baseline', '00f1f6f');
const pan = process.argv.includes('--pan');
const births = process.argv.includes('--births');
const control = process.argv.includes('--control');
const dialogue = process.argv.includes('--dialogue');
const momentOptions = dialogue ? { dialogue: SCENARIO_DIALOGUE } : undefined;
const customGates = !!arg('gate-median') || !!arg('gate-p95');
const medianGate = Number(arg('gate-median', '0.1'));
const p95Gate = Number(arg('gate-p95', '0.05'));
const zoom = Number(arg('zoom', '18'));
if (![medianGate, p95Gate, zoom].every(Number.isFinite) || medianGate < 0 || p95Gate < 0)
  throw new Error('Use nonnegative fractional gates and a finite zoom');
const real = process.argv.some((v) => v === '--real' || v.startsWith('--real='));
if (births && !real) throw new Error('--births requires --real and --pan');
if (real && !pan) throw new Error('--real requires --pan');
const allowDiff = pan || process.argv.includes('--allow-diff');
const allowDecorativeDiff = process.argv.includes('--allow-decorative-diff');
if (allowDiff && allowDecorativeDiff)
  throw new Error('Decoration-only and broad differences are mutually exclusive');
if (pan) console.log('pan implies --allow-diff: eviction may change the terrain reference');
if (allowDiff) console.log('behavior differs from baseline: timing only');
if (!/^[\w./-]+$/.test(baseline)) throw new Error('Invalid baseline revision');
const scratch = resolve(root, arg('scratch-dir', arg('scratch', 'test-results')));
const samples = Number(arg('samples', '160'));
const runs = Number(arg('runs', '6'));
if (runs % 2) throw new Error('Use an even run count for balanced paired order');
if (![samples, runs].every((n) => Number.isInteger(n) && n > 0))
  throw new Error('Invalid sample/run count');
await mkdir(scratch, { recursive: true });
const temporary = await mkdtemp(join(scratch, 'life-world-'));
async function cleanup() {
  if (
    dirname(resolve(temporary)) !== resolve(scratch) ||
    !basename(temporary).startsWith('life-world-')
  )
    throw new Error('Unexpected benchmark cleanup directory');
  await rm(temporary, { recursive: true, force: true });
}
const warmup = 90;
const glyph = (s: string) => ((s.codePointAt(0) ?? 0) % 254) + 1;

const quantile = (vs: number[], q: number) => {
  const s = vs.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))]!;
};
const summary = (vs: number[]) => ({ median: quantile(vs, 0.5), p95: quantile(vs, 0.95) });
type Stages = 'step' | 'visible' | 'pack' | 'combined';
try {
  const currentHash = await currentSourceHash(root);
  const changedGraph = await snapshotCurrent(root, join(temporary, 'current'));
  const frozen = control
    ? await snapshotCurrent(root, join(temporary, 'baseline'))
    : await snapshotRevision(root, baseline, join(temporary, 'baseline'));
  const before = (await import(frozen.path('life/simulate.ts'))) as typeof Simulation;
  const { LifeWorld } = (await import(changedGraph.path('life/simulate.ts'))) as typeof Simulation;
  const oldDraw = (await import(frozen.path('life/draw.ts'))) as typeof Draw;
  const { packLife, buildLifeGlyphs } = (await import(
    changedGraph.path('life/draw.ts')
  )) as typeof Draw;
  const oldScenarios = (await import(frozen.path('life/testing/scenarios.ts'))) as typeof Scenarios;
  const { makeScenario, completeScenarioState } = (await import(
    changedGraph.path('life/testing/scenarios.ts')
  )) as typeof Scenarios;
  const glyphs = buildLifeGlyphs(glyph);
  const { snapshotOf } = (await import(
    changedGraph.path('life/terrain-snapshot.ts')
  )) as typeof Snapshot;
  if (real) {
    const oldSnapshot = (await import(frozen.path('life/terrain-snapshot.ts'))) as {
      snapshotOf: typeof snapshotOf;
    };
    const city = arg('real', 'naga');
    const ids = realPanStrip(city);
    const configPath = join(root, 'packages/content/cities', city, 'city.json');
    const configBytes = await readFile(configPath);
    const config = City.parse(JSON.parse(configBytes.toString()) as unknown);
    const configHash = createHash('sha256').update(configBytes).digest('hex');
    const local = await openArchive(city);
    try {
      const decoded = await decodeLifeTiles(local.archive, ids);
      const byKey = new Map(decoded.map((tile) => [tile.key, tile]));
      const skipped = ids.map(({ z, x, y }) => `${z}/${x}/${y}`).filter((key) => !byKey.has(key));
      console.log(
        `Real strip: ${decoded.length}/40 tiles; skipped: ${skipped.join(', ') || 'none'}`,
      );
      if (decoded.length < 24) throw new Error('Fewer than 24 real-strip tiles exist');
      const windows = Array.from({ length: 7 }, (_, shift) =>
        decoded.filter(({ tile }) => tile.x >= 55189 + shift && tile.x < 55193 + shift),
      );
      const cameras = windows.map((_, shift) => {
        const center = tileToLngLat({ z: 16, x: 55191 + shift, y: 30264 }, { x: 0, y: 0 });
        const [[west, south], [east, north]] = viewportFor(
          { lng: center[0], lat: center[1], zoom: 18 },
          { width: 1920, height: 1080 },
        ).getBounds() as [number[], number[]];
        return {
          center,
          bounds: [west!, south!, east!, north!] as [number, number, number, number],
        };
      });
      const realStages = [
        'syncFrame',
        'step',
        'sync',
        'spawn',
        'settle',
        'terrainRebuild',
        'terrainRoads',
        'terrainRevalidate',
        'terrainEncode',
        'clearanceBuild',
      ] as const;
      type RealStage = (typeof realStages)[number];
      const summarize = (values: number[]) => ({
        count: values.length,
        median: values.length ? quantile(values, 0.5) : null,
        p95: values.length ? quantile(values, 0.95) : null,
      });
      const measure = (Constructor: typeof LifeWorld, encode: typeof snapshotOf) => {
        const profiler = new FrameProfiler();
        const world = new Constructor(config.traffic, profiler);
        const levels = activityLevels(1);
        const timings = Object.fromEntries(
          realStages.map((stage) => [stage, [] as number[]]),
        ) as Record<RealStage, number[]>;
        const cell = stepCell(DEFAULT_CELLS, cellStep(DEFAULT_CELLS, 18));
        const minimum = births
          ? metersPerCssPx({ lng: cameras[0]!.center[0], lat: cameras[0]!.center[1], zoom: 18 }) *
            cell.width
          : 0.9;
        const view = (i: number) =>
          births
            ? {
                bounds: cameras[i]!.bounds,
                spawnMarginM: spawnMargin(minimum, cell.height / cell.width),
              }
            : undefined;
        world.sync(windows[0]!, cameras[0]!.center, view(0));
        let birthGuardBuilds = 0;
        const internal = world as unknown as { groundGuard(...args: unknown[]): unknown };
        const buildGuard = internal.groundGuard.bind(world);
        internal.groundGuard = (...args) => {
          if (args[3] === true) birthGuardBuilds++;
          return buildGuard(...args);
        };
        const initial = world.cellTerrain();
        if (!initial) throw new Error('Initial sync did not initialize terrain');
        encode(initial);
        let version = initial.version;
        profiler.reset();
        const samples = [];
        for (let frame = 0; frame < (births ? 630 : 210); frame++) {
          const shift = births ? (frame < 30 ? 0 : 1) : Math.floor(frame / 30);
          const { center, bounds } = cameras[shift]!;
          const changed = births ? frame === 30 : frame > 0 && frame % 30 === 0;
          profiler.begin(frame / 30);
          const start = performance.now();
          if (changed) world.sync(windows[shift]!, center, view(shift));
          world.step(
            births ? 0.1 : 1 / 30,
            undefined,
            18,
            bounds,
            undefined,
            { rain: 0, minutes: 720, cityLife: config.life },
            minimum,
          );
          timings[changed ? 'syncFrame' : 'step'].push(performance.now() - start);
          world.visible(18, levels, center, { rain: 0, sunAltitude: 40 }, bounds);
          const terrain = world.cellTerrain();
          if (terrain && terrain.version !== version) {
            const encodeStart = performance.now();
            encode(terrain);
            profiler.add('terrainEncode', performance.now() - encodeStart);
            version = terrain.version;
          }
          const sample = profiler.drain()!;
          samples.push({
            ...sample,
            pendingBirths: [...worldTiles(world).values()].reduce(
              (sum, tile) => sum + tile.pending.length,
              0,
            ),
            birthGuardBuilds,
          });
          for (const stage of realStages) {
            if (stage === 'step' || stage === 'syncFrame') continue;
            const ms = sample.ms[stage];
            if (ms !== undefined) timings[stage].push(ms);
          }
        }
        return {
          stages: Object.fromEntries(
            realStages.map((stage) => [stage, summarize(timings[stage])]),
          ) as Record<RealStage, ReturnType<typeof summarize>>,
          stats: worldTerrainStats(world),
          birthGuardBuilds,
          pendingBirths: [...worldTiles(world).values()].reduce(
            (sum, tile) => sum + tile.pending.length,
            0,
          ),
          samples,
        };
      };
      // Untimed paired warmup compiles both source graphs before collecting comparable runs.
      measure(before.LifeWorld, oldSnapshot.snapshotOf);
      measure(LifeWorld, snapshotOf);
      const oldRuns: ReturnType<typeof measure>[] = [],
        currentRuns: typeof oldRuns = [];
      for (let run = 0; run < runs; run++) {
        if (run % 2) {
          currentRuns.push(measure(LifeWorld, snapshotOf));
          oldRuns.push(measure(before.LifeWorld, oldSnapshot.snapshotOf));
        } else {
          oldRuns.push(measure(before.LifeWorld, oldSnapshot.snapshotOf));
          currentRuns.push(measure(LifeWorld, snapshotOf));
        }
        console.log(`Real pan pair ${run + 1}/${runs}`);
      }
      const stages = Object.fromEntries(
        realStages.map((stage) => {
          const aggregate = (rs: typeof oldRuns) => {
            const medians = rs.flatMap((r) =>
              r.stages[stage].median === null ? [] : [r.stages[stage].median],
            );
            const p95s = rs.flatMap((r) =>
              r.stages[stage].p95 === null ? [] : [r.stages[stage].p95],
            );
            return {
              count: rs.reduce((n, r) => n + r.stages[stage].count, 0),
              median: medians.length ? quantile(medians, 0.5) : null,
              p95: p95s.length ? quantile(p95s, 0.5) : null,
            };
          };
          const old = aggregate(oldRuns),
            current = aggregate(currentRuns);
          return [
            stage,
            {
              baseline: old,
              current,
              p95Change: old.p95 && current.p95 !== null ? current.p95 / old.p95 - 1 : null,
            },
          ];
        }),
      );
      if (
        (await currentSourceHash(root)) !== currentHash ||
        (await archiveHash(local.path)) !== local.hash ||
        !(await readFile(configPath)).equals(configBytes)
      )
        throw new Error('Source, archive or city config changed during capture');
      const output = resolve(root, arg('output', 'test-results/world-real-pan.json'));
      await mkdir(dirname(output), { recursive: true });
      await writeFile(
        output,
        JSON.stringify(
          {
            version: 1,
            at: new Date().toISOString(),
            baseline,
            allowDiff,
            baselineHash: control ? currentHash : frozen.hash,
            control,
            currentHash,
            archiveHash: local.hash,
            configHash,
            lockHash: execFileSync('git', ['hash-object', 'pnpm-lock.yaml'], {
              cwd: root,
              encoding: 'utf8',
            }).trim(),
            environment: {
              node: process.version,
              platform: platform(),
              processPriority: getPriority(),
              os: release(),
              cpu: cpus()[0]?.model,
            },
            parameters: {
              city,
              runs,
              births,
              frames: births ? 630 : 210,
              shifts: births ? 1 : 6,
              shiftEvery: 30,
              window: [4, 4],
              strip: ids,
              found: decoded.map((tile) => tile.key),
              skipped,
              initialSyncTimed: false,
              initialEncodeTimed: false,
              warmupPairs: 1,
              viewport: [1920, 1080],
              camera: 'window centre',
              zoom: 18,
              dt: births ? 0.1 : 1 / 30,
              minutes: 720,
              rain: 0,
              activity: 1,
              clearanceMinimumMeters: births ? 'two-dimensional CSS schedule at zoom 18' : 0.9,
              traffic: config.traffic,
              cityLife: config.life,
              aggregation: 'median of per-run medians and p95s; counts summed',
            },
            stages,
            oldRuns,
            currentRuns,
          },
          null,
          2,
        ),
      );
      console.table(
        Object.entries(stages).map(([stage, row]) => ({
          stage,
          baselineMedian: row.baseline.median,
          baselineP95: row.baseline.p95,
          currentMedian: row.current.median,
          currentP95: row.current.p95,
          baselineCount: row.baseline.count,
          currentCount: row.current.count,
          p95Change: row.p95Change,
        })),
      );
      console.table(currentRuns[0]!.stats);
      if (births)
        console.table({
          baseline: {
            pending: oldRuns[0]!.pendingBirths,
            birthGuardBuilds: oldRuns[0]!.birthGuardBuilds,
          },
          current: {
            pending: currentRuns[0]!.pendingBirths,
            birthGuardBuilds: currentRuns[0]!.birthGuardBuilds,
          },
        });
      console.log(`Report: ${output}`);
    } finally {
      await local.close();
    }
  } else if (pan) {
    const rows = [];
    for (const kind of SCENARIOS.filter((kind) => kind !== 'sparse')) {
      const name = `${kind}/16/pan`;
      if (!matchesCase(name)) continue;
      const windows = Array.from({ length: 9 }, (_, shift) =>
        scenarioTilesAt(
          kind,
          Array.from({ length: 16 }, (_, i) => ({ dx: shift + (i % 4), dy: Math.floor(i / 4) })),
        ),
      );
      const measure = (Constructor: typeof LifeWorld) => {
        const world = new Constructor(
          kind === 'transit' || kind === 'rain' ? { road_major: { jeepney: 1 } } : undefined,
        );
        const levels = makeScenario(kind, 1).levels;
        const timings = { syncFrame: [] as number[], step: [] as number[] };
        // Populate before measuring: the eight pan shifts, not initial spawning, are the target.
        world.sync(windows[0]!);
        for (let frame = 0; frame < 270; frame++) {
          const shift = Math.floor(frame / 30);
          const tiles = windows[shift]!;
          const center = tileToLngLat(tiles[0]!.tile, { x: 2048, y: 2048 });
          const [[west, south], [east, north]] = viewportFor(
            { lng: center[0], lat: center[1], zoom: 18 },
            { width: 1920, height: 1080 },
          ).getBounds() as [number[], number[]];
          const bounds: [number, number, number, number] = [west!, south!, east!, north!];
          const rain = kind === 'rain' && Math.floor(frame / 90) % 2 === 0 ? 1 : 0;
          const changed = frame > 0 && frame % 30 === 0;
          const start = performance.now();
          if (changed) world.sync(tiles);
          world.step(1 / 30, undefined, 18, bounds, undefined, { rain, minutes: 720 }, 0.9);
          timings[changed ? 'syncFrame' : 'step'].push(performance.now() - start);
          world.visible(18, levels, center, { rain, sunAltitude: 40 }, bounds);
        }
        return { syncFrame: summary(timings.syncFrame), step: summary(timings.step) };
      };
      const oldRuns: ReturnType<typeof measure>[] = [],
        currentRuns: ReturnType<typeof measure>[] = [];
      for (let run = 0; run < runs; run++) {
        if (run % 2) {
          currentRuns.push(measure(LifeWorld));
          oldRuns.push(measure(before.LifeWorld));
        } else {
          oldRuns.push(measure(before.LifeWorld));
          currentRuns.push(measure(LifeWorld));
        }
      }
      const stages = Object.fromEntries(
        (['syncFrame', 'step'] as const).map((stage) => {
          const aggregate = (rs: typeof oldRuns) => ({
            median: quantile(
              rs.map((r) => r[stage].median),
              0.5,
            ),
            p95: quantile(
              rs.map((r) => r[stage].p95),
              0.5,
            ),
          });
          const old = aggregate(oldRuns),
            current = aggregate(currentRuns);
          return [
            stage,
            {
              baseline: old,
              current,
              medianGain: 1 - current.median / old.median,
              p95Change: current.p95 / old.p95 - 1,
            },
          ];
        }),
      );
      rows.push({ name, stages, oldRuns, currentRuns });
      console.log(
        `${name}: syncFrame p95 ${(stages.syncFrame!.p95Change * 100).toFixed(1)}% change; step p95 ${(stages.step!.p95Change * 100).toFixed(1)}% change`,
      );
    }
    if (!rows.length) throw new Error('No fixtures matched --case');
    if ((await currentSourceHash(root)) !== currentHash)
      throw new Error('Runtime source changed during the benchmark; rerun for a stable comparison');
    const output = resolve(root, arg('output', 'test-results/world-pan.json'));
    await mkdir(dirname(output), { recursive: true });
    await writeFile(
      output,
      JSON.stringify(
        {
          version: 1,
          at: new Date().toISOString(),
          baseline,
          allowDiff,
          baselineHash: control ? currentHash : frozen.hash,
          control,
          currentHash,
          environment: {
            node: process.version,
            platform: platform(),
            os: release(),
            cpu: cpus()[0]?.model,
          },
          parameters: {
            runs,
            frames: 270,
            shiftEvery: 30,
            shifts: 8,
            initialSyncTimed: false,
            window: [4, 4],
            seed: 1,
            dt: 1 / 30,
            zoom: 18,
          },
          rows,
        },
        null,
        2,
      ),
    );
    console.log(`Report: ${output}`);
  } else {
    const rows = [];
    const fixtures = SCENARIOS.flatMap((kind) =>
      [1, 4, 16].flatMap((count) => [false, true].map((mobile) => ({ kind, count, mobile, zoom }))),
    );
    for (const { kind, count, mobile, zoom } of fixtures) {
      const name = `${kind}${zoom === 18 ? '' : `-z${zoom}`}/${count}/${mobile ? 'phone-bounds' : 'desktop'}`;
      if (!matchesCase(name)) continue;
      const a = (zoom === 18 ? oldScenarios.makeScenario : makeScenario)(
        kind,
        count,
        mobile,
        1,
        before.LifeWorld,
        undefined,
        momentOptions,
        zoom,
      );
      const b = makeScenario(kind, count, mobile, 1, LifeWorld, undefined, momentOptions, zoom);
      const oldPixels = new Uint8Array(a.grid.cols * a.grid.rows * 4),
        nextPixels = new Uint8Array(oldPixels.length);
      const observedCues = { brake: false, hazard: false, puff: false };
      for (let frame = 0; frame < 300; frame++) {
        const minimum = [0, 0.9, 3][Math.floor(frame / 100)]!;
        const av = a.step(frame, 1 / 30, minimum),
          bv = b.step(frame, 1 / 30, minimum);
        for (const actor of bv) {
          observedCues.brake ||= actor.lamps?.kind === 'brake';
          observedCues.hazard ||= actor.lamps?.kind === 'hazard';
        }
        if (!allowDiff && !allowDecorativeDiff)
          deepStrictEqual(bv, av, `${name}: visible frame ${frame}`);
        if (frame % 30 === 0) {
          if (!allowDiff)
            deepStrictEqual(
              allowDecorativeDiff
                ? withoutDecorations(completeScenarioState(b.world))
                : completeScenarioState(b.world),
              allowDecorativeDiff
                ? withoutDecorations(oldScenarios.completeScenarioState(a.world))
                : oldScenarios.completeScenarioState(a.world),
              `${name}: state frame ${frame}`,
            );
          oldDraw.packLife(
            oldPixels,
            a.grid,
            av,
            themes.dark,
            glyph,
            undefined,
            glyphs,
            a.world.visiblePuffs,
          );
          packLife(
            nextPixels,
            b.grid,
            bv,
            themes.dark,
            glyph,
            undefined,
            glyphs,
            b.world.visiblePuffs,
          );
          if (!observedCues.puff)
            for (let at = 0; at < nextPixels.length; at += 4)
              if (
                (nextPixels[at + 1]! & 63) === classId('life_person') &&
                ((nextPixels[at + 3]! >> 4) & 7) === PersonPart.puff &&
                nextPixels[at + 2]
              ) {
                observedCues.puff = true;
                break;
              }
          if (!allowDiff && !allowDecorativeDiff)
            deepStrictEqual(nextPixels, oldPixels, `${name}: packed frame ${frame}`);
        }
      }
      const prepareMeasure = (
        Constructor: typeof LifeWorld,
        pack: typeof packLife,
        profiler?: FrameProfiler,
      ) => {
        const scenarioFactory =
          Constructor === before.LifeWorld && zoom === 18
            ? oldScenarios.makeScenario
            : makeScenario;
        const s = scenarioFactory(
          kind,
          count,
          mobile,
          1,
          Constructor,
          profiler,
          momentOptions,
          zoom,
        );
        const out = new Uint8Array(s.grid.cols * s.grid.rows * 4);
        const timings: Record<Stages, number[]> = {
          step: [],
          visible: [],
          pack: [],
          combined: [],
        };
        let agents = 0,
          maxVisits = 0,
          maxServices = 0,
          maxMoments = 0,
          maxBalls = 0,
          maxScenes = 0,
          speechFrames = 0,
          speechCues = 0,
          sceneSpeechCues = 0;
        const visitStates = new Set<string>();
        const heapBefore = process.memoryUsage().heapUsed;
        return {
          sample(frame: number) {
            const callbackStart = profiler?.time();
            profiler?.begin(frame);
            const env = s.environment(frame);
            const start = performance.now();
            s.world.step(
              1 / 30,
              undefined,
              zoom,
              s.bounds,
              undefined,
              env,
              0.9,
              1.8,
              metersPerCssPx({ lng: s.center[0], lat: s.center[1], zoom }) * 10,
            );
            const moved = performance.now();
            const visible = s.world.visible(
              zoom,
              s.levels,
              s.center,
              { rain: env.rain, sunAltitude: 40 },
              s.bounds,
            );
            const selected = performance.now();
            agents = pack(
              out,
              s.grid,
              visible,
              themes.dark,
              glyph,
              undefined,
              glyphs,
              s.world.visiblePuffs,
            );
            const packed = performance.now();
            if (profiler) {
              profiler.add('step', moved - start);
              profiler.add('visible', selected - moved);
              profiler.add('pack', packed - selected);
              profiler.draw(packed - start, agents);
              profiler.end();
            }
            const completed = profiler?.time();
            const cues = visible.reduce((count, agent) => count + Number(!!agent.speech), 0);
            speechCues += cues;
            sceneSpeechCues += visible.reduce(
              (count, agent) => count + Number(!!agent.speech?.id.includes(':scene:')),
              0,
            );
            if (cues) speechFrames++;
            for (const tile of worldTiles(s.world).values()) {
              const moments = tile.momentHost?.moments;
              if (moments) {
                maxMoments = Math.max(maxMoments, moments.size);
                maxBalls = Math.max(maxBalls, moments.balls().length);
              }
              maxScenes = Math.max(maxScenes, tile.momentHost?.scenes.size ?? 0);
              maxVisits = Math.max(maxVisits, tile.scenes.visits.size);
              maxServices = Math.max(maxServices, tile.scenes.services.size);
              for (const visit of tile.scenes.visits.values()) visitStates.add(visit.state);
            }
            if (frame >= warmup) {
              timings.step.push(moved - start);
              timings.visible.push(selected - moved);
              timings.pack.push(packed - selected);
              timings.combined.push(
                callbackStart === undefined || completed === undefined
                  ? packed - start
                  : completed - callbackStart,
              );
            }
            if (frame === warmup - 1) profiler?.reset();
          },
          result() {
            const sceneStarts = [...worldTiles(s.world).values()].reduce(
              (count, tile) =>
                count +
                Object.values(tile.momentHost?.scenes.selector.selected ?? {}).reduce(
                  (sum, count) => sum + count,
                  0,
                ),
              0,
            );
            if (dialogue && Constructor === LifeWorld && (!sceneStarts || !sceneSpeechCues))
              throw new Error(
                `${name}: dialogue benchmark recorded no scene admissions or speech cues`,
              );
            return {
              stages: Object.fromEntries(
                Object.entries(timings).map(([k, v]) => [k, summary(v)]),
              ) as Record<Stages, ReturnType<typeof summary>>,
              agents,
              maxVisits,
              maxServices,
              maxMoments,
              maxBalls,
              maxScenes,
              sceneStarts,
              speechFrames,
              speechCues,
              sceneSpeechCues,
              momentStarts: [...worldTiles(s.world).values()].map(
                (t) => t.momentHost?.moments.stats.started,
              ),
              visitStates: [...visitStates],
              simulated: [...worldTiles(s.world).values()].reduce(
                (n, t) => n + t.movers.length + t.gatherers.length,
                0,
              ),
              heapDelta: process.memoryUsage().heapUsed - heapBefore,
              profile: profiler?.snapshot(),
              timings,
            };
          },
        };
      };
      const measure = (
        Constructor: typeof LifeWorld,
        pack: typeof packLife,
        profiler?: FrameProfiler,
      ) => {
        const arm = prepareMeasure(Constructor, pack, profiler);
        for (let frame = 0; frame < warmup + samples; frame++) arm.sample(frame);
        return arm.result();
      };
      // Warm both graphs and the shared caller before retaining any paired observations.
      const calibrationA = prepareMeasure(before.LifeWorld, oldDraw.packLife),
        calibrationB = prepareMeasure(LifeWorld, packLife);
      for (let frame = 0; frame < warmup + samples; frame++) {
        if (frame % 2) {
          calibrationB.sample(frame);
          calibrationA.sample(frame);
        } else {
          calibrationA.sample(frame);
          calibrationB.sample(frame);
        }
      }
      const oldRuns: ReturnType<typeof measure>[] = [],
        currentRuns: ReturnType<typeof measure>[] = [];
      for (let run = 0; run < runs; run++) {
        const a = prepareMeasure(before.LifeWorld, oldDraw.packLife),
          b = prepareMeasure(LifeWorld, packLife);
        for (let frame = 0; frame < warmup + samples; frame++) {
          if (run % 2) {
            b.sample(frame);
            a.sample(frame);
          } else {
            a.sample(frame);
            b.sample(frame);
          }
        }
        oldRuns.push(a.result());
        currentRuns.push(b.result());
      }
      // Pool retained samples; individual runs have relatively few tail observations.
      const aggregate = (rs: typeof oldRuns, stage: Stages) =>
        summary(rs.flatMap((r) => r.timings[stage]));
      const stages = Object.fromEntries(
        (['step', 'visible', 'pack', 'combined'] as const).map((stage) => {
          const old = aggregate(oldRuns, stage),
            next = aggregate(currentRuns, stage);
          return [
            stage,
            {
              baseline: old,
              current: next,
              medianGain: 1 - next.median / old.median,
              p95Change: next.p95 / old.p95 - 1,
            },
          ];
        }),
      );
      const instrumentation = process.argv.includes('--overhead')
        ? { plain: [] as typeof currentRuns, profiled: [] as typeof currentRuns }
        : undefined;
      if (instrumentation)
        for (let run = 0; run < runs; run++) {
          if (run % 2) {
            instrumentation.profiled.push(measure(LifeWorld, packLife, new FrameProfiler()));
            instrumentation.plain.push(measure(LifeWorld, packLife));
          } else {
            instrumentation.plain.push(measure(LifeWorld, packLife));
            instrumentation.profiled.push(measure(LifeWorld, packLife, new FrameProfiler()));
          }
        }
      rows.push({
        name,
        dense: kind !== 'sparse',
        stages,
        oldRuns,
        currentRuns,
        instrumentation,
        observedCues,
      });
      const step = stages.step!;
      console.log(
        `${name}: step median ${(step.medianGain * 100).toFixed(1)}% reduction; p95 ${(step.p95Change * 100).toFixed(1)}% change; ${currentRuns[0]!.simulated} simulated / ${currentRuns[0]!.agents} packed`,
      );
    }
    if (!rows.length) throw new Error('No fixtures matched --case');
    if ((await currentSourceHash(root)) !== currentHash)
      throw new Error('Runtime source changed during the benchmark; rerun for a stable comparison');
    const regressions = rows
      .filter((row) =>
        customGates
          ? (['step', 'combined'] as const).some(
              (stage) =>
                row.stages[stage]!.medianGain < -medianGate ||
                row.stages[stage]!.p95Change > p95Gate,
            )
          : dialogue
            ? Object.values(row.stages).some(
                (v) =>
                  v.current.median - v.baseline.median > Math.max(0.1, v.baseline.median * 0.1) ||
                  v.current.p95 - v.baseline.p95 > Math.max(0.2, v.baseline.p95 * 0.15),
              )
            : row.stages.step!.p95Change > 0.05 || row.stages.combined!.p95Change > 0.05,
      )
      .map((r) => r.name);
    const denseMedianPass = rows
      .filter((r) => r.dense)
      .every((r) => r.stages.step!.medianGain >= 0.1);
    const report = {
      version: 1,
      at: new Date().toISOString(),
      baseline,
      allowDiff,
      allowDecorativeDiff,
      baselineHash: control ? currentHash : frozen.hash,
      control,
      dialogue,
      currentHash,
      currentGraphHash: changedGraph.hash,
      controlPass: control
        ? rows.every((r) =>
            ['step', 'combined'].every((stage) => {
              const v = r.stages[stage as Stages]!;
              return Math.abs(v.medianGain) <= 0.05 && Math.abs(v.p95Change) <= 0.05;
            }),
          )
        : undefined,
      gate: {
        denseMedianPass,
        regressions,
        pass: (customGates || dialogue || denseMedianPass) && regressions.length === 0,
        thresholds: customGates
          ? { stepAndCombinedMedianRegression: medianGate, stepAndCombinedP95Regression: p95Gate }
          : dialogue
            ? {
                medianRegression: 0.1,
                p95Regression: 0.15,
                medianAbsoluteMs: 0.1,
                p95AbsoluteMs: 0.2,
              }
            : { denseStepMedianGain: 0.1, stepAndCombinedP95Regression: 0.05 },
        requiresRepeat: true,
      },
      lockHash: execFileSync('git', ['hash-object', 'pnpm-lock.yaml'], {
        cwd: root,
        encoding: 'utf8',
      }).trim(),
      environment: {
        node: process.version,
        processPriority: getPriority(),
        platform: platform(),
        os: release(),
        cpu: cpus()[0]?.model,
      },
      parameters: {
        samples,
        runs,
        warmup,
        dt: 1 / 30,
        zoom,
        dialogue,
        seed: 1,
        casePrefix: arg('case'),
        cells: [10, 18],
        clearanceMinimumMeters: 0.9,
        pairing: `interleaved frames; ${runs / 2} A-first and ${runs / 2} B-first runs`,
        calibrationFramesPerArm: warmup + samples,
        aggregation: 'median and p95 of all retained samples; raw runs preserved',
        transitFleet: 'jeepney',
        profiled: false,
      },
      rows,
    };
    const output = resolve(root, arg('output', 'test-results/world-performance.json'));
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2));
    console.log(`Report: ${output}`);
  }
} finally {
  await cleanup();
}
