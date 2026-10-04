import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type * as NodeFs from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { removeWorktree } from './worktree-removal';
import { branch, git, worktreeRemovalFixture } from './worktree-removal-fixture';

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof NodeFs>();
  return { ...fs, renameSync: vi.fn(fs.renameSync) };
});

const fixture = worktreeRemovalFixture();
const { branches, markerPath, mergedOptions, interruptRemoval, trackedFile } = fixture;
let repo: string, wt: string;
beforeEach(() => {
  ({ repo, wt } = fixture);
});

describe('worktree relocation and recovery', () => {
  it.skipIf(process.platform !== 'win32').each(['.', 'apps/web'])(
    'preserves every entry when another process holds cwd %s',
    async (subdir) => {
      const options = mergedOptions();
      const before = readdirSync(wt);
      const pointer = readFileSync(join(wt, '.git'), 'utf8');
      const child = spawn(
        process.execPath,
        ['-e', "process.send('ready'); setInterval(() => {}, 1000)"],
        {
          cwd: join(wt, subdir),
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          windowsHide: true,
        },
      );
      try {
        await new Promise<void>((resolve, reject) => {
          child.once('message', () => resolve());
          child.once('error', reject);
          child.once('exit', () => reject(new Error('cwd holder exited before readiness')));
        });
        expect(() => removeWorktree(options)).toThrow(/Could not relocate.*nothing was removed/);
        expect(readdirSync(wt)).toEqual(before);
        expect(readFileSync(join(wt, '.git'), 'utf8')).toBe(pointer);
        expect(branches()).toContain(branch);
      } finally {
        const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
        child.kill();
        await closed;
      }
      expect(removeWorktree(options).resumed).toBe(true);
      expect(existsSync(wt)).toBe(false);
    },
  );

  it('does not excuse deleted tracked files when rename never happened', () => {
    trackedFile();
    const options = mergedOptions();
    const original = vi.mocked(renameSync).getMockImplementation()!;
    vi.mocked(renameSync).mockImplementation((source, target) => {
      if (source === wt) throw Object.assign(new Error('busy directory'), { code: 'EPERM' });
      original(source, target);
    });
    try {
      expect(() => removeWorktree(options)).toThrow(/Could not relocate/);
    } finally {
      vi.mocked(renameSync).mockImplementation(original);
    }
    expect(JSON.parse(readFileSync(markerPath(), 'utf8'))).toMatchObject({ phase: 'prepared' });
    rmSync(join(wt, 'tracked.txt'));
    expect(() => removeWorktree(options)).toThrow(/uncommitted changes/);
    expect(branches()).toContain(branch);
  });

  it('recovers an interruption immediately after rename using its prepared marker', () => {
    const options = mergedOptions();
    const original = vi.mocked(renameSync).getMockImplementation()!;
    vi.mocked(renameSync).mockImplementation((source, target) => {
      original(source, target);
      if (source === wt) throw new Error('interrupted after rename');
    });
    try {
      expect(() => removeWorktree(options)).toThrow(/Could not relocate/);
    } finally {
      vi.mocked(renameSync).mockImplementation(original);
    }
    const marker = readFileSync(markerPath(), 'utf8');
    expect(JSON.parse(marker)).toMatchObject({ worktree: wt, phase: 'prepared' });
    expect(existsSync(wt)).toBe(false);
    expect(removeWorktree({ ...options, dryRun: true }).resumed).toBe(true);
    expect(readFileSync(markerPath(), 'utf8')).toBe(marker);
    expect(removeWorktree(options).resumed).toBe(true);
  });

  it('refuses an original path recreated while its sibling folder needs recovery', () => {
    trackedFile();
    const options = mergedOptions();
    const tomb = interruptRemoval(options);
    const marker = readFileSync(markerPath(), 'utf8');
    mkdirSync(wt);
    writeFileSync(join(wt, 'new.txt'), 'new session');
    for (const dryRun of [true, false]) {
      expect(() => removeWorktree({ ...options, dryRun })).toThrow(/path was recreated/);
      expect(readFileSync(join(wt, 'new.txt'), 'utf8')).toBe('new session');
      expect(readFileSync(markerPath(), 'utf8')).toBe(marker);
      expect(existsSync(tomb)).toBe(true);
      expect(branches()).toContain(branch);
    }
  });

  it('preserves a path recreated during deletion and keeps its registration and branch', () => {
    const options = mergedOptions();
    expect(() =>
      removeWorktree({
        ...options,
        remove: (path) => {
          mkdirSync(wt);
          writeFileSync(join(wt, 'new.txt'), 'new session');
          rmSync(path, { recursive: true });
        },
      }),
    ).toThrow(/path was recreated/);
    expect(readFileSync(join(wt, 'new.txt'), 'utf8')).toBe('new session');
    expect(branches()).toContain(branch);
    expect(existsSync(markerPath())).toBe(true);
  });

  it('refuses a recorded sibling folder replaced by a directory link', () => {
    trackedFile();
    const options = mergedOptions();
    const tomb = interruptRemoval(options);
    const saved = join(fixture.root, 'saved');
    renameSync(tomb, saved);
    symlinkSync(saved, tomb, process.platform === 'win32' ? 'junction' : 'dir');
    const pointer = readFileSync(join(saved, '.git'), 'utf8');
    for (const dryRun of [true, false]) {
      expect(() => removeWorktree({ ...options, dryRun })).toThrow(/Refusing linked/);
      expect(readFileSync(join(saved, '.git'), 'utf8')).toBe(pointer);
      expect(branches()).toContain(branch);
    }
  });

  it('refuses a recovery marker whose sibling folder points outside the original parent', () => {
    trackedFile();
    const options = mergedOptions();
    const tomb = interruptRemoval(options);
    const marker = JSON.parse(readFileSync(markerPath(), 'utf8')) as { tomb: string };
    marker.tomb = join(repo, 'private');
    writeFileSync(markerPath(), JSON.stringify(marker));
    for (const dryRun of [true, false]) {
      expect(() => removeWorktree({ ...options, dryRun })).toThrow(/unreadable or ambiguous/);
      expect(existsSync(tomb)).toBe(true);
      expect(branches()).toContain(branch);
    }
  });

  it('finishes a legacy empty recorded folder after its registration was pruned', () => {
    const options = mergedOptions();
    const head = git(wt, 'rev-parse', 'HEAD').trim();
    mkdirSync(join(repo, '.git/atlas-worktree-removal'));
    writeFileSync(markerPath(), JSON.stringify({ worktree: wt, head }));
    for (const name of readdirSync(wt)) rmSync(join(wt, name), { recursive: true, force: true });
    git(repo, 'worktree', 'prune', '--expire=now');
    expect(removeWorktree({ ...options, dryRun: true })).toMatchObject({
      resumed: true,
      removedWorktree: true,
    });
    expect(existsSync(wt)).toBe(true);
    expect(removeWorktree(options)).toMatchObject({ resumed: true, deletedBranch: true });
    expect(existsSync(wt)).toBe(false);
    expect(branches()).toEqual(['main']);
    expect(existsSync(markerPath())).toBe(false);
  });
});
