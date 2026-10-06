import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  beginOperation,
  capture,
  finishOperation,
  loadState,
  parseState,
  recover,
  restoreOwned,
  selectState,
  sourcePath,
  startReview,
  updateState,
} from './pr-review-checkpoint';
import { artifact, commit, fixture } from './pr-review-fixture';
import { git } from './git';

let setup: ReturnType<typeof fixture>;
beforeEach(() => {
  setup = fixture();
});
afterEach(() => {
  rmSync(setup.directory, { recursive: true, force: true });
});

describe('review checkpoints', () => {
  it('selects the newest valid checkpoint and leaves prior invocations unchanged', async () => {
    const first = await startReview(setup.options);
    await updateState(first.state.run, (state) => {
      state.phase = 'review';
      state.rejected = 'old decision';
      state.history = [{ round: 1, entries: [], commits: [] }];
    });
    const oldFiles = readdirSync(join(first.state.run, 'checkpoints'));
    const second = await startReview(setup.options);
    expect(second.state.resumedFrom).toBe(first.state.run);
    expect(second.state.history).toEqual([{ round: 1, entries: [], commits: [] }]);
    expect(second.state.rejected).toBe('old decision');
    expect(readdirSync(join(first.state.run, 'checkpoints'))).toEqual(oldFiles);
    expect(selectState(setup.options)?.run).toBe(second.state.run);
  });

  it('ignores incomplete writes and falls back conservatively from corrupt snapshots', async () => {
    const { state } = await startReview(setup.options);
    writeFileSync(join(state.run, 'checkpoints', '99999998-deadbeef.json'), '{');
    writeFileSync(
      join(state.run, 'checkpoints', '99999999-deadbeef.json.tmp'),
      '{"phase":"complete"}',
    );
    expect(loadState(state.run).phase).toBe('sync');
    expect(() => parseState({ ...state, version: 99 })).toThrow('Invalid review checkpoint');
    await expect(
      updateState(state.run, (saved) => {
        saved.round = -1;
      }),
    ).rejects.toThrow('Invalid review checkpoint');
    expect(loadState(state.run).round).toBe(1);
  });

  it('supports fresh runs and refuses contradictory flags or mismatched PRs', async () => {
    const { state } = await startReview(setup.options);
    expect(selectState({ ...setup.options, fresh: true })).toBeNull();
    expect(() => selectState({ ...setup.options, resume: state.run, fresh: true })).toThrow(
      'cannot be combined',
    );
    expect(() => selectState({ ...setup.options, resume: state.run, pr: 13 })).toThrow(
      'does not match',
    );
    expect(() => sourcePath(setup.directory, '../escape')).toThrow('Invalid source path');
  });

  it('resumes completed review at validation and completed validation at fixes', async () => {
    const { state } = await startReview(setup.options);
    await updateState(state.run, (saved) => {
      saved.phase = 'review';
    });
    await artifact(state, 'review');
    const second = await startReview(setup.options);
    expect(second.state.phase).toBe('validation');
    await artifact(second.state, 'validation');
    const third = await startReview(setup.options);
    expect(third.state.phase).toBe('fixes');
    expect(third.state.round).toBe(1);
  });

  it('does not consume changed report bytes, failed processes or another PR receipts', async () => {
    const { state } = await startReview(setup.options);
    await updateState(state.run, (saved) => {
      saved.phase = 'review';
    });
    const review = await artifact(state, 'review');
    writeFileSync(review.receipt.report, 'partial overwrite');
    const validation = await artifact(state, 'validation', { exitCode: 1 });
    expect(recover(loadState(state.run), setup.options, () => false).reusable).toEqual([]);
    expect(validation.receipt.valid).toBe(true); // A marker alone never overrides native failure.
    await artifact(state, 'review', { pr: 99 });
    expect(recover(loadState(state.run), setup.options, () => false).reusable).toEqual([]);
  });

  it('observes a surviving child instead of creating another invocation', async () => {
    const { state } = await startReview(setup.options);
    await artifact(state, 'review', { status: 'running', finishedAt: null, valid: false });
    await expect(startReview(setup.options, loadState(state.run), () => true)).rejects.toThrow(
      'still active',
    );
    const recovered = await startReview(setup.options, loadState(state.run), () => false);
    expect(recovered.reusable).toEqual([]);
  });

  it('invalidates reports and CI when main moves or an external commit changes the head', async () => {
    const { state } = await startReview(setup.options);
    await artifact(state, 'review');
    await updateState(state.run, (saved) => {
      saved.phase = 'complete';
      saved.status = 'clean';
      saved.ci.status = 'green';
      saved.ci.headSha = state.headSha;
    });
    writeFileSync(join(setup.directory, 'file.txt'), 'new commit\n');
    const head = commit(setup.directory);
    git(setup.directory, 'update-ref', 'refs/remotes/origin/main', head);
    const changed = recover(
      loadState(state.run),
      { ...setup.options, remoteSha: head },
      () => false,
    );
    expect(changed.phase).toBe('review');
    expect(changed.reusable).toEqual([]);
    git(setup.directory, 'checkout', '--detach', setup.options.remoteSha); // Isolated fixture, never a user checkout.
    expect(recover(loadState(state.run), setup.options, () => false).phase).toBe('sync');
  });

  it('saves owned bytes and refuses edits whose ownership or restore base is unknown', async () => {
    const { state } = await startReview(setup.options);
    await beginOperation(state.run, 'fix-1', 'fixes', ['file.txt']);
    writeFileSync(join(setup.directory, 'file.txt'), 'owned\n');
    const fixed = await finishOperation(state.run, 'fix-1', 'verify', 'Run checks');
    expect(capture(setup.directory, ['file.txt']).treeHash).toBe(fixed.current.treeHash);
    writeFileSync(join(setup.directory, 'file.txt'), 'unfamiliar\n');
    await expect(beginOperation(state.run, 'fix-2', 'fixes', ['file.txt'])).rejects.toThrow(
      'outside the checkpoint',
    );
    expect(() => restoreOwned(fixed, setup.directory)).toThrow('Restore base differs');
    expect(readFileSync(join(setup.directory, 'file.txt'), 'utf8')).toBe('unfamiliar\n');
    writeFileSync(join(setup.directory, 'file.txt'), 'before\n');
    expect(restoreOwned(fixed, setup.directory)).toEqual(['file.txt']);
    expect(readFileSync(join(setup.directory, 'file.txt'), 'utf8')).toBe('owned\n');
  });

  it('keeps baseline edits and partial uncheckpointed fixes out of owned changes', async () => {
    writeFileSync(join(setup.directory, 'file.txt'), 'another session\n');
    const { state } = await startReview(setup.options);
    await expect(beginOperation(state.run, 'unsafe', 'fixes', ['file.txt'])).rejects.toThrow(
      'Unfamiliar baseline edit',
    );
    expect(state.owned).toEqual({});
  });

  it('recognizes a commit made before the completion checkpoint and a push already on the remote', async () => {
    const { state } = await startReview(setup.options);
    await beginOperation(state.run, 'fix', 'fixes', ['file.txt']);
    writeFileSync(join(setup.directory, 'file.txt'), 'fixed\n');
    await finishOperation(state.run, 'fix', 'commit', 'Commit fix');
    git(setup.directory, 'add', '--', 'file.txt');
    await beginOperation(state.run, 'commit', 'commit');
    const head = commit(setup.directory);
    const second = await startReview(setup.options);
    expect(second.recoveredCommit).toBe(head);
    expect(second.state.phase).toBe('push');
    expect(git(setup.directory, 'rev-list', '--count', 'HEAD')).toBe('2');
    await beginOperation(second.state.run, 'push', 'push');
    const third = await startReview({ ...setup.options, remoteSha: head });
    expect(third.pushCompleted).toBe(true);
    expect(third.state.phase).toBe('review');
    expect(third.state.round).toBe(2);
  });
});
