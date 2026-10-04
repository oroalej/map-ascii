import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parsePlansCleanArgs } from './plans-clean';

describe('plans:clean arguments', () => {
  it('parses repeated keeps and dry-run', () => {
    expect(
      parsePlansCleanArgs([
        '--',
        'labels',
        '--keep',
        'logs/final.json',
        '--keep=archive',
        '--dry-run',
      ]),
    ).toEqual({ task: 'labels', keep: ['logs/final.json', 'archive'], dryRun: true });
  });

  it('defaults to no explicit keeps and actual cleanup', () => {
    expect(parsePlansCleanArgs(['labels'])).toEqual({ task: 'labels', keep: [], dryRun: false });
  });

  it.each(
    [
      ['-h'],
      ['--dryrun', 'labels'],
      ['labels', '--keep'],
      [],
      ['first', 'second'],
      ['--dry-run'],
      ['labels', '--keep', '--dry-run'],
      ['labels', '--dry-run=true'],
    ].map((args) => ({ args })),
  )('rejects malformed arguments $args', ({ args }) => {
    expect(() => parsePlansCleanArgs(args)).toThrow();
  });

  it('exits 2 on an unsupported option before repository discovery', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        fileURLToPath(new URL('./plans-clean.ts', import.meta.url)),
        '-h',
      ],
      { cwd: tmpdir(), encoding: 'utf8' },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage: pnpm plans:clean');
    expect(result.stderr).not.toContain('fatal:');
    expect(result.stdout).toBe('');
  });
});
