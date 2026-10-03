import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
    });
    expect(readdirSync(folder).sort()).toEqual(['handoff.md', 'report.json']);
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
