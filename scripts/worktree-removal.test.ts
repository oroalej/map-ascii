import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listWorktrees, removeWorktree } from './worktree-removal';

let root: string, repo: string, wt: string;
const branch = 'codex/topic';
const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
const branches = () => git(repo, 'branch', '--format=%(refname:short)').trim().split('\n');

/** A repo on main with one commit, and a worktree on `branch` holding one more commit. */
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'worktree-removal-'));
  repo = join(root, 'repo');
  wt = join(root, 'repo-topic');
  git(root, 'init', '-q', repo);
  git(repo, 'symbolic-ref', 'HEAD', 'refs/heads/main'); // init -b needs git 2.28
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'base');
  git(repo, 'worktree', 'add', '-q', wt, '-b', branch);
  git(wt, 'commit', '-q', '--allow-empty', '-m', 'work');
});
afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));

describe('removeWorktree', () => {
  it('removes a merged clean worktree and its local branch', () => {
    git(repo, 'merge', '-q', '--ff-only', branch);
    const result = removeWorktree({ repo, branch, mergedInto: 'main', cwd: repo });
    expect(result).toMatchObject({ removedWorktree: true, deletedBranch: true });
    expect(existsSync(wt)).toBe(false);
    expect(listWorktrees(repo)).toHaveLength(1);
    expect(branches()).toEqual(['main']);
  });

  it('refuses main, an unmerged or dirty branch, and a cwd inside the worktree', () => {
    const remove = (name: string, cwd = repo) =>
      removeWorktree({ repo, branch: name, mergedInto: 'main', cwd });
    expect(() => remove('main')).toThrow(/main/);
    expect(() => remove(branch)).toThrow(/not merged/);
    git(repo, 'merge', '-q', '--ff-only', branch);
    writeFileSync(join(wt, 'scratch.txt'), 'x');
    expect(() => remove(branch)).toThrow(/uncommitted changes/);
    rmSync(join(wt, 'scratch.txt'));
    expect(() => remove(branch, join(wt, 'sub'))).toThrow(/current directory/);
    expect(existsSync(wt)).toBe(true);
    expect(branches()).toContain(branch);
  });

  it('changes nothing on a dry run', () => {
    git(repo, 'merge', '-q', '--ff-only', branch);
    const result = removeWorktree({ repo, branch, mergedInto: 'main', cwd: repo, dryRun: true });
    expect(result).toMatchObject({ removedWorktree: true, deletedBranch: true, resumed: false });
    expect(existsSync(wt)).toBe(true);
    expect(branches()).toContain(branch);
  });

  it('finishes a removal that a busy file interrupted partway', () => {
    writeFileSync(join(wt, 'tracked.txt'), 'x');
    git(wt, 'add', 'tracked.txt');
    git(wt, 'commit', '-q', '-m', 'tracked');
    git(repo, 'merge', '-q', '--ff-only', branch);
    const busy = (path: string) => {
      rmSync(join(path, 'tracked.txt'));
      throw Object.assign(new Error('resource busy'), { code: 'EBUSY' });
    };
    const options = { repo, branch, mergedInto: 'main', cwd: repo };
    expect(() => removeWorktree({ ...options, remove: busy })).toThrow(/Partially deleted/);
    expect(branches()).toContain(branch);
    // The deleted tracked file now shows as a change; the rerun still finishes.
    expect(removeWorktree(options)).toMatchObject({ removedWorktree: true, resumed: true });
    expect(existsSync(wt)).toBe(false);
    expect(branches()).toEqual(['main']);
  });

  it('deletes only the branch when the worktree folder is already gone', () => {
    git(repo, 'merge', '-q', '--ff-only', branch);
    rmSync(wt, { recursive: true, force: true });
    const result = removeWorktree({ repo, branch, mergedInto: 'main', cwd: repo });
    expect(result).toMatchObject({ removedWorktree: false, deletedBranch: true });
    expect(listWorktrees(repo)).toHaveLength(1);
    expect(branches()).toEqual(['main']);
  });
});
