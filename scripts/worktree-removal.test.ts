import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listWorktrees, removeWorktree } from './worktree-removal';
import { mainCheckout } from './git';

let root: string, repo: string, wt: string;
const branch = 'codex/topic';
const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
const branches = () => git(repo, 'branch', '--format=%(refname:short)').trim().split('\n');
const markerPath = () => join(repo, '.git', 'atlas-worktree-removal', encodeURIComponent(branch));
const mergedOptions = () => {
  git(repo, 'merge', '-q', '--ff-only', branch);
  return { repo, branch, mergedInto: 'main', cwd: repo };
};
function interruptRemoval(options: ReturnType<typeof mergedOptions>) {
  expect(() =>
    removeWorktree({
      ...options,
      remove: () => {
        rmSync(join(wt, 'tracked.txt'));
        throw Object.assign(new Error('resource busy'), { code: 'EBUSY' });
      },
    }),
  ).toThrow(/Partially deleted/);
}
function trackedFile() {
  writeFileSync(join(wt, 'tracked.txt'), 'original');
  git(wt, 'add', 'tracked.txt');
  git(wt, 'commit', '-q', '-m', 'tracked');
}

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
  it('discovers the same main checkout from main and a linked worktree', () => {
    expect(mainCheckout(repo)).toBe(repo);
    expect(mainCheckout(wt)).toBe(repo);
    expect(listWorktrees(repo)).toEqual(listWorktrees(wt));
  });
  it('refuses a branch in the main checkout and a missing branch', () => {
    git(repo, 'symbolic-ref', 'HEAD', 'refs/heads/codex/primary');
    git(repo, 'update-ref', 'refs/heads/codex/primary', 'main');
    expect(() =>
      removeWorktree({ repo, branch: 'codex/primary', mergedInto: 'main', cwd: repo }),
    ).toThrow(/main checkout/);
    expect(() =>
      removeWorktree({ repo, branch: 'codex/absent', mergedInto: 'main', cwd: repo }),
    ).toThrow(/No local branch/);
  });

  it('refuses new or modified work after an interruption, also on dry-run', () => {
    trackedFile();
    const options = mergedOptions();
    interruptRemoval(options);
    writeFileSync(join(wt, 'tracked.txt'), 'new work');
    writeFileSync(join(wt, 'new.txt'), 'new work');
    expect(() => removeWorktree({ ...options, dryRun: true })).toThrow(/uncommitted changes/);
    expect(() => removeWorktree(options)).toThrow(/uncommitted changes/);
    expect(readFileSync(join(wt, 'tracked.txt'), 'utf8')).toBe('new work');
    expect(existsSync(join(wt, 'new.txt'))).toBe(true);
    expect(branches()).toContain(branch);
  });

  it('refuses staged changes on a resumed removal', () => {
    trackedFile();
    const options = mergedOptions();
    interruptRemoval(options);
    git(wt, 'add', 'tracked.txt');
    expect(() => removeWorktree(options)).toThrow(/uncommitted changes/);
    expect(existsSync(wt)).toBe(true);
  });

  it('leaves legitimate resumed removals and markers unchanged on dry-run', () => {
    trackedFile();
    const options = mergedOptions();
    interruptRemoval(options);
    const marker = readFileSync(markerPath(), 'utf8');
    expect(removeWorktree({ ...options, dryRun: true }).resumed).toBe(true);
    expect(readFileSync(markerPath(), 'utf8')).toBe(marker);
    expect(existsSync(wt)).toBe(true);
    expect(branches()).toContain(branch);
  });

  it('uses surviving Git metadata when removal deleted the worktree pointer', () => {
    trackedFile();
    const options = mergedOptions();
    interruptRemoval(options);
    rmSync(join(wt, '.git'));
    expect(removeWorktree(options).resumed).toBe(true);
    expect(existsSync(wt)).toBe(false);
  });

  it('does not trust a marker for a different path or branch head', () => {
    trackedFile();
    const options = mergedOptions();
    mkdirSync(join(repo, '.git', 'atlas-worktree-removal'));
    writeFileSync(
      markerPath(),
      JSON.stringify({
        worktree: join(root, 'old-worktree'),
        head: git(wt, 'rev-parse', 'HEAD').trim(),
      }),
    );
    rmSync(join(wt, 'tracked.txt'));
    const marker = readFileSync(markerPath(), 'utf8');
    expect(() => removeWorktree({ ...options, dryRun: true })).toThrow(/uncommitted changes/);
    expect(readFileSync(markerPath(), 'utf8')).toBe(marker);
    expect(() => removeWorktree(options)).toThrow(/uncommitted changes/);
    expect(existsSync(markerPath())).toBe(false);
    writeFileSync(markerPath(), JSON.stringify({ worktree: wt, head: 'obsolete' }));
    expect(() => removeWorktree(options)).toThrow(/uncommitted changes/);
    expect(existsSync(wt)).toBe(true);
  });

  it('removes an obsolete marker only on actual cleanup when its branch is gone', () => {
    trackedFile();
    const options = mergedOptions();
    interruptRemoval(options);
    rmSync(wt, { recursive: true, force: true });
    git(repo, 'worktree', 'prune');
    git(repo, 'branch', '-D', branch);
    expect(() => removeWorktree({ ...options, dryRun: true })).toThrow(/No local branch/);
    expect(existsSync(markerPath())).toBe(true);
    expect(() => removeWorktree(options)).toThrow(/No local branch/);
    expect(existsSync(markerPath())).toBe(false);
    git(repo, 'worktree', 'add', '-q', wt, '-b', branch);
    writeFileSync(join(wt, 'new.txt'), 'new work');
    expect(() => removeWorktree(options)).toThrow(/uncommitted changes/);
    expect(existsSync(join(wt, 'new.txt'))).toBe(true);
  });

  it('protects ignored configuration, raw downloads and unpublished tiles', () => {
    writeFileSync(
      join(wt, '.gitignore'),
      '.env.local\npackages/data/raw/\napps/web/public/tiles/\n',
    );
    git(wt, 'add', '.gitignore');
    git(wt, 'commit', '-q', '-m', 'ignore local data');
    const options = mergedOptions();
    for (const path of [
      '.env.local',
      'packages/data/raw/source.json',
      'apps/web/public/tiles/local.pmtiles',
    ]) {
      mkdirSync(join(wt, path, '..'), { recursive: true });
      writeFileSync(join(wt, path), 'local data');
    }
    expect(() => removeWorktree({ ...options, dryRun: true })).toThrow(/protected ignored files/);
    expect(() => removeWorktree(options)).toThrow(/protected ignored files/);
    expect(existsSync(join(wt, '.env.local'))).toBe(true);
    expect(existsSync(join(wt, 'packages/data/raw/source.json'))).toBe(true);
    expect(existsSync(join(wt, 'apps/web/public/tiles/local.pmtiles'))).toBe(true);
  });

  it('allows disposable ignored caches but protects ignored work during a resumed removal', () => {
    trackedFile();
    writeFileSync(join(wt, '.gitignore'), 'node_modules/\napps/web/.next/\nlocal-data/\n');
    git(wt, 'add', '.gitignore');
    git(wt, 'commit', '-q', '-m', 'ignore caches');
    const options = mergedOptions();
    for (const path of ['node_modules/dependency.js', 'apps/web/.next/cache.bin']) {
      mkdirSync(join(wt, path, '..'), { recursive: true });
      writeFileSync(join(wt, path), 'cache');
    }
    expect(removeWorktree({ ...options, dryRun: true }).resumed).toBe(false);
    interruptRemoval(options);
    mkdirSync(join(wt, 'local-data'));
    writeFileSync(join(wt, 'local-data', 'work.txt'), 'local work');
    expect(() => removeWorktree(options)).toThrow(/protected ignored files/);
    rmSync(join(wt, 'local-data'), { recursive: true });
    expect(removeWorktree(options).resumed).toBe(true);
    expect(existsSync(wt)).toBe(false);
  });

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
