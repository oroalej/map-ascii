import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { atomicJson, hash } from './pr-review-checkpoint';
import { fixture, reviewText, validationText } from './pr-review-fixture';
import { command } from './pr-review-state';

let setup: ReturnType<typeof fixture>;
beforeEach(() => {
  setup = fixture();
});
afterEach(() => {
  rmSync(setup.directory, { recursive: true, force: true });
});

function legacy(): string {
  const run = join(setup.directory, '.plans', 'active', 'pr12-review-fixes', 'run-old');
  mkdirSync(run, { recursive: true });
  atomicJson(join(run, 'invocation.json'), { pr: 12, branch: 'codex/test' });
  atomicJson(join(run, 'pr-round1.json'), {
    number: 12,
    headRefName: 'codex/test',
    headRefOid: setup.options.remoteSha,
  });
  return run;
}

it('imports a verified legacy review and validation while retaining the source', async () => {
  const run = legacy();
  for (const [name, body] of [
    ['claude-review.md', reviewText],
    ['validation.md', validationText],
  ]) {
    const folder = join(
      run,
      'round1',
      name === 'claude-review.md' ? 'attempt-1' : 'validation-attempt-1',
    );
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, name!), body!);
    atomicJson(join(folder, 'exit.json'), {
      exitCode: 0,
      started: '2026-10-06T00:00:00Z',
      ended: '2026-10-06T00:01:00Z',
    });
  }
  const result = await command('init', { ...setup.options, resume: run });
  expect(result.value).toMatchObject({ state: { phase: 'fixes', resumedFrom: run, round: 1 } });
});

it('reruns legacy phases with unverified completion and keeps unknown working edits as baseline', async () => {
  const run = legacy();
  const folder = join(run, 'round1');
  mkdirSync(folder);
  writeFileSync(join(folder, 'claude-review.md'), reviewText);
  writeFileSync(join(setup.directory, 'file.txt'), 'unknown legacy edits\n');
  const result = await command('init', setup.options);
  expect(result.value).toMatchObject({
    state: {
      phase: 'review',
      owned: {},
      baseline: { files: { 'file.txt': hash('unknown legacy edits\n') } },
    },
  });
});

it('rejects selecting legacy evidence from another PR', async () => {
  const run = legacy();
  await expect(command('init', { ...setup.options, pr: 13, resume: run })).rejects.toThrow(
    'No verifiable',
  );
});

it('continues a verified completed clean legacy round at CI rather than reviewing it again', async () => {
  const run = legacy();
  const review = join(run, 'round1', 'attempt-1'),
    validation = join(run, 'round1', 'validation-attempt-1');
  for (const [folder, name, body] of [
    [review, 'claude-review.md', reviewText],
    [validation, 'validation.md', validationText],
  ]) {
    mkdirSync(folder!, { recursive: true });
    writeFileSync(join(folder!, name!), body!);
    atomicJson(join(folder!, 'exit.json'), {
      exitCode: 0,
      started: '2026-10-06T00:00:00Z',
      ended: '2026-10-06T00:01:00Z',
    });
  }
  atomicJson(join(run, 'round1', 'result.json'), { round: 1, entries: [], commits: [] });
  const result = await command('init', { ...setup.options, resume: run });
  expect(result.value).toMatchObject({ state: { phase: 'ci', round: 1, history: [{ round: 1 }] } });
});
