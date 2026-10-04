import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  codexVendorBinaries,
  compareVersions,
  parseVersion,
  pickLatest,
  type Probe,
} from './latest-cli';

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
