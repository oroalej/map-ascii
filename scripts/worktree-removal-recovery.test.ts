import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { listWorktrees, removeWorktree } from './worktree-removal';
import { branch, git, worktreeRemovalFixture } from './worktree-removal-fixture';

const fixture = worktreeRemovalFixture();
const { branches, markerPath, mergedOptions, interruptRemoval, trackedFile } = fixture;
let root: string, repo: string, wt: string;
beforeEach(() => {
  ({ root, repo, wt } = fixture);
});

describe('removeWorktree', () => {
  it('refuses locked registrations before changing folders, branches or markers', () => {
    const options = mergedOptions();
    git(repo, 'worktree', 'lock', wt);
    for (const dryRun of [true, false]) {
      expect(() => removeWorktree({ ...options, dryRun })).toThrow(/is locked/);
      expect(existsSync(wt)).toBe(true);
      expect(existsSync(markerPath())).toBe(false);
      expect(branches()).toContain(branch);
    }
  });

  it('preserves a branch that moves during folder deletion', () => {
    const options = mergedOptions();
    git(repo, 'branch', '--set-upstream-to', `origin/${branch}`, branch);
    const newer = git(repo, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'new work').trim();
    expect(() =>
      removeWorktree({
        ...options,
        remove: (path) => {
          git(repo, 'update-ref', `refs/heads/${branch}`, newer);
          rmSync(path, { recursive: true, force: true });
        },
      }),
    ).toThrow();
    expect(git(repo, 'rev-parse', `refs/heads/${branch}`).trim()).toBe(newer);
    expect(branches()).toContain(branch);
    expect(git(repo, 'config', '--get', `branch.${branch}.remote`).trim()).toBe('origin');
  });

  it('refuses new or modified work after an interruption, also on dry-run', () => {
    trackedFile();
    const options = mergedOptions();
    wt = interruptRemoval(options);
    writeFileSync(join(wt, 'tracked.txt'), 'new work');
    writeFileSync(join(wt, 'new.txt'), 'new work');
    expect(() => removeWorktree({ ...options, dryRun: true })).toThrow(/uncommitted changes/);
    expect(() => removeWorktree(options)).toThrow(/uncommitted changes/);
    expect(readFileSync(join(wt, 'tracked.txt'), 'utf8')).toBe('new work');
    expect(existsSync(join(wt, 'new.txt'))).toBe(true);
    expect(branches()).toContain(branch);
  });

  it('preserves an interrupted folder now owned by another branch', () => {
    trackedFile();
    const options = mergedOptions();
    wt = interruptRemoval(options);
    const marker = readFileSync(markerPath(), 'utf8');
    git(wt, 'switch', '-c', 'codex/other');
    writeFileSync(join(wt, 'private.txt'), 'new owner work');
    for (const dryRun of [true, false]) {
      expect(() => removeWorktree({ ...options, dryRun })).toThrow(/branch ownership differs/);
      expect(readFileSync(markerPath(), 'utf8')).toBe(marker);
      expect(readFileSync(join(wt, 'private.txt'), 'utf8')).toBe('new owner work');
      expect(existsSync(wt)).toBe(true);
      expect(branches()).toContain(branch);
      expect(branches()).toContain('codex/other');
    }
  });

  it('refuses staged changes on a resumed removal', () => {
    trackedFile();
    const options = mergedOptions();
    wt = interruptRemoval(options);
    git(wt, 'add', 'tracked.txt');
    expect(() => removeWorktree(options)).toThrow(/uncommitted changes/);
    expect(existsSync(wt)).toBe(true);
  });

  it('leaves legitimate resumed removals and markers unchanged on dry-run', () => {
    trackedFile();
    const options = mergedOptions();
    wt = interruptRemoval(options);
    const marker = readFileSync(markerPath(), 'utf8');
    expect(removeWorktree({ ...options, dryRun: true }).resumed).toBe(true);
    expect(readFileSync(markerPath(), 'utf8')).toBe(marker);
    expect(existsSync(wt)).toBe(true);
    expect(branches()).toContain(branch);
  });

  it('uses surviving Git metadata when removal deleted the worktree pointer', () => {
    trackedFile();
    const options = mergedOptions();
    wt = interruptRemoval(options);
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
    wt = interruptRemoval(options);
    rmSync(wt, { recursive: true, force: true });
    git(repo, 'worktree', 'prune');
    git(repo, 'branch', '-D', branch);
    git(repo, 'update-ref', '-d', `refs/remotes/origin/${branch}`);
    expect(removeWorktree({ ...options, dryRun: true }).alreadyRemoved).toBe(true);
    expect(existsSync(markerPath())).toBe(true);
    expect(removeWorktree(options).alreadyRemoved).toBe(true);
    expect(existsSync(markerPath())).toBe(false);
    git(repo, 'worktree', 'add', '-q', fixture.wt, '-b', branch);
    wt = fixture.wt;
    writeFileSync(join(wt, 'new.txt'), 'new work');
    expect(() => removeWorktree(options)).toThrow(/uncommitted changes/);
    expect(existsSync(join(wt, 'new.txt'))).toBe(true);
  });

  it('refuses missing or ambiguous recovery metadata and preserves the marker and branch', () => {
    trackedFile();
    const options = mergedOptions();
    const metadata = git(wt, 'rev-parse', '--absolute-git-dir').trim();
    wt = interruptRemoval(options);
    const marker = readFileSync(markerPath(), 'utf8');
    rmSync(join(wt, '.git'));
    const gitdir = readFileSync(join(metadata, 'gitdir'), 'utf8');
    rmSync(join(metadata, 'gitdir'));
    for (const dryRun of [true, false]) {
      expect(() => removeWorktree({ ...options, dryRun })).toThrow(
        /metadata is missing or ambiguous/,
      );
    }
    writeFileSync(join(metadata, 'gitdir'), gitdir);
    const duplicate = join(repo, '.git/worktrees/duplicate');
    cpSync(metadata, duplicate, { recursive: true });
    for (const dryRun of [true, false]) {
      expect(() => removeWorktree({ ...options, dryRun })).toThrow(
        /metadata is missing or ambiguous/,
      );
    }
    expect(readFileSync(markerPath(), 'utf8')).toBe(marker);
    expect(existsSync(wt)).toBe(true);
    expect(branches()).toContain(branch);
    rmSync(duplicate, { recursive: true });
    expect(removeWorktree(options).resumed).toBe(true);
  });

  it('preserves another interrupted worktree registration during targeted removal', () => {
    trackedFile();
    const options = mergedOptions();
    const other = join(root, 'other');
    const otherBranch = 'codex/other';
    git(repo, 'worktree', 'add', '-q', other, '-b', otherBranch);
    const otherMetadata = git(other, 'rev-parse', '--absolute-git-dir').trim();
    const otherOptions = { ...options, branch: otherBranch };
    expect(() =>
      removeWorktree({
        ...otherOptions,
        remove: (path) => {
          rmSync(join(path, '.git'));
          throw Object.assign(new Error('resource busy'), { code: 'EBUSY' });
        },
      }),
    ).toThrow(/Partially deleted/);
    expect(removeWorktree(options).removedWorktree).toBe(true);
    expect(existsSync(otherMetadata)).toBe(true);
    expect(listWorktrees(repo).some((entry) => entry.path === other)).toBe(true);
    expect(removeWorktree(otherOptions).resumed).toBe(true);
    expect(existsSync(other)).toBe(false);
  });

  it('reports completed removal and refuses pending or unreadable markers without mutations', () => {
    trackedFile();
    const options = mergedOptions();
    wt = interruptRemoval(options);
    const marker = readFileSync(markerPath(), 'utf8');
    const metadata = git(wt, 'rev-parse', '--absolute-git-dir').trim();
    rmSync(join(wt, '.git'));
    rmSync(join(metadata, 'gitdir'));
    git(repo, 'update-ref', '-d', `refs/heads/${branch}`);
    for (const dryRun of [true, false]) {
      expect(() => removeWorktree({ ...options, dryRun })).toThrow(/Removal marker pending/);
      expect(readFileSync(markerPath(), 'utf8')).toBe(marker);
    }
    writeFileSync(markerPath(), '{invalid');
    for (const dryRun of [true, false]) {
      expect(() => removeWorktree({ ...options, dryRun })).toThrow(/unreadable or ambiguous/);
      expect(readFileSync(markerPath(), 'utf8')).toBe('{invalid');
    }
    expect(existsSync(wt)).toBe(true);
  });

  it('allows disposable ignored caches but protects ignored work during a resumed removal', () => {
    trackedFile();
    writeFileSync(
      join(wt, '.gitignore'),
      'node_modules/\napps/web/.next/\nlocal-data/\npackages/data/build/\ncoverage/\nblob-report/\n',
    );
    git(wt, 'add', '.gitignore');
    git(wt, 'commit', '-q', '-m', 'ignore caches');
    const options = mergedOptions();
    for (const path of [
      'node_modules/dependency.js',
      'apps/web/.next/cache.bin',
      'packages/data/build/normalized.json',
      'coverage/report.json',
      'blob-report/results.zip',
    ]) {
      mkdirSync(join(wt, path, '..'), { recursive: true });
      writeFileSync(join(wt, path), 'cache');
    }
    expect(removeWorktree({ ...options, dryRun: true }).resumed).toBe(false);
    wt = interruptRemoval(options);
    mkdirSync(join(wt, 'local-data'));
    writeFileSync(join(wt, 'local-data', 'work.txt'), 'local work');
    expect(() => removeWorktree(options)).toThrow(/protected ignored files/);
    rmSync(join(wt, 'local-data'), { recursive: true });
    expect(removeWorktree(options).resumed).toBe(true);
    expect(existsSync(wt)).toBe(false);
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
