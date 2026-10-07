import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { copiesElsewhere, worktreePaths } from './checkouts';

describe('worktreePaths', () => {
  it('lists every worktree, the main checkout first', () => {
    const porcelain = [
      'worktree D:/Projects/naga-ascii',
      'HEAD 6645425',
      'branch refs/heads/main',
      '',
      'worktree D:/Projects/naga-ascii/worktrees/extent',
      'HEAD f4bb63c',
      'branch refs/heads/codex/naga-extent',
      '',
    ].join('\r\n');
    expect(worktreePaths(porcelain)).toEqual([
      'D:/Projects/naga-ascii',
      'D:/Projects/naga-ascii/worktrees/extent',
    ]);
  });
});

describe('copiesElsewhere', () => {
  it('maps a download to the same path under other checkouts, never this one', () => {
    const rawRoot = join(import.meta.dirname, '../../raw');
    const file = join(rawRoot, 'naga', 'detail.osm.json');
    for (const copy of copiesElsewhere(rawRoot)(file)) {
      expect(copy.endsWith(join('packages', 'data', 'raw', 'naga', 'detail.osm.json'))).toBe(true);
      expect(copy).not.toBe(file);
    }
  });
});
