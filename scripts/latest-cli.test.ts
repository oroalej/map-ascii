import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  codexVendorBinaries,
  compareVersions,
  parseVersion,
  pickLatest,
  type Probe,
} from './latest-cli';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));

const v = (text: string) => parseVersion(text)!;
const probe = (file: string, text: string): Probe => ({ path: file, version: v(text), raw: text });

describe('parseVersion', () => {
  it('reads codex and claude version output', () => {
    expect(v('codex-cli 0.155.0-alpha.9.2')).toEqual({
      core: [0, 155, 0],
      pre: ['alpha', '9', '2'],
    });
    expect(v('2.1.289 (Claude Code)')).toEqual({ core: [2, 1, 289], pre: [] });
    expect(parseVersion('codex')).toBeUndefined();
  });
});

describe('compareVersions', () => {
  it('orders by semver precedence', () => {
    const sorted = ['0.146.0', '0.155.0-alpha.9.2', '0.153.4', '0.159.3', '0.130.0-alpha.5']
      .map(v)
      .sort((a, b) => compareVersions(b, a));
    expect(
      sorted.map((x) => x.core.join('.') + (x.pre.length ? `-${x.pre.join('.')}` : '')),
    ).toEqual(['0.159.3', '0.155.0-alpha.9.2', '0.153.4', '0.146.0', '0.130.0-alpha.5']);
  });

  it('ranks a release above its prereleases', () => {
    expect(compareVersions(v('1.0.0'), v('1.0.0-rc.1'))).toBeGreaterThan(0);
    expect(compareVersions(v('1.0.0-alpha.10'), v('1.0.0-alpha.9'))).toBeGreaterThan(0);
    expect(compareVersions(v('1.0.0-beta'), v('1.0.0-alpha.9'))).toBeGreaterThan(0);
    expect(compareVersions(v('1.0.0-alpha'), v('1.0.0-alpha.1'))).toBeLessThan(0);
  });
});

describe('pickLatest', () => {
  it('picks the highest version, ties going to the earlier candidate', () => {
    const latest = pickLatest([
      probe('a', 'codex-cli 0.146.0'),
      probe('b', 'codex-cli 0.159.3'),
      probe('c', 'codex-cli 0.159.3'),
      probe('d', 'codex-cli 0.155.0-alpha.9.2'),
    ]);
    expect(latest?.path).toBe('b');
    expect(pickLatest([])).toBeUndefined();
  });
});

describe('codexVendorBinaries', () => {
  let root: string | undefined;
  afterEach(() => root && rmSync(root, { recursive: true, force: true }));

  it('finds vendored binaries and skips interrupted-install folders', () => {
    root = mkdtempSync(path.join(tmpdir(), 'latest-cli-'));
    const exe = process.platform === 'win32' ? 'codex.exe' : 'codex';
    const place = (...parts: string[]) => {
      const file = path.join(root!, ...parts);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, '');
      return file;
    };
    const vendored = place(
      '@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin',
      exe,
    );
    place('@openai/.codex-A8Sv2Ekj/node_modules/@openai/codex-win32-x64/vendor/t/bin', exe);
    place('@openai/codex/node_modules/@openai/.codex-tmp/vendor/t/bin', exe);
    mkdirSync(path.join(root, '@openai/codex/node_modules/@openai/codex-linux-x64/vendor/t/bin'), {
      recursive: true,
    });

    expect(codexVendorBinaries(root)).toEqual([vendored]);
    expect(codexVendorBinaries(path.join(root, 'missing'))).toEqual([]);
  });
});

describe('CLI output', () => {
  let root: string | undefined;
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(spawnSync).mockReset();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it.each([
    ['codex', 'codex-cli 0.159.3', '0.159.3'],
    ['codex', 'codex-cli 0.155.0-alpha.9.2', '0.155.0-alpha.9.2'],
    ['claude', '2.1.289 (Claude Code)', '2.1.289'],
    ['claude', '2.2.0-rc.1 (Claude Code)', '2.2.0-rc.1'],
  ])(
    'prints only the %s path on stdout and normalizes %s on stderr',
    async (tool, raw, version) => {
      root = mkdtempSync(path.join(tmpdir(), 'latest-cli-'));
      const file = path.join(
        root,
        'Program Files',
        `${tool}${process.platform === 'win32' ? '.exe' : ''}`,
      );
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, '');
      vi.mocked(spawnSync).mockImplementation((command): SpawnSyncReturns<string> => {
        const stdout =
          command === 'where.exe' || command === 'which'
            ? `${file}\n`
            : command === file
              ? raw
              : '';
        return {
          pid: 0,
          status: stdout ? 0 : 1,
          signal: null,
          stdout,
          stderr: '',
          output: [null, stdout, ''],
        };
      });
      const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
      const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
      const originalArgv = process.argv;
      try {
        vi.resetModules();
        process.argv = [originalArgv[0]!, path.resolve('scripts/latest-cli.ts'), tool];
        await import('./latest-cli');
      } finally {
        process.argv = originalArgv;
      }

      expect(stdout.mock.calls).toEqual([[file]]);
      expect(stderr.mock.calls).toEqual([[`${tool} ${version} ${file}`]]);
      expect(spawnSync).toHaveBeenCalledWith(file, ['--version'], {
        encoding: 'utf8',
        timeout: 15_000,
      });
      const npmCalls = vi
        .mocked(spawnSync)
        .mock.calls.filter(([command]) => command === 'npm root -g');
      expect(npmCalls).toHaveLength(tool === 'codex' ? 1 : 0);
    },
  );
});
