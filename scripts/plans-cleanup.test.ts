import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type * as NodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanTask } from './plans-cleanup';

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof NodeFs>();
  return { ...fs, rmSync: vi.fn(fs.rmSync) };
});

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'plans-cleanup-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Creates `<root>/<status>/<task>/` with the given files (nested paths allowed). */
function task(status: string, name: string, files: string[]): string {
  const folder = join(root, status, name);
  for (const file of files) {
    mkdirSync(join(folder, file, '..'), { recursive: true });
    writeFileSync(join(folder, file), 'x');
  }
  return folder;
}

describe('cleanTask', () => {
  it.runIf(process.platform === 'win32')(
    'preserves the actual spelling of Windows keep paths and handoff',
    () => {
      const folder = task('done', 'case-keeps', [
        'Handoff.md',
        'Notes.md',
        'logs/final.txt',
        'scratch.txt',
      ]);
      const preview = cleanTask(root, 'case-keeps', ['notes.md', 'LOGS/FINAL.txt'], true);
      expect(preview.kept).toEqual(['Handoff.md', 'Notes.md', 'logs/final.txt']);
      expect(cleanTask(root, 'case-keeps', ['notes.md', 'LOGS/FINAL.txt'])).toEqual(preview);
      expect(readdirSync(folder).sort()).toEqual(['Handoff.md', 'Notes.md', 'logs']);
      const handoffOnly = task('done', 'handoff-only', ['Handoff.md']);
      expect(cleanTask(root, 'handoff-only').removedFolder).toBe(false);
      expect(existsSync(join(handoffOnly, 'Handoff.md'))).toBe(true);
    },
  );

  it.runIf(process.platform !== 'win32')(
    'keeps distinct casing on case-sensitive filesystems',
    () => {
      const folder = task('done', 'case-keeps', ['handoff.md', 'Notes.md', 'notes.md']);
      expect(cleanTask(root, 'case-keeps', ['Notes.md']).kept).toEqual(['Notes.md', 'handoff.md']);
      expect(existsSync(join(folder, 'notes.md'))).toBe(false);
    },
  );

  it('refuses a linked status folder without deleting its target', () => {
    const plansRoot = join(root, 'plans');
    mkdirSync(plansRoot);
    const outside = join(root, 'outside');
    mkdirSync(join(outside, 'labels'), { recursive: true });
    writeFileSync(join(outside, 'labels', 'scratch.txt'), 'x');
    symlinkSync(outside, join(plansRoot, 'done'), 'junction');
    expect(() => cleanTask(plansRoot, 'labels')).toThrow(/resolves outside/);
    expect(existsSync(join(outside, 'labels', 'scratch.txt'))).toBe(true);
  });

  it('rejects linked and non-directory keep parents before deleting scratch', () => {
    const folder = task('active', 'parents', ['handoff.md', 'scratch.txt', 'file']);
    const outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'report.txt'), 'x');
    symlinkSync(outside, join(folder, 'linked'), 'junction');
    expect(() => cleanTask(root, 'parents', ['linked/report.txt'])).toThrow(/Keep path folder/);
    expect(() => cleanTask(root, 'parents', ['file/report.txt'])).toThrow(/Keep path folder/);
    expect(existsSync(join(folder, 'scratch.txt'))).toBe(true);
    expect(existsSync(join(outside, 'report.txt'))).toBe(true);
  });

  it('reports a busy scratch file and preserves kept files for a retry', () => {
    const folder = task('active', 'busy', ['handoff.md', 'report.txt', 'scratch.txt']);
    vi.mocked(rmSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('resource busy'), { code: 'EBUSY' });
    });
    expect(() => cleanTask(root, 'busy', ['report.txt'])).toThrow(
      /Partially cleaned.*Close it and rerun/,
    );
    expect(existsSync(join(folder, 'handoff.md'))).toBe(true);
    expect(existsSync(join(folder, 'report.txt'))).toBe(true);
    expect(cleanTask(root, 'busy', ['report.txt']).deleted).toEqual(['scratch.txt']);
  });

  it('deletes scratch files and folders, keeping handoff.md and keep entries', () => {
    const folder = task('paused', 'labels', [
      'handoff.md',
      'report.json',
      'log.txt',
      'e2e-results/run/trace.zip',
    ]);
    const result = cleanTask(root, 'labels', ['report.json']);
    expect(result).toEqual({
      folder,
      deleted: ['e2e-results', 'log.txt'],
      kept: ['handoff.md', 'report.json'],
      removedFolder: false,
    });
    expect(readdirSync(folder).sort()).toEqual(['handoff.md', 'report.json']);
  });

  it('keeps nested paths while deleting their siblings', () => {
    const folder = task('done', 'labels', [
      'handoff.md',
      'e2e-results/final/shot.png',
      'e2e-results/final/trace.zip',
      'e2e-results/first.png',
    ]);
    const result = cleanTask(root, 'labels', ['e2e-results\\final\\shot.png']);
    expect(result.deleted).toEqual(['e2e-results/final/trace.zip', 'e2e-results/first.png']);
    expect(result.kept).toEqual(['e2e-results/final/shot.png', 'handoff.md']);
    expect(readdirSync(join(folder, 'e2e-results', 'final'))).toEqual(['shot.png']);
  });

  it('rejects keep paths that leave the task folder', () => {
    const folder = task('done', 'labels', ['handoff.md', 'log.txt']);
    expect(() => cleanTask(root, 'labels', ['../labels/log.txt'])).toThrow(/Invalid keep path/);
    expect(() => cleanTask(root, 'labels', [join(folder, 'log.txt')])).toThrow(/Invalid keep path/);
    expect(readdirSync(folder).sort()).toEqual(['handoff.md', 'log.txt']);
  });

  it('refuses a linked task folder and never follows links inside one', () => {
    const outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'precious.txt'), 'x');
    mkdirSync(join(root, 'done'));
    symlinkSync(outside, join(root, 'done', 'linked'), 'junction');
    expect(() => cleanTask(root, 'linked')).toThrow(/linked task folder/);

    const folder = task('done', 'labels', ['handoff.md']);
    symlinkSync(outside, join(folder, 'link'), 'junction');
    expect(cleanTask(root, 'labels').deleted).toEqual(['link']);
    expect(existsSync(join(folder, 'link'))).toBe(false);
    expect(readdirSync(outside)).toEqual(['precious.txt']);
  });

  it('removes a folder that keeps nothing, such as review scratch', () => {
    task('active', 'pr8-review-fixes', ['claude-review.md', 'round1/result.json']);
    const result = cleanTask(root, 'pr8-review-fixes');
    expect(result.deleted).toEqual(['claude-review.md', 'round1']);
    expect(result.removedFolder).toBe(true);
    expect(readdirSync(join(root, 'active'))).toEqual([]);
  });

  it('changes nothing on a dry run', () => {
    const folder = task('done', 'labels', ['handoff.md', 'log.txt']);
    expect(cleanTask(root, 'labels', [], true).deleted).toEqual(['log.txt']);
    expect(readdirSync(folder).sort()).toEqual(['handoff.md', 'log.txt']);
  });

  it('rejects a task name that could leave the plans folder', () => {
    task('done', 'labels', ['handoff.md']);
    expect(() => cleanTask(root, '../labels')).toThrow(/Invalid task/);
    expect(() => cleanTask(root, 'done/labels')).toThrow(/Invalid task/);
  });

  it('fails on a missing task, a task in two statuses, or an unknown keep entry', () => {
    expect(() => cleanTask(root, 'labels')).toThrow(/No task folder/);
    task('active', 'labels', ['handoff.md']);
    task('done', 'labels', ['handoff.md']);
    expect(() => cleanTask(root, 'labels')).toThrow(/several statuses/);
    task('todo', 'roads', ['handoff.md', 'log.txt']);
    expect(() => cleanTask(root, 'roads', ['typo.json'])).toThrow(/typo\.json/);
    expect(readdirSync(join(root, 'todo', 'roads')).sort()).toEqual(['handoff.md', 'log.txt']);
  });
});
