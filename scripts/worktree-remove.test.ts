import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseWorktreeRemoveArgs } from './worktree-remove';

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
