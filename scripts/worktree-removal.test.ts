import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type * as NodeFs from 'node:fs';
import { join, relative } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listWorktrees, removeWorktree } from './worktree-removal';
import * as gitHelpers from './git';
import { branch, git, worktreeRemovalFixture } from './worktree-removal-fixture';

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof NodeFs>();
  return { ...fs, rmSync: vi.fn(fs.rmSync), readdirSync: vi.fn(fs.readdirSync) };
});

const fixture = worktreeRemovalFixture();
const { branches, markerPath, mergedOptions, interruptRemoval, trackedFile } = fixture;
let repo: string, wt: string;
beforeEach(() => {
  ({ repo, wt } = fixture);
});

describe('removeWorktree', () => {
  it.each(['test-results', 'packages/data/raw/nested/empty'])(
    'allows an ignored tree containing only real directories: %s',
    (path) => {
      const options = mergedOptions();
      mkdirSync(join(wt, path), { recursive: true });
      expect(removeWorktree({ ...options, dryRun: true }).removedWorktree).toBe(true);
      expect(existsSync(join(wt, path))).toBe(true);
      expect(removeWorktree(options).removedWorktree).toBe(true);
      expect(existsSync(wt)).toBe(false);
    },
  );

  it('protects linked and unreadable entries inside ignored trees', () => {
    const options = mergedOptions();
    const ignored = join(wt, 'test-results');
    const external = join(fixture.root, 'private');
    mkdirSync(external);
    mkdirSync(ignored);
    writeFileSync(join(external, 'data.txt'), 'private');
    symlinkSync(
      external,
      join(ignored, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    for (const dryRun of [true, false]) {
      expect(() => removeWorktree({ ...options, dryRun })).toThrow(/protected ignored files/);
      expect(readFileSync(join(external, 'data.txt'), 'utf8')).toBe('private');
    }
    rmSync(join(ignored, 'linked'), { recursive: true });
    const original = vi.mocked(readdirSync).getMockImplementation()!;
    vi.mocked(readdirSync).mockImplementation(((path: NodeFs.PathLike, ...args: unknown[]) => {
      if (typeof path === 'string' && relative(ignored, path) === '') {
        throw Object.assign(new Error('unreadable directory'), { code: 'EACCES' });
      }
      const result: unknown = Reflect.apply(original, undefined, [path, ...args]);
      return result;
    }) as typeof readdirSync);
    try {
      expect(() => removeWorktree(options)).toThrow(/protected ignored files/);
      expect(existsSync(ignored)).toBe(true);
      expect(branches()).toContain(branch);
    } finally {
      vi.mocked(readdirSync).mockImplementation(original);
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
    wt = interruptRemoval(options);
    const marker = readFileSync(markerPath(), 'utf8');
    git(repo, 'worktree', 'lock', fixture.wt);
    rmSync(wt, { recursive: true, force: true });
    for (const dryRun of [true, false]) {
      expect(() => removeWorktree({ ...options, dryRun })).toThrow(/is locked/);
      expect(readFileSync(markerPath(), 'utf8')).toBe(marker);
      expect(branches()).toContain(branch);
      expect(listWorktrees(repo).some((entry) => entry.path === fixture.wt)).toBe(true);
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
      if (typeof path === 'string' && path.endsWith(`${join('', 'apps')}`)) {
        original(join(path, 'web/tracked.txt'));
        throw Object.assign(new Error('busy subtree'), { code: 'EPERM' });
      }
      return original(path, removeOptions);
    });
    try {
      expect(() => removeWorktree(options)).toThrow(/Partially deleted/);
    } finally {
      vi.mocked(rmSync).mockImplementation(original);
    }
    wt = (JSON.parse(readFileSync(markerPath(), 'utf8')) as { tomb: string }).tomb;
    expect(existsSync(join(wt, '.git'))).toBe(true);
    expect(existsSync(join(wt, '.gitignore'))).toBe(true);
    writeFileSync(join(wt, '.env.local'), 'new private configuration');
    expect(() => removeWorktree(options)).toThrow(/protected ignored files/);
    expect(readFileSync(join(wt, '.env.local'), 'utf8')).toBe('new private configuration');
    rmSync(join(wt, '.env.local'));
    expect(removeWorktree(options).resumed).toBe(true);
    expect(existsSync(wt)).toBe(false);
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

  it('changes nothing on a dry run', () => {
    git(repo, 'merge', '-q', '--ff-only', branch);
    const result = removeWorktree({ repo, branch, mergedInto: 'main', cwd: repo, dryRun: true });
    expect(result).toMatchObject({ removedWorktree: true, deletedBranch: true, resumed: false });
    expect(existsSync(wt)).toBe(true);
    expect(branches()).toContain(branch);
  });
});
