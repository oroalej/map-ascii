import { deepStrictEqual } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { cpus, platform, release } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotRevision, currentSourceHash } from './snapshot';
import { makeScenario, scenarioState, worldTiles, SCENARIOS } from '../src/life/testing/scenarios';
import { LifeWorld } from '../src/life/simulate';
import { packLife, buildLifeGlyphs } from '../src/life/draw';
import { themes } from '../src/theme';
import { FrameProfiler } from '../src/profile';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const arg = (name: string, fallback = '') =>
  process.argv.find((v) => v.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const baseline = arg('baseline', '00f1f6f');
if (!/^[\w./-]+$/.test(baseline)) throw new Error('Invalid baseline revision');
const scratch = join(root, 'test-results');
const samples = Number(arg('samples', '160'));
const runs = Number(arg('runs', '5'));
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
const glyphs = buildLifeGlyphs(glyph);
const quantile = (vs: number[], q: number) => {
  const s = vs.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))]!;
};
const summary = (vs: number[]) => ({ median: quantile(vs, 0.5), p95: quantile(vs, 0.95) });
type Stages = 'step' | 'visible' | 'pack' | 'combined';
try {
  const currentHash = await currentSourceHash(root);
  const frozen = await snapshotRevision(root, baseline, join(temporary, 'baseline'));
  const before = (await import(frozen.path('life/simulate.ts'))) as { LifeWorld: typeof LifeWorld };
  const oldDraw = (await import(frozen.path('life/draw.ts'))) as { packLife: typeof packLife };
  const rows = [];
  for (const kind of SCENARIOS)
    for (const count of [1, 4, 16])
      for (const mobile of [false, true]) {
        const name = `${kind}/${count}/${mobile ? 'phone-bounds' : 'desktop'}`;
        if (!name.startsWith(arg('case'))) continue;
        const a = makeScenario(kind, count, mobile, 1, before.LifeWorld);
        const b = makeScenario(kind, count, mobile);
        const oldPixels = new Uint8Array(a.grid.cols * a.grid.rows * 4),
          nextPixels = new Uint8Array(oldPixels.length);
        for (let frame = 0; frame < 300; frame++) {
          const minimum = [0, 0.9, 3][Math.floor(frame / 100)]!;
          const av = a.step(frame, 1 / 30, minimum),
            bv = b.step(frame, 1 / 30, minimum);
          deepStrictEqual(bv, av, `${name}: visible frame ${frame}`);
          if (frame % 30 === 0) {
            deepStrictEqual(
              scenarioState(b.world),
              scenarioState(a.world),
              `${name}: state frame ${frame}`,
            );
            oldDraw.packLife(oldPixels, a.grid, av, themes.dark, glyph, undefined, glyphs);
            packLife(nextPixels, b.grid, bv, themes.dark, glyph, undefined, glyphs);
            deepStrictEqual(nextPixels, oldPixels, `${name}: packed frame ${frame}`);
          }
        }
        const measure = (
          Constructor: typeof LifeWorld,
          pack: typeof packLife,
          profiler?: FrameProfiler,
        ) => {
          const s = makeScenario(kind, count, mobile, 1, Constructor, profiler);
          const out = new Uint8Array(s.grid.cols * s.grid.rows * 4);
          const timings: Record<Stages, number[]> = {
            step: [],
            visible: [],
            pack: [],
            combined: [],
          };
          let agents = 0,
            maxVisits = 0,
            maxServices = 0;
          const visitStates = new Set<string>();
          const heapBefore = process.memoryUsage().heapUsed;
          for (let frame = 0; frame < warmup + samples; frame++) {
            const callbackStart = profiler?.time();
            profiler?.begin(frame);
            const env = s.environment(frame);
            const start = performance.now();
            s.world.step(1 / 30, undefined, 18, s.bounds, undefined, env, 0.9);
            const moved = performance.now();
            const visible = s.world.visible(
              18,
              s.levels,
              s.center,
              { rain: env.rain, sunAltitude: 40 },
              s.bounds,
            );
            const selected = performance.now();
            agents = pack(out, s.grid, visible, themes.dark, glyph, undefined, glyphs);
            const packed = performance.now();
            if (profiler) {
              profiler.add('step', moved - start);
              profiler.add('visible', selected - moved);
              profiler.add('pack', packed - selected);
              profiler.draw(packed - start, agents);
              profiler.end();
            }
            const completed = profiler?.time();
            for (const tile of worldTiles(s.world).values()) {
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
          }
          return {
            stages: Object.fromEntries(
              Object.entries(timings).map(([k, v]) => [k, summary(v)]),
            ) as Record<Stages, ReturnType<typeof summary>>,
            agents,
            maxVisits,
            maxServices,
            visitStates: [...visitStates],
            simulated: [...worldTiles(s.world).values()].reduce(
              (n, t) => n + t.movers.length + t.gatherers.length,
              0,
            ),
            heapDelta: process.memoryUsage().heapUsed - heapBefore,
            profile: profiler?.snapshot(),
          };
        };
        const oldRuns: ReturnType<typeof measure>[] = [],
          currentRuns: ReturnType<typeof measure>[] = [];
        for (let run = 0; run < runs; run++) {
          if (run % 2) {
            currentRuns.push(measure(LifeWorld, packLife));
            oldRuns.push(measure(before.LifeWorld, oldDraw.packLife));
          } else {
            oldRuns.push(measure(before.LifeWorld, oldDraw.packLife));
            currentRuns.push(measure(LifeWorld, packLife));
          }
        }
        const aggregate = (rs: typeof oldRuns, stage: Stages) => ({
          median: quantile(
            rs.map((r) => r.stages[stage].median),
            0.5,
          ),
          p95: quantile(
            rs.map((r) => r.stages[stage].p95),
            0.5,
          ),
        });
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
    .filter((r) => r.stages.step!.p95Change > 0.05 || r.stages.combined!.p95Change > 0.05)
    .map((r) => r.name);
  const denseMedianPass = rows
    .filter((r) => r.dense)
    .every((r) => r.stages.step!.medianGain >= 0.1);
  const report = {
    version: 1,
    at: new Date().toISOString(),
    baseline,
    baselineHash: frozen.hash,
    currentHash,
    gate: {
      denseMedianPass,
      regressions,
      pass: denseMedianPass && regressions.length === 0,
      thresholds: { denseStepMedianGain: 0.1, stepAndCombinedP95Regression: 0.05 },
      requiresRepeat: true,
    },
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
    parameters: {
      samples,
      runs,
      warmup,
      dt: 1 / 30,
      zoom: 18,
      seed: 1,
      casePrefix: arg('case'),
      cells: [10, 18],
      clearanceMinimumMeters: 0.9,
      transitFleet: 'jeepney',
      profiled: false,
    },
    rows,
  };
  const output = resolve(root, arg('output', 'test-results/world-performance.json'));
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(`Report: ${output}`);
} finally {
  await cleanup();
}
