import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanTask } from './plans-cleanup';

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
