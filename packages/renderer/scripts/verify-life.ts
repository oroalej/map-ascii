/** Strict movement equivalence plus deterministic full-state replay, 24 seeded rows. */
import { deepStrictEqual } from 'node:assert';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotCurrent, snapshotRevision, currentSourceHash } from './snapshot';
import { withoutDecorations } from './decorations';
import type * as Scenarios from '../src/life/testing/scenarios';
import type * as Simulation from '../src/life/simulate';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const arg = (name: string, fallback: string) =>
  process.argv.find((v) => v.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const revision = arg('baseline', '');
if (!revision || !/^[\w./-]+$/.test(revision)) throw new Error('Provide --baseline=<revision>');
const scratch = resolve(root, arg('scratch', 'test-results'));
await mkdir(scratch, { recursive: true });
const temporary = await mkdtemp(join(scratch, 'life-invariants-'));
try {
  const sourceHash = await currentSourceHash(root);
  const old = await snapshotRevision(root, revision, join(temporary, 'baseline'));
  const next = await snapshotCurrent(root, join(temporary, 'current'));
  const baseline = (await import(old.path('life/simulate.ts'))) as typeof Simulation;
  const current = (await import(next.path('life/simulate.ts'))) as typeof Simulation;
  // Identical fixture inputs and complete introspection for both arms; only decoration key excluded.
  const { makeScenario, completeScenarioState } = (await import(
    next.path('life/testing/scenarios.ts')
  )) as typeof Scenarios;
  const rows = [];
  for (const kind of ['junction', 'crossroads', 'transit'] as const) {
    const fixtures = [
      ...([30, 60, 120] as const).flatMap((rate) =>
        [1, 42].map((seed) => ({ rate, seed, count: 1, seconds: 20 })),
      ),
      ...[4, 16].map((count) => ({ rate: 30, seed: 42, count, seconds: 10 })),
    ];
    for (const { rate, seed, count, seconds } of fixtures) {
      const a = makeScenario(kind, count, false, seed, baseline.LifeWorld),
        b = makeScenario(kind, count, false, seed, current.LifeWorld),
        replay = makeScenario(kind, count, false, seed, current.LifeWorld);
      for (let frame = 0; frame < rate * seconds; frame++) {
        a.step(frame, 1 / rate);
        b.step(frame, 1 / rate);
        replay.step(frame, 1 / rate);
        if (frame % rate === 0 || frame === rate * seconds - 1) {
          deepStrictEqual(
            withoutDecorations(completeScenarioState(b.world)),
            withoutDecorations(completeScenarioState(a.world)),
            `${kind}/${count}/${rate}/${seed}/${frame}: PRE`,
          );
          deepStrictEqual(
            completeScenarioState(b.world),
            completeScenarioState(replay.world),
            `${kind}/${count}/${rate}/${seed}/${frame}: replay`,
          );
        }
      }
      rows.push({ kind, rate, seed, count, seconds, pre: 'exact', replay: 'exact' });
      console.log(`${kind}/${count}/${rate}/${seed}: exact PRE and replay`);
    }
  }
  deepStrictEqual(await currentSourceHash(root), sourceHash, 'Source changed during verification');
  const output = resolve(root, arg('output', 'test-results/life-invariants.json'));
  await mkdir(dirname(output), { recursive: true });
  await writeFile(
    output,
    JSON.stringify({ baseline: revision, baselineHash: old.hash, sourceHash, rows }, null, 2),
  );
} finally {
  if (
    dirname(resolve(temporary)) !== scratch ||
    !basename(temporary).startsWith('life-invariants-')
  )
    process.exitCode = 1;
  else await rm(temporary, { recursive: true, force: true });
}
