import { readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  beginOperation,
  finishOperation,
  loadState,
  protectChanges,
  recover,
  restoreOwned,
  startReview,
  updateState,
} from './pr-review-checkpoint';
import { fixture } from './pr-review-fixture';
import { git } from './git';

let setup: ReturnType<typeof fixture>;
beforeEach(() => {
  setup = fixture();
});
afterEach(() => {
  rmSync(setup.directory, { recursive: true, force: true });
});

it('retains a null original base across several edits to a new owned file', async () => {
  const { state } = await startReview(setup.options);
  const name = 'new.txt',
    file = join(setup.directory, name);
  await beginOperation(state.run, 'new-1', 'fixes', [name]);
  writeFileSync(file, 'first');
  await finishOperation(state.run, 'new-1', 'fixes', 'Continue');
  await beginOperation(state.run, 'new-2', 'fixes', [name]);
  writeFileSync(file, 'second');
  const saved = await finishOperation(state.run, 'new-2', 'verify', 'Verify');
  expect(saved.owned[name]?.baseHash).toBeNull();
  unlinkSync(file);
  restoreOwned(saved, setup.directory);
  expect(readFileSync(file, 'utf8')).toBe('second');
});

it('records binary bases without UTF-8 conversion and restores saved deletions only on matching bytes', async () => {
  const file = join(setup.directory, 'file.txt');
  writeFileSync(file, Buffer.from([0, 255, 254, 128]));
  git(setup.directory, 'add', '--', 'file.txt');
  git(setup.directory, 'commit', '-qm', 'binary fixture');
  setup.options.remoteSha = git(setup.directory, 'rev-parse', 'HEAD');
  const { state } = await startReview(setup.options);
  await beginOperation(state.run, 'delete', 'fixes', ['file.txt']);
  unlinkSync(file);
  const saved = await finishOperation(state.run, 'delete', 'verify', 'Verify deletion');
  writeFileSync(file, Buffer.from([0, 255, 254, 128]));
  expect(restoreOwned(saved, setup.directory)).toEqual(['file.txt']);
});

it('refuses committing unrelated staged changes', async () => {
  const { state } = await startReview(setup.options);
  writeFileSync(join(setup.directory, 'file.txt'), 'unowned');
  git(setup.directory, 'add', '--', 'file.txt');
  await expect(beginOperation(state.run, 'bad-commit', 'commit')).rejects.toThrow('unowned');
  expect(loadState(state.run).operations).toEqual([]);
});

it('rechecks saved clean CI and reviews source fixes whose review is still pending', async () => {
  const { state } = await startReview(setup.options);
  await updateState(state.run, (saved) => {
    saved.phase = 'complete';
    saved.status = 'clean';
    saved.ci.status = 'green';
  });
  expect(recover(loadState(state.run), setup.options, () => false).phase).toBe('ci');
  await updateState(state.run, (saved) => {
    saved.phase = 'ci';
    saved.ci.needsReview = true;
  });
  expect(recover(loadState(state.run), setup.options, () => false)).toMatchObject({
    phase: 'review',
    round: 2,
  });
});

it('accepts clean text with Git line-ending conversion while saving exact working bytes', async () => {
  writeFileSync(join(setup.directory, '.gitattributes'), 'file.txt text eol=crlf\n');
  git(setup.directory, 'add', '--', '.gitattributes', 'file.txt');
  git(setup.directory, 'commit', '-qm', 'line ending fixture');
  unlinkSync(join(setup.directory, 'file.txt'));
  git(setup.directory, 'checkout', '--', 'file.txt'); // Isolated fixture, no user edits.
  setup.options.remoteSha = git(setup.directory, 'rev-parse', 'HEAD');
  expect(readFileSync(join(setup.directory, 'file.txt'), 'utf8')).toBe('before\r\n');
  expect(git(setup.directory, 'status', '--porcelain')).toBe('');
  const { state } = await startReview(setup.options);
  await expect(beginOperation(state.run, 'crlf', 'fixes', ['file.txt'])).resolves.toMatchObject({
    phase: 'fixes',
  });
});

it('protects foreign edits without claiming matching owned bytes', async () => {
  const { state } = await startReview(setup.options);
  await beginOperation(state.run, 'owned', 'fixes', ['file.txt']);
  writeFileSync(join(setup.directory, 'file.txt'), 'owned');
  await finishOperation(state.run, 'owned', 'verify', 'Verify');
  writeFileSync(join(setup.directory, 'notes.txt'), 'foreign');
  const protectedState = await protectChanges(state.run);
  expect(Object.keys(protectedState.baseline.files)).toEqual(['notes.txt']);
  expect(Object.keys(protectedState.owned)).toEqual(['file.txt']);
  await expect(beginOperation(state.run, 'foreign', 'fixes', ['notes.txt'])).rejects.toThrow(
    'Unfamiliar baseline',
  );
});
