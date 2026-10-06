import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  beginOperation,
  finishOperation,
  loadState,
  recover,
  startReview,
  updateState,
} from './pr-review-checkpoint';
import { artifact, fixture } from './pr-review-fixture';
import { git } from './git';

let setup: ReturnType<typeof fixture>;
beforeEach(() => {
  setup = fixture();
});
afterEach(() => {
  rmSync(setup.directory, { recursive: true, force: true });
});

it.each([false, true])(
  'adopts an interrupted main merge once (already pushed: %s)',
  async (pushed) => {
    // All branch changes and Git mutations below belong to this isolated fixture.
    const base = setup.options.remoteSha;
    git(setup.directory, 'checkout', '-qb', 'main');
    writeFileSync(join(setup.directory, 'main.txt'), 'main change\n');
    git(setup.directory, 'add', '--', 'main.txt');
    git(setup.directory, 'commit', '-qm', 'main change');
    const main = git(setup.directory, 'rev-parse', 'HEAD');
    git(setup.directory, 'update-ref', 'refs/remotes/origin/main', main);
    git(setup.directory, 'checkout', 'codex/test');
    writeFileSync(join(setup.directory, 'branch.txt'), 'branch change\n');
    git(setup.directory, 'add', '--', 'branch.txt');
    git(setup.directory, 'commit', '-qm', 'branch change');
    const parent = git(setup.directory, 'rev-parse', 'HEAD');
    setup.options.remoteSha = parent;
    const { state } = await startReview(setup.options);
    await beginOperation(state.run, 'main-sync', 'sync', ['main.txt'], { mergeHeads: [main] });
    git(setup.directory, 'merge', '--no-ff', '--no-commit', 'origin/main');
    await finishOperation(state.run, 'main-sync', 'commit', 'Commit owned merge', {
      mergeHeads: [main],
    });
    await updateState(state.run, (saved) => {
      saved.operations[0]!.data = { mergeHeads: [base] };
    });
    await expect(beginOperation(state.run, 'unowned-parents', 'commit')).rejects.toThrow(
      'owned synchronization',
    );
    await updateState(state.run, (saved) => {
      saved.operations[0]!.data = { mergeHeads: [main] };
    });
    const pending = await beginOperation(state.run, 'merge-commit', 'commit');
    const operation = pending.operations.find((op) => op.id === 'merge-commit')!;
    expect(operation.expectedParents).toEqual([parent, main]);
    git(setup.directory, 'commit', '-qm', 'sync main');
    const head = git(setup.directory, 'rev-parse', 'HEAD');
    const options = { ...setup.options, remoteSha: pushed ? head : parent };
    for (const evidence of [
      { expectedTree: git(setup.directory, 'rev-parse', `${parent}^{tree}`) },
      { expectedParents: [parent, base] },
      { expectedParents: undefined },
    ]) {
      const invalid = structuredClone(pending);
      Object.assign(
        invalid.operations.find((op) => op.id === 'merge-commit')!,
        evidence,
      );
      expect(recover(invalid, options, () => false).recoveredCommit).toBeNull();
    }
    const source = loadState(state.run);
    const continued = await startReview(options, source, () => false);
    expect(continued.recoveredCommit).toBe(head);
    expect(continued.state.phase).toBe(pushed ? 'review' : 'push');
    expect(continued.state.owned).toEqual({});
    expect(continued.state.operations.find((op) => op.id === 'merge-commit')).toMatchObject({
      commit: head,
    });
    expect(continued.state.operations.find((op) => op.id === 'merge-commit')?.after).not.toBeNull();
    expect(
      loadState(state.run).operations.find((op) => op.id === 'merge-commit')?.after,
    ).toBeNull();
    expect(readFileSync(join(setup.directory, 'main.txt'), 'utf8')).toBe('main change\n');
    let reviewed = continued;
    if (!pushed) {
      await beginOperation(continued.state.run, 'push-merge', 'push');
      reviewed = await startReview(
        { ...options, remoteSha: head },
        loadState(continued.state.run),
        () => false,
      );
    }
    expect(reviewed.state.round).toBe(2);
    await artifact(reviewed.state, 'review');
    const resumed = await startReview(
      { ...options, remoteSha: head },
      loadState(reviewed.state.run),
      () => false,
    );
    expect(resumed.state.round).toBe(2);
    expect(resumed.state.phase).toBe('validation');
    expect(resumed.recoveredCommit).toBeNull();
  },
);
