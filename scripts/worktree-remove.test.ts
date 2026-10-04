import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('worktree:remove arguments', () => {
  it.each([
    ['--dryrun'],
    ['-h'],
    ['--dry-run'],
    ['codex/topic', 'extra'],
    ['--dry-run=true', 'codex/topic'],
  ])('rejects malformed arguments %j before fetching', (...args) => {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        fileURLToPath(new URL('./worktree-remove.ts', import.meta.url)),
        ...args,
      ],
      { cwd: tmpdir(), encoding: 'utf8' },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage: pnpm worktree:remove');
    expect(result.stderr).not.toContain('fatal:');
    expect(result.stdout).not.toContain('already removed');
  });
});
