/** Isolated, interleaved rollback/control/per-item CPU comparisons. Not browser FPS. */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import { LifeWorld, type VisibleAgent } from '../src/life/simulate';
import { makeScenario, type Scenario } from '../src/life/testing/scenarios';
import { packLife, buildLifeGlyphs } from '../src/life/draw';
import { themes } from '../src/theme';
import { snapshotRevision, snapshotWorkingTree, currentSourceHash } from './snapshot';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const arg = (name: string, fallback: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const scratchArg = arg('scratch', '');
if (!scratchArg) throw new Error('Pass --scratch=<task folder> to keep benchmark artifacts scoped');
const scratch = resolve(scratchArg);
const runs = Number(arg('runs', '5')),
  samples = Number(arg('samples', '300'));
if (![runs, samples].every((n) => Number.isInteger(n) && n > 0))
  throw new Error('Invalid sample count');
await mkdir(scratch, { recursive: true });
const hash = await currentSourceHash(root);
const baseline = arg('baseline', 'a427b229e1af9ced1464135120e73a73d6e667b5');
console.log(`Benchmark PID: ${process.pid}`);
const frozen = await snapshotRevision(
  root,
  baseline,
  await mkdtemp(resolve(scratch, 'inspection-baseline-')),
);
const old = (await import(frozen.path('life/simulate.ts'))) as { LifeWorld: typeof LifeWorld };
const oldDraw = (await import(frozen.path('life/draw.ts'))) as { packLife: typeof packLife };
// Fallback and item never share an atlas. Isolate their complete runtime graphs,
// including scene/movement helpers; querying only simulate/draw still shares the
// helpers' type feedback and measures benchmark-only polymorphism. Item and held
// keep sharing functions and a heap, as they do when inspection changes at runtime.
const current = await snapshotWorkingTree(
  root,
  await mkdtemp(resolve(scratch, 'inspection-current-')),
);
const isolated = (file: string) => current.path('life/' + file);
const fallback = (await import(isolated('simulate.ts'))) as { LifeWorld: typeof LifeWorld };
const fallbackDraw = (await import(isolated('draw.ts'))) as { packLife: typeof packLife };
if (fallback.LifeWorld === LifeWorld || fallbackDraw.packLife === packLife)
  throw new Error('Benchmark modes must have independent hot functions');
class ItemWorld extends LifeWorld {
  constructor(...args: ConstructorParameters<typeof LifeWorld>) {
    super(args[0], args[1], args[2], true);
  }
}
const quantile = (values: number[], q: number) =>
  [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * q))]!;
const summary = (values: number[]) => ({
  median: quantile(values, 0.5),
  p95: quantile(values, 0.95),
});
const glyph = (s: string) => ((s.codePointAt(0) ?? 0) % 254) + 1;
const glyphs = buildLifeGlyphs(glyph);

// Each runtime graph gets the same preconditioning call count. Without this,
// baseline/control and item/held warm their shared methods twice as quickly as
// fallback in the first case. Discard these worlds; measured scenarios still
// start from identical seeds and retain their 90-frame simulation warmup.
for (const [Constructor, pack] of [
  [old.LifeWorld, oldDraw.packLife],
  [fallback.LifeWorld, fallbackDraw.packLife],
  [ItemWorld, packLife],
] as const) {
  const s = makeScenario('transit', 4, false, 1, Constructor);
  const pixels = new Uint8Array(s.grid.cols * s.grid.rows * 4);
  const owners = new Uint32Array(s.grid.cols * s.grid.rows);
  const packedGrid = { ...s.grid, owners };
  let previous: VisibleAgent[] = [],
    target: number | null = null;
  for (let frame = 0; frame < 2000; frame++) {
    const env = s.environment(frame);
    const rain = frame % 120 < 60 ? env.rain : 0.9;
    if (s.world.inspection) {
      if (frame === 700 || frame === 1400)
        target = previous.find((a) => a.kind === 'person' && !a.parked)?.inspectionId ?? null;
      if (frame === 1000 || frame === 1700) target = null;
      s.world.inspection.select(
        { id: target, revision: frame, time: frame / 30 },
        s.world.signalClock,
      );
    }
    s.world.step(1 / 30, undefined, 18, s.bounds, undefined, { ...env, rain }, 0.9);
    previous = s.world.visible(18, s.levels, s.center, { rain, sunAltitude: 40 }, s.bounds);
    pack(pixels, packedGrid, previous, themes.dark, glyph, undefined, glyphs, { owners });
  }
}
console.log('Runtime graphs preconditioned: 2000 calls each');
type Mode = 'baseline' | 'control' | 'all' | 'item' | 'held';
const rows = [];
for (const kind of ['crossroads', 'transit', 'rain'] as Scenario[])
  for (const count of [1, 4, 16])
    for (const mobile of [false, true]) {
      const name = `${kind}/${count}/${mobile ? 'phone' : 'desktop'}`;
      if (
        !arg('case', '')
          .split(',')
          .some((prefix) => name.startsWith(prefix))
      )
        continue;
      const captures: Record<Mode, { ms: number[]; agents: number; movement: number }[]> = {
        baseline: [],
        control: [],
        all: [],
        item: [],
        held: [],
      };
      for (let round = 0; round < runs; round++) {
        const order: Mode[] =
          round % 2
            ? ['held', 'item', 'all', 'control', 'baseline']
            : ['baseline', 'control', 'all', 'item', 'held'];
        const runners = order.map((mode) => {
          const Constructor =
            mode === 'baseline' || mode === 'control'
              ? old.LifeWorld
              : mode === 'all'
                ? fallback.LifeWorld
                : ItemWorld;
          const pack =
            mode === 'baseline' || mode === 'control'
              ? oldDraw.packLife
              : mode === 'all'
                ? fallbackDraw.packLife
                : packLife;
          const s = makeScenario(kind, count, mobile, 1, Constructor);
          const pixels = new Uint8Array(s.grid.cols * s.grid.rows * 4),
            owners = new Uint32Array(s.grid.cols * s.grid.rows);
          const packedGrid = { ...s.grid, owners };
          const ms: number[] = [];
          let target: number | null = null,
            agentCount = 0,
            movement = 0;
          const first = new Map<number, [number, number]>();
          const step = (frame: number) => {
            const env = s.environment(frame);
            const start = performance.now();
            if (s.world.inspection)
              s.world.inspection.select(
                { id: target, revision: frame, time: frame / 30 },
                s.world.signalClock,
              );
            s.world.step(1 / 30, undefined, 18, s.bounds, undefined, env, 0.9);
            const visible = s.world.visible(
              18,
              s.levels,
              s.center,
              { rain: env.rain, sunAltitude: 40 },
              s.bounds,
            );
            const drawn = pack(pixels, packedGrid, visible, themes.dark, glyph, undefined, glyphs, {
              owners,
            });
            const elapsed = performance.now() - start;
            if (frame === 89) {
              if (mode === 'held')
                target =
                  (
                    visible.find((a) => a.kind === 'person' && !a.parked) ??
                    visible.find((a) => a.kind === 'vehicle' && !a.parked)
                  )?.inspectionId ?? null;
              if (mode === 'held' && target === null)
                throw new Error(`${name} has no inspection subject`);
              for (const a of visible)
                if (a.inspectionId !== undefined) first.set(a.inspectionId, [a.lng, a.lat]);
            }
            if (frame >= 90) {
              if (mode === 'held' && s.world.inspection!.ack.id !== target)
                throw new Error(`${name}: inspection subject was lost`);
              ms.push(elapsed);
              agentCount += drawn;
            }
            if (frame === 89 + samples)
              movement = visible.filter(
                (a) =>
                  a.inspectionId !== target &&
                  first.has(a.inspectionId!) &&
                  (a.lng !== first.get(a.inspectionId!)![0] ||
                    a.lat !== first.get(a.inspectionId!)![1]),
              ).length;
          };
          return {
            step,
            finish() {
              if (mode === 'held' && movement === 0)
                throw new Error(`${name}: other actors did not move`);
              captures[mode].push({ ms, agents: agentCount / samples, movement });
            },
          };
        });
        // Balance every mode across all positions as well as both directions.
        for (let frame = 0; frame < 90 + samples; frame++) {
          const scheduled = frame % 2 ? [...runners].reverse() : runners;
          const offset = (Math.floor(frame / 2) + round) % runners.length;
          for (let i = 0; i < runners.length; i++)
            scheduled[(i + offset) % runners.length]!.step(frame);
        }
        runners.forEach((runner) => runner.finish());
      }
      const stats = Object.fromEntries(
        Object.entries(captures).map(([mode, rounds]) => [
          mode,
          {
            median: quantile(
              rounds.map((r) => summary(r.ms).median),
              0.5,
            ),
            p95: quantile(
              rounds.map((r) => summary(r.ms).p95),
              0.5,
            ),
          },
        ]),
      ) as Record<Mode, ReturnType<typeof summary>>;
      const growth = (candidate: Mode, base: Mode) => {
        // Compare matched rounds before aggregation. Ratios of independently
        // aggregated medians can accidentally compare two different load periods.
        const paired = captures[candidate].map((capture, round) => {
          const a = summary(capture.ms),
            b = summary(captures[base][round]!.ms);
          return { median: a.median / b.median - 1, p95: a.p95 / b.p95 - 1 };
        });
        return {
          median: quantile(
            paired.map((p) => p.median),
            0.5,
          ),
          p95: quantile(
            paired.map((p) => p.p95),
            0.5,
          ),
        };
      };
      const control = growth('control', 'baseline'),
        normal = growth('item', 'baseline'),
        hover = growth('held', 'item'),
        rollback = growth('all', 'baseline');
      const stable = Math.abs(control.median) <= 0.05 && Math.abs(control.p95) <= 0.05;
      const pass =
        stable && [normal, hover, rollback].every((g) => g.median <= 0.05 && g.p95 <= 0.05);
      rows.push({ name, stats, control, normal, hover, rollback, stable, pass, captures });
      console.log(
        `${name}: ${pass ? 'PASS' : stable ? 'REGRESSION' : 'UNSTABLE'} normal ${JSON.stringify(normal)} hover ${JSON.stringify(hover)} rollback ${JSON.stringify(rollback)} control ${JSON.stringify(control)}`,
      );
    }
if (!rows.length) throw new Error('No benchmark cases matched the filter');
if (hash !== (await currentSourceHash(root)))
  throw new Error('Runtime source changed during capture');
const output = resolve(scratch, `inspection-cpu-${arg('label', 'comparison')}.json`);
await writeFile(
  output,
  JSON.stringify(
    {
      baseline,
      baselineHash: frozen.hash,
      hash,
      node: process.version,
      cpu: cpus()[0]?.model,
      runs,
      samples,
      warmup: 90,
      preconditioning: { framesPerGraph: 2000, scenario: 'transit/4/desktop' },
      method: 'full fallback graph isolation; matched-round ratios; rotating reversed frame order',
      rows,
    },
    null,
    2,
  ),
);
console.log(`Report: ${output}`);
if (rows.some((row) => !row.pass)) process.exitCode = 1;
