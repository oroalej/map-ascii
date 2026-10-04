import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type * as NodeFs from 'node:fs';
import { join, relative } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listWorktrees, removeWorktree } from './worktree-removal';
import { mainCheckout } from './git';
import * as gitHelpers from './git';
import { branch, git, worktreeRemovalFixture } from './worktree-removal-fixture';

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof NodeFs>();
  return { ...fs, rmSync: vi.fn(fs.rmSync) };
});

const fixture = worktreeRemovalFixture();
const { branches, markerPath, mergedOptions, interruptRemoval, trackedFile } = fixture;
let repo: string, wt: string;
beforeEach(() => {
  ({ repo, wt } = fixture);
});

describe('removeWorktree', () => {
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

  it('removes a matching PR head and recognizes completed pinned reruns', () => {
    const options = { ...mergedOptions(), expectedHead: git(wt, 'rev-parse', 'HEAD').trim() };
    expect(removeWorktree({ ...options, dryRun: true }).deletedBranch).toBe(true);
    expect(removeWorktree(options).deletedBranch).toBe(true);
    for (const dryRun of [true, false]) {
      expect(removeWorktree({ ...options, dryRun }).alreadyRemoved).toBe(true);
    }
  });

  it('distinguishes protected ignored files from mixed uncommitted work', () => {
    const options = mergedOptions();
    const raw = join(wt, 'packages/data/raw/source.json');
    mkdirSync(join(raw, '..'), { recursive: true });
    writeFileSync(raw, 'saved download');
    for (const dryRun of [true, false]) {
      expect(() => removeWorktree({ ...options, dryRun })).toThrow(/has protected ignored files:/);
    }
    writeFileSync(join(wt, 'new.txt'), 'new work');
    for (const dryRun of [true, false]) {
      expect(() => removeWorktree({ ...options, dryRun })).toThrow(/has uncommitted changes:/);
      expect(readFileSync(raw, 'utf8')).toBe('saved download');
      expect(readFileSync(join(wt, 'new.txt'), 'utf8')).toBe('new work');
      expect(existsSync(markerPath())).toBe(false);
      expect(branches()).toContain(branch);
    }
  });

  it('protects root performance reports while allowing web test caches', () => {
    const options = mergedOptions();
    const report = join(wt, 'test-results/perf.json');
    mkdirSync(join(report, '..'), { recursive: true });
    writeFileSync(report, 'performance evidence');
    const webReport = join(wt, 'apps/web/test-results/result.json');
    mkdirSync(join(webReport, '..'), { recursive: true });
    writeFileSync(webReport, 'browser cache');
    for (const dryRun of [true, false]) {
      expect(() => removeWorktree({ ...options, dryRun })).toThrow(/protected ignored files/);
      expect(readFileSync(report, 'utf8')).toBe('performance evidence');
    }
    rmSync(join(wt, 'test-results'), { recursive: true });
    expect(removeWorktree({ ...options, dryRun: true }).removedWorktree).toBe(true);
    expect(removeWorktree(options).removedWorktree).toBe(true);
  });
  it('allows ignored OS junk at the root and in workspace packages', () => {
    writeFileSync(join(wt, '.gitignore'), 'desktop.ini\nThumbs.db\n.DS_Store\n');
    git(wt, 'add', '.gitignore');
    git(wt, 'commit', '-q', '-m', 'ignore OS junk');
    const options = mergedOptions();
    for (const path of ['desktop.ini', 'apps/web/Thumbs.db', 'packages/data/.DS_Store']) {
      mkdirSync(join(wt, path, '..'), { recursive: true });
      writeFileSync(join(wt, path), 'OS metadata');
    }
    expect(removeWorktree({ ...options, dryRun: true }).removedWorktree).toBe(true);
    expect(removeWorktree(options).removedWorktree).toBe(true);
    expect(existsSync(wt)).toBe(false);
  });
  it('refuses a locked registration even when its folder is already missing', () => {
    trackedFile();
    const options = mergedOptions();
    interruptRemoval(options);
    const marker = readFileSync(markerPath(), 'utf8');
    git(repo, 'worktree', 'lock', wt);
    rmSync(wt, { recursive: true, force: true });
    for (const dryRun of [true, false]) {
      expect(() => removeWorktree({ ...options, dryRun })).toThrow(/is locked/);
      expect(readFileSync(markerPath(), 'utf8')).toBe(marker);
      expect(branches()).toContain(branch);
      expect(listWorktrees(repo).some((entry) => entry.path === wt)).toBe(true);
    }
  });

  it('resolves relative Git backlinks against their metadata directory', () => {
    const options = mergedOptions();
    const worktrees = listWorktrees(repo);
    const metadata = git(wt, 'rev-parse', '--absolute-git-dir').trim();
    const backlink = readFileSync(join(metadata, 'gitdir'), 'utf8');
    writeFileSync(join(metadata, 'gitdir'), relative(metadata, join(wt, '.git')));
    // Git 2.27 cannot list relative backlinks; modern Git still returns absolute worktree paths.
    const listing = vi.spyOn(gitHelpers, 'listWorktrees').mockReturnValue(worktrees);
    try {
      expect(removeWorktree({ ...options, dryRun: true }).removedWorktree).toBe(true);
      expect(existsSync(wt)).toBe(true);
    } finally {
      listing.mockRestore();
      writeFileSync(join(metadata, 'gitdir'), backlink);
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
    git(wt, 'add', 'packages/content/cities/fixture/tiles.lock.json');
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
    expect(() => removeWorktree(options)).toThrow(/protected ignored files/);
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

  it('protects ignored configuration, raw downloads and unpublished tiles', () => {
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
});
