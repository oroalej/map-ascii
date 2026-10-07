import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { git } from './git';
import { hash, startReview, updateState } from './pr-review-checkpoint';
import type { Json, ReviewState } from './pr-review-checkpoint';
import { fixture } from './pr-review-fixture';
import { deltaLineLimit, renderLedger, reviewScope } from './pr-review-scope';
import type { ReviewScope } from './pr-review-scope';
import { command } from './pr-review-state';

let setup: ReturnType<typeof fixture>;
beforeEach(() => {
  setup = fixture();
});
afterEach(() => {
  rmSync(setup.directory, { recursive: true, force: true });
});

const roundOne = (reviewedHead: string): Json => ({
  round: 1,
  reviewedHead,
  entries: [
    {
      id: 1,
      claudeSeverity: 'blocker',
      finalSeverity: 'should-fix',
      path: 'file.txt',
      line: 1,
      claim: 'wrong value',
      verdict: 'valid',
      outcome: 'fixed',
      commit: 'abc1234',
    },
    {
      id: 2,
      claudeSeverity: 'should-fix',
      finalSeverity: 'should-fix',
      path: 'file.txt',
      line: 4,
      claim: 'missing guard',
      verdict: 'valid',
      outcome: 'open',
      openReason: 'test would not pass',
    },
  ],
});

function change(files: Record<string, string>, message = 'fix'): string {
  for (const [name, content] of Object.entries(files))
    writeFileSync(join(setup.directory, name), content);
  git(setup.directory, 'add', '--', ...Object.keys(files));
  git(setup.directory, 'commit', '-qm', message);
  return git(setup.directory, 'rev-parse', 'HEAD');
}

/** Moves the checkpoint to round 2 at the checkout's HEAD, after a reviewed round 1. */
async function secondRound(reviewedHead: string): Promise<ReviewState> {
  const { state } = await startReview(setup.options);
  const head = git(setup.directory, 'rev-parse', 'HEAD');
  return updateState(state.run, (saved) => {
    saved.round = 2;
    saved.headSha = head;
    saved.remoteSha = head;
    saved.history = [roundOne(reviewedHead)];
    saved.rejected = '- file.txt:9 — claim judged invalid';
  });
}

describe('review scope', () => {
  it('reviews the whole PR when no earlier round recorded a reviewed commit', async () => {
    const { state } = await startReview(setup.options);
    const scope = (await command('scope', { run: state.run, round: 1 })).value as ReviewScope & {
      path: string;
      ledger: string | null;
    };
    expect(scope).toMatchObject({ mode: 'full', since: null, ledger: null, deltaHash: null });
    expect(JSON.parse(readFileSync(scope.path, 'utf8'))).not.toHaveProperty('path');
  });

  it('reviews only fix commits since the last reviewed commit, with a stable ledger', async () => {
    const reviewed = setup.options.remoteSha;
    change({ 'file.txt': 'after\n' });
    const state = await secondRound(reviewed);
    const scope = reviewScope(state.run, 2);
    expect(scope).toMatchObject({
      mode: 'delta',
      since: reviewed,
      files: ['file.txt'],
      changedLines: 2,
    });
    expect(readFileSync(scope.delta!, 'utf8')).toContain('+after');
    const ledger = readFileSync(scope.ledger!, 'utf8');
    expect(ledger).toContain('**r1.1** `file.txt:1` — wrong value (should-fix, valid, fixed');
    expect(ledger).toContain('**r1.2** `file.txt:4` — missing guard');
    expect(ledger).toContain('open: test would not pass');
    expect(ledger).toContain('## Rejected decisions');
    expect(scope.ledgerHash).toBe(hash(ledger));
    const first = readFileSync(scope.path, 'utf8');
    expect(readFileSync(reviewScope(state.run, 2).path, 'utf8')).toBe(first);
  });

  it('reviews only the fix commits after a clean main merge', async () => {
    const reviewed = setup.options.remoteSha;
    git(setup.directory, 'checkout', '-q', '-b', 'side');
    change({ 'other.txt': 'main\n' }, 'main change');
    git(setup.directory, 'checkout', '-q', 'codex/test');
    change({ 'file.txt': 'after\n' });
    git(setup.directory, 'merge', '-q', '--no-ff', '-m', 'merge main', 'side');
    const state = await secondRound(reviewed);
    const scope = reviewScope(state.run, 2);
    expect(scope).toMatchObject({
      mode: 'delta',
      reason: /clean main synchronization/,
      files: ['file.txt'],
      changedLines: 2,
    });
    const patch = readFileSync(scope.delta!, 'utf8');
    expect(patch).toContain('+after');
    expect(patch).not.toContain('other.txt');
  });

  it('falls back to a full review when a main merge combined both sides of a file', async () => {
    const reviewed = setup.options.remoteSha;
    git(setup.directory, 'checkout', '-q', '-b', 'side');
    change({ 'file.txt': 'top\nbefore\n' }, 'main change');
    git(setup.directory, 'checkout', '-q', 'codex/test');
    change({ 'file.txt': 'before\nafter\n' });
    git(setup.directory, 'merge', '-q', '--no-ff', '-m', 'merge main', 'side');
    const state = await secondRound(reviewed);
    expect(reviewScope(state.run, 2)).toMatchObject({
      mode: 'full',
      reason: /combined both sides' changes to file\.txt/,
    });
  });

  it('falls back to a full review when the reviewed commit is not an ancestor', async () => {
    git(setup.directory, 'checkout', '-q', '-b', 'side');
    const rewritten = change({ 'file.txt': 'rewritten\n' }, 'rewritten');
    git(setup.directory, 'checkout', '-q', 'codex/test');
    change({ 'file.txt': 'after\n' });
    const state = await secondRound(rewritten);
    expect(reviewScope(state.run, 2)).toMatchObject({ mode: 'full', reason: /not an ancestor/ });
  });

  it('falls back to a full review for large or structural changes', async () => {
    const reviewed = setup.options.remoteSha;
    change({ 'file.txt': 'x\n'.repeat(deltaLineLimit + 1) });
    let state = await secondRound(reviewed);
    expect(reviewScope(state.run, 2)).toMatchObject({ mode: 'full', reason: /delta limit/ });
    rmSync(join(setup.directory, '.plans'), { recursive: true, force: true });
    git(setup.directory, 'reset', '-q', '--hard', reviewed);
    change({ 'package.json': '{}\n' });
    state = await secondRound(reviewed);
    const scope = reviewScope(state.run, 2);
    expect(scope).toMatchObject({ mode: 'full', reason: /package\.json/ });
    expect(existsSync(join(state.run, 'round2', 'delta.patch'))).toBe(false);
  });

  it('omits the ledger when there is nothing to carry', () => {
    expect(renderLedger([], '')).toBeNull();
    expect(renderLedger([{ round: 1, entries: [] }], 'x — invalid')).toContain('None.');
  });
});
