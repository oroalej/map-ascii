import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type * as NodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { listWorktrees, removeWorktree } from './worktree-removal';
import { mainCheckout } from './git';

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof NodeFs>();
  return { ...fs, rmSync: vi.fn(fs.rmSync) };
});

let root: string, repo: string, wt: string;
let templateRoot: string, template: string;
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

/** Build immutable base/work commits once; each test clones independent refs and metadata. */
beforeAll(() => {
  templateRoot = mkdtempSync(join(tmpdir(), 'worktree-removal-template-'));
  template = join(templateRoot, 'repo');
  const templateWorktree = join(templateRoot, 'topic');
  git(templateRoot, 'init', '-q', template);
  git(template, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(template, 'commit', '-q', '--allow-empty', '-m', 'base');
  git(template, 'worktree', 'add', '-q', templateWorktree, '-b', branch);
  git(templateWorktree, 'commit', '-q', '--allow-empty', '-m', 'work');
});
afterAll(() => rmSync(templateRoot, { recursive: true, force: true, maxRetries: 3 }));
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'worktree-removal-'));
  repo = join(root, 'repo');
  wt = join(root, 'repo-topic');
  git(root, 'clone', '-q', '--local', template, repo);
  git(repo, 'worktree', 'add', '-q', wt, '-b', branch, '--no-track', `origin/${branch}`);
});
afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));

describe('removeWorktree', () => {
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

  it('allows the generated Next environment declaration', () => {
    writeFileSync(join(wt, '.gitignore'), 'next-env.d.ts\n');
    git(wt, 'add', '.gitignore');
    git(wt, 'commit', '-q', '-m', 'ignore next types');
    const options = mergedOptions();
    mkdirSync(join(wt, 'apps/web'), { recursive: true });
    writeFileSync(join(wt, 'apps/web/next-env.d.ts'), 'generated by Next');
    expect(removeWorktree({ ...options, dryRun: true }).removedWorktree).toBe(true);
    expect(removeWorktree(options).removedWorktree).toBe(true);
    expect(existsSync(wt)).toBe(false);
  });

  it('allows matching published tiles but refuses changed or unknown artifacts', () => {
    const lockDir = join(wt, 'packages/content/cities/fixture');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, 'tiles.lock.json'),
      JSON.stringify({
        repo: 'test/repo',
        tag: 'tiles-fixture',
        files: { 'fixture.pmtiles': createHash('sha256').update('published').digest('hex') },
      }),
    );
    writeFileSync(join(wt, '.gitignore'), 'apps/web/public/tiles/\n');
    git(wt, 'add', '.gitignore', 'packages/content/cities/fixture/tiles.lock.json');
    git(wt, 'commit', '-q', '-m', 'pin tiles');
    const options = mergedOptions();
    const tiles = join(wt, 'apps/web/public/tiles');
    mkdirSync(tiles, { recursive: true });
    const archive = join(tiles, 'fixture.pmtiles');
    writeFileSync(archive, 'published');
    expect(removeWorktree({ ...options, dryRun: true }).removedWorktree).toBe(true);
    writeFileSync(archive, 'unpublished');
    expect(() => removeWorktree(options)).toThrow(/protected ignored files/);
    expect(readFileSync(archive, 'utf8')).toBe('unpublished');
    writeFileSync(archive, 'published');
    writeFileSync(join(tiles, 'unknown.pmtiles'), 'local data');
    expect(() => removeWorktree(options)).toThrow(/protected ignored files/);
    rmSync(join(tiles, 'unknown.pmtiles'));
    expect(removeWorktree(options).removedWorktree).toBe(true);
  });

  it('accepts older published bytes after synchronizing a changed tile lock', () => {
    const path = 'packages/content/cities/fixture/tiles.lock.json';
    const lock = (bytes: string) =>
      JSON.stringify({
        repo: 'test/repo',
        tag: 'tiles-fixture',
        files: { 'fixture.pmtiles': createHash('sha256').update(bytes).digest('hex') },
      });
    mkdirSync(join(wt, path, '..'), { recursive: true });
    writeFileSync(join(wt, path), lock('previous published'));
    git(wt, 'add', path);
    git(wt, 'commit', '-q', '-m', 'pin previous tiles');
    mergedOptions();
    writeFileSync(join(repo, path), lock('new published'));
    git(repo, 'add', path);
    git(repo, 'commit', '-q', '-m', 'update tiles');
    git(wt, 'merge', '-q', '--ff-only', 'main');
    const options = mergedOptions();
    const archive = join(wt, 'apps/web/public/tiles/fixture.pmtiles');
    mkdirSync(join(archive, '..'), { recursive: true });
    writeFileSync(archive, 'previous published');
    expect(removeWorktree({ ...options, dryRun: true }).removedWorktree).toBe(true);
    writeFileSync(archive, 'unpublished');
    expect(() => removeWorktree(options)).toThrow(/uncommitted changes/);
    writeFileSync(archive, 'previous published');
    expect(removeWorktree(options).removedWorktree).toBe(true);
  });

  it('retains root metadata through a busy subtree and protects new ignored work on retry', () => {
    writeFileSync(join(wt, '.gitignore'), 'node_modules/\n.env.local\n');
    mkdirSync(join(wt, 'apps/web'), { recursive: true });
    writeFileSync(join(wt, 'apps/web/tracked.txt'), 'original');
    git(wt, 'add', '.gitignore', 'apps/web/tracked.txt');
    git(wt, 'commit', '-q', '-m', 'tracked app');
    const options = mergedOptions();
    mkdirSync(join(wt, 'node_modules'));
    writeFileSync(join(wt, 'node_modules/dependency.js'), 'cache');
    const original = vi.mocked(rmSync).getMockImplementation()!;
    vi.mocked(rmSync).mockImplementation((path, removeOptions) => {
      if (path === join(wt, 'apps')) {
        original(join(wt, 'apps/web/tracked.txt'));
        throw Object.assign(new Error('busy subtree'), { code: 'EPERM' });
      }
      return original(path, removeOptions);
    });
    try {
      expect(() => removeWorktree(options)).toThrow(/Partially deleted/);
    } finally {
      vi.mocked(rmSync).mockImplementation(original);
    }
    expect(existsSync(join(wt, '.git'))).toBe(true);
    expect(existsSync(join(wt, '.gitignore'))).toBe(true);
    writeFileSync(join(wt, '.env.local'), 'new private configuration');
    expect(() => removeWorktree(options)).toThrow(/protected ignored files/);
    expect(readFileSync(join(wt, '.env.local'), 'utf8')).toBe('new private configuration');
    rmSync(join(wt, '.env.local'));
    expect(removeWorktree(options).resumed).toBe(true);
    expect(existsSync(wt)).toBe(false);
  });

  it('checks the captured branch commit despite a same-name tag', () => {
    git(repo, 'tag', branch, 'main');
    expect(() => removeWorktree({ repo, branch, mergedInto: 'main', cwd: repo })).toThrow(
      /not merged/,
    );
    expect(existsSync(wt)).toBe(true);
    expect(git(repo, 'rev-parse', `refs/heads/${branch}`).trim()).toBe(
      git(wt, 'rev-parse', 'HEAD').trim(),
    );
  });

  it('preserves a branch that moves during folder deletion', () => {
    const options = mergedOptions();
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
  });

  it('discovers the same main checkout from main and a linked worktree', () => {
    expect(mainCheckout(repo)).toBe(repo);
    expect(mainCheckout(wt)).toBe(repo);
    expect(listWorktrees(repo)).toEqual(listWorktrees(wt));
  });
  it('refuses a branch in the main checkout and recognizes an absent branch', () => {
    git(repo, 'symbolic-ref', 'HEAD', 'refs/heads/codex/primary');
    git(repo, 'update-ref', 'refs/heads/codex/primary', 'main');
    expect(() =>
      removeWorktree({ repo, branch: 'codex/primary', mergedInto: 'main', cwd: repo }),
    ).toThrow(/main checkout/);
    expect(
      removeWorktree({ repo, branch: 'codex/absent', mergedInto: 'main', cwd: repo })
        .alreadyRemoved,
    ).toBe(true);
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
    expect(removeWorktree({ ...options, dryRun: true }).alreadyRemoved).toBe(true);
    expect(existsSync(markerPath())).toBe(true);
    expect(removeWorktree(options).alreadyRemoved).toBe(true);
    expect(existsSync(markerPath())).toBe(false);
    git(repo, 'worktree', 'add', '-q', wt, '-b', branch);
    writeFileSync(join(wt, 'new.txt'), 'new work');
    expect(() => removeWorktree(options)).toThrow(/uncommitted changes/);
    expect(existsSync(join(wt, 'new.txt'))).toBe(true);
  });

  it('refuses missing or ambiguous recovery metadata and preserves the marker and branch', () => {
    trackedFile();
    const options = mergedOptions();
    const metadata = git(wt, 'rev-parse', '--absolute-git-dir').trim();
    interruptRemoval(options);
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
        remove: () => {
          rmSync(join(other, '.git'));
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
    interruptRemoval(options);
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

  it('protects ignored configuration, raw downloads and unpublished tiles', () => {
    writeFileSync(
      join(wt, '.gitignore'),
      '.env.local\npackages/data/raw/\napps/web/public/tiles/\n*.log\n',
    );
    git(wt, 'add', '.gitignore');
    git(wt, 'commit', '-q', '-m', 'ignore local data');
    const options = mergedOptions();
    for (const path of [
      '.env.local',
      'packages/data/raw/source.json',
      'apps/web/public/tiles/local.pmtiles',
      'debug.log',
    ]) {
      mkdirSync(join(wt, path, '..'), { recursive: true });
      writeFileSync(join(wt, path), 'local data');
    }
    expect(() => removeWorktree({ ...options, dryRun: true })).toThrow(/protected ignored files/);
    expect(() => removeWorktree(options)).toThrow(/protected ignored files/);
    expect(existsSync(join(wt, '.env.local'))).toBe(true);
    expect(existsSync(join(wt, 'packages/data/raw/source.json'))).toBe(true);
    expect(existsSync(join(wt, 'apps/web/public/tiles/local.pmtiles'))).toBe(true);
    expect(existsSync(join(wt, 'debug.log'))).toBe(true);
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
    expect(() => remove('main')).toThrow(/Refusing to remove main/);
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
