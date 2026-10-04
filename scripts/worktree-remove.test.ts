import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatRemovalResult, parseWorktreeRemoveArgs } from './worktree-remove';

describe('worktree:remove arguments', () => {
  it.each(
    [
      ['--dryrun'],
      ['-h'],
      ['--dry-run'],
      ['codex/topic', 'extra'],
      ['--dry-run=true', 'codex/topic'],
      ['codex/topic', '--head'],
    ].map((args) => ({ args })),
  )('rejects malformed arguments $args', ({ args }) => {
    expect(() => parseWorktreeRemoveArgs(args)).toThrow();
  });

  it('parses a branch, a pinned head and dry-run', () => {
    expect(parseWorktreeRemoveArgs(['--', 'codex/topic', '--head', 'abc123', '--dry-run'])).toEqual(
      {
        branch: 'codex/topic',
        expectedHead: 'abc123',
        dryRun: true,
      },
    );
  });

  it('defaults to an unpinned actual removal', () => {
    expect(parseWorktreeRemoveArgs(['codex/topic'])).toEqual({
      branch: 'codex/topic',
      expectedHead: undefined,
      dryRun: false,
    });
  });

  it('exits 2 on malformed arguments before fetching', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        fileURLToPath(new URL('./worktree-remove.ts', import.meta.url)),
        '--dryrun',
      ],
      { cwd: tmpdir(), encoding: 'utf8' },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage: pnpm worktree:remove');
    expect(result.stderr).not.toContain('fatal:');
    expect(result.stdout).not.toContain('already removed');
  });
});

describe('worktree:remove output consumed by merge-pr', () => {
  it.each([true, false])('pins resumed-removal output (dry-run: %s)', (dryRun) => {
    expect(
      formatRemovalResult('codex/topic', dryRun, {
        worktree: '/repo-topic',
        removedWorktree: true,
        deletedBranch: true,
        resumed: true,
        alreadyRemoved: false,
      }),
    ).toEqual([
      'finishing an interrupted removal',
      `worktree: ${dryRun ? 'would remove' : 'removed'} /repo-topic`,
      `local branch: ${dryRun ? 'would delete' : 'deleted'} codex/topic`,
      'remote branch: kept origin/codex/topic',
    ]);
  });

  it('pins already-removed output', () => {
    expect(
      formatRemovalResult('codex/topic', false, {
        worktree: null,
        removedWorktree: false,
        deletedBranch: false,
        resumed: false,
        alreadyRemoved: true,
      }),
    ).toEqual(['already removed: codex/topic', 'remote branch: kept origin/codex/topic']);
  });
});
