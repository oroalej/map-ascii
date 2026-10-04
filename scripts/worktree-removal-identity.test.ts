import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { listWorktrees, removeWorktree } from './worktree-removal';
import { mainCheckout } from './git';
import { branch, git, worktreeRemovalFixture } from './worktree-removal-fixture';

const fixture = worktreeRemovalFixture();
const { branches, markerPath, mergedOptions, trackedFile } = fixture;
let repo: string, wt: string;
beforeEach(() => {
  ({ repo, wt } = fixture);
});

describe('worktree identity and refs', () => {
  it('refuses a recreated merged branch whose head differs from the PR head', () => {
    const options = mergedOptions();
    const expectedHead = git(wt, 'rev-parse', 'HEAD').trim();
    removeWorktree({ ...options, expectedHead });
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'main advances');
    git(repo, 'worktree', 'add', '-q', wt, '-b', branch, '--no-track', 'main');
    const head = git(wt, 'rev-parse', 'HEAD').trim();
    for (const dryRun of [true, false]) {
      expect(() => removeWorktree({ ...options, expectedHead, dryRun })).toThrow(
        /head differs from expected/,
      );
      expect(existsSync(join(wt, '.git'))).toBe(true);
      expect(existsSync(markerPath())).toBe(false);
      expect(git(repo, 'rev-parse', `refs/heads/${branch}`).trim()).toBe(head);
    }
  });

  it('removes an abbreviated PR head and recognizes completed pinned reruns', () => {
    const options = {
      ...mergedOptions(),
      expectedHead: git(wt, 'rev-parse', '--short', 'HEAD').trim(),
    };
    expect(removeWorktree({ ...options, dryRun: true }).deletedBranch).toBe(true);
    expect(removeWorktree(options).deletedBranch).toBe(true);
    for (const dryRun of [true, false]) {
      expect(removeWorktree({ ...options, dryRun }).alreadyRemoved).toBe(true);
    }
  });

  it('refuses an invalid pinned commit before making changes', () => {
    const options = { ...mergedOptions(), expectedHead: 'not-a-commit' };
    for (const dryRun of [true, false]) {
      expect(() => removeWorktree({ ...options, dryRun })).toThrow();
      expect(existsSync(join(wt, '.git'))).toBe(true);
      expect(existsSync(markerPath())).toBe(false);
      expect(branches()).toContain(branch);
    }
  });

  it('refuses main independently of the primary checkout branch', () => {
    git(repo, 'update-ref', 'refs/heads/codex/primary', 'main');
    git(repo, 'symbolic-ref', 'HEAD', 'refs/heads/codex/primary');
    for (const dryRun of [true, false]) {
      expect(() =>
        removeWorktree({ repo, branch: 'main', mergedInto: 'main', cwd: repo, dryRun }),
      ).toThrow(/Refusing to remove main/);
    }
    expect(branches()).toContain('main');
  });

  it('refuses case aliases for main and dirty task branches without changing refs', () => {
    const options = mergedOptions();
    writeFileSync(join(wt, 'scratch.txt'), 'new work');
    for (const name of ['MAIN', 'codex/Topic']) {
      for (const dryRun of [true, false]) {
        expect(() => removeWorktree({ ...options, branch: name, dryRun })).toThrow(
          /exact branch spelling/,
        );
      }
    }
    expect(branches()).toEqual([branch, 'main']);
    expect(readFileSync(join(wt, 'scratch.txt'), 'utf8')).toBe('new work');
  });

  it('refuses mismatched worktree HEAD spelling including the primary checkout', () => {
    const options = mergedOptions();
    writeFileSync(join(wt, 'scratch.txt'), 'new work');
    git(wt, 'symbolic-ref', 'HEAD', 'refs/heads/codex/Topic');
    for (const dryRun of [true, false]) {
      expect(() => removeWorktree({ ...options, dryRun })).toThrow(/branch spelling differs/);
    }
    git(wt, 'symbolic-ref', 'HEAD', `refs/heads/${branch}`);
    git(repo, 'symbolic-ref', 'HEAD', 'refs/heads/codex/Topic');
    for (const dryRun of [true, false]) {
      expect(() => removeWorktree({ ...options, dryRun })).toThrow(/branch spelling differs/);
    }
    expect(branches()).toContain(branch);
    expect(readFileSync(join(wt, 'scratch.txt'), 'utf8')).toBe('new work');
  });

  it('checks the captured branch commit despite a same-name tag', () => {
    git(repo, 'tag', branch, 'main');
    expect(() => removeWorktree({ repo, branch, mergedInto: 'main', cwd: repo })).toThrow(
      `${branch} is not merged into main; nothing was removed`,
    );
    expect(existsSync(wt)).toBe(true);
    expect(git(repo, 'rev-parse', `refs/heads/${branch}`).trim()).toBe(
      git(wt, 'rev-parse', 'HEAD').trim(),
    );
  });

  it('discovers the same main checkout from main and a linked worktree', () => {
    expect(mainCheckout(repo)).toBe(repo);
    expect(mainCheckout(wt)).toBe(repo);
    expect(listWorktrees(repo)).toEqual(listWorktrees(wt));
  });

  it('refuses a branch in the main checkout and an unknown branch', () => {
    git(repo, 'symbolic-ref', 'HEAD', 'refs/heads/codex/primary');
    git(repo, 'update-ref', 'refs/heads/codex/primary', 'main');
    expect(() =>
      removeWorktree({ repo, branch: 'codex/primary', mergedInto: 'main', cwd: repo }),
    ).toThrow(/main checkout/);
    for (const dryRun of [true, false]) {
      expect(() =>
        removeWorktree({ repo, branch: 'codex/absent', mergedInto: 'main', cwd: repo, dryRun }),
      ).toThrow(/no local branch or worktree named codex\/absent/);
    }
    expect(existsSync(wt)).toBe(true);
    expect(branches()).toContain(branch);
  });

  it('recognizes completed removal from the exact retained remote ref', () => {
    const options = mergedOptions();
    removeWorktree(options);
    for (const dryRun of [true, false]) {
      expect(removeWorktree({ ...options, dryRun }).alreadyRemoved).toBe(true);
      expect(() => removeWorktree({ ...options, branch: 'codex/toipc', dryRun })).toThrow(
        /no local branch or worktree named/,
      );
    }
  });

  it('clears upstream configuration only after successful conditional branch deletion', () => {
    const options = mergedOptions();
    git(repo, 'branch', '--set-upstream-to', `origin/${branch}`, branch);
    removeWorktree(options);
    git(repo, 'worktree', 'add', '-q', wt, '-b', branch, '--no-track', 'main');
    expect(() => git(repo, 'config', '--get', `branch.${branch}.remote`)).toThrow();
    expect(() => git(repo, 'config', '--get', `branch.${branch}.merge`)).toThrow();
  });

  it('refuses a detached branch during a real conflicting rebase', () => {
    trackedFile();
    const options = mergedOptions();
    writeFileSync(join(repo, 'tracked.txt'), 'conflicting main');
    git(repo, 'add', 'tracked.txt');
    git(repo, 'commit', '-q', '-m', 'main change');
    expect(() => git(wt, 'rebase', '--onto', 'main', 'HEAD~1')).toThrow();
    expect(listWorktrees(repo).find((entry) => entry.path === wt)?.branch).toBe(null);
    const head = git(repo, 'rev-parse', `refs/heads/${branch}`).trim();
    for (const dryRun of [true, false]) {
      expect(() => removeWorktree({ ...options, dryRun })).toThrow(/active rebase or bisect/);
    }
    expect(git(repo, 'rev-parse', `refs/heads/${branch}`).trim()).toBe(head);
    expect(git(wt, 'status', '--porcelain')).toContain('AA tracked.txt');
  });

  it('refuses a detached branch during a real bisect and rebase-apply recovery', () => {
    git(wt, 'commit', '-q', '--allow-empty', '-m', 'third commit');
    const options = mergedOptions();
    const head = git(repo, 'rev-parse', `refs/heads/${branch}`).trim();
    git(wt, 'bisect', 'start', 'HEAD', 'HEAD~2');
    expect(listWorktrees(repo).find((entry) => entry.path === wt)?.branch).toBe(null);
    const metadata = git(wt, 'rev-parse', '--absolute-git-dir').trim();
    for (const dryRun of [true, false]) {
      expect(() => removeWorktree({ ...options, dryRun })).toThrow(/active rebase or bisect/);
    }
    git(wt, 'bisect', 'reset');
    git(wt, 'checkout', '--detach', '-q');
    mkdirSync(join(metadata, 'rebase-apply'));
    writeFileSync(join(metadata, 'rebase-apply/head-name'), `refs/heads/${branch}\n`);
    for (const dryRun of [true, false]) {
      expect(() => removeWorktree({ ...options, dryRun })).toThrow(/active rebase or bisect/);
    }
    expect(git(repo, 'rev-parse', `refs/heads/${branch}`).trim()).toBe(head);
    expect(existsSync(wt)).toBe(true);
  });

  it('refuses main, an unmerged or dirty branch, and a cwd inside the worktree', () => {
    const remove = (name: string, cwd = repo) =>
      removeWorktree({ repo, branch: name, mergedInto: 'main', cwd });
    expect(() => remove('main')).toThrow(/Refusing to remove main/);
    expect(() => remove(branch)).toThrow(`${branch} is not merged into main; nothing was removed`);
    git(repo, 'merge', '-q', '--ff-only', branch);
    writeFileSync(join(wt, 'scratch.txt'), 'x');
    expect(() => remove(branch)).toThrow(/uncommitted changes/);
    rmSync(join(wt, 'scratch.txt'));
    expect(() => remove(branch, join(wt, 'sub'))).toThrow(/current directory/);
    expect(existsSync(wt)).toBe(true);
    expect(branches()).toContain(branch);
  });
});
