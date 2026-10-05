// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareExport } from './static-export';

let root: string;
const write = async (path: string, text: string) => {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
};
const cachePath = () => join(root, 'apps/web/.next/cache/atlas-export.json');

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'atlas-export-'));
  await write('apps/web/app/page.tsx', 'export default "page";');
  await write('apps/web/next.config.ts', 'export default { output: "export" };');
  await write(
    'apps/web/package.json',
    JSON.stringify({ scripts: { build: 'tsx scripts/build.ts' } }),
  );
  await write('pnpm-lock.yaml', 'lockfileVersion: 9');
});
afterEach(async () => {
  expect(dirname(resolve(root))).toBe(resolve(tmpdir()));
  await rm(root, { recursive: true, force: true });
});

function fixture() {
  const fetchTiles = vi.fn(async () => {});
  const build = vi.fn(async () => {
    await write('apps/web/out/index.html', '<html>exported</html>');
    await write('apps/web/out/_next/static/app.js', 'export const app = true;');
  });
  const log = vi.fn<(message: string) => void>();
  const options = { root, env: {}, build, fetchTiles, log };
  return { ...options, prepare: () => prepareExport(options) };
}

describe('static export reuse', () => {
  it('builds once, then reuses an unchanged export without fetching tiles', async () => {
    const f = fixture();
    expect(await f.prepare()).toBe(true);
    expect(await f.prepare()).toBe(false);
    expect(f.build).toHaveBeenCalledTimes(1);
    expect(f.fetchTiles).toHaveBeenCalledTimes(1);
    expect(f.log).toHaveBeenLastCalledWith('export unchanged; reusing');
  });

  it.each([
    'apps/web/app/page.tsx',
    'apps/web/components/Button.module.css',
    'apps/web/next.config.ts',
    'apps/web/tsconfig.json',
    'apps/web/scripts/static-export.ts',
    'packages/renderer/src/shaders/map.glsl',
    'packages/shared/src/constants.ts',
    'packages/content/src/validate.ts',
    'packages/content/cities/fixture/city.json',
    'apps/web/public/tiles/fixture.pmtiles',
    'tsconfig.base.json',
    'pnpm-lock.yaml',
    '.nvmrc',
  ])('rebuilds for an added, edited, or deleted build input: %s', async (path) => {
    const f = fixture();
    await f.prepare();
    await write(path, 'first');
    expect(await f.prepare()).toBe(true);
    await write(path, 'other');
    expect(await f.prepare()).toBe(true);
    await rm(join(root, path));
    expect(await f.prepare()).toBe(true);
    expect(f.build).toHaveBeenCalledTimes(4);
    expect(f.log).toHaveBeenCalledWith(`rebuilding: ${path}`);
  });

  it('ignores docs, tests, test configuration, caches, reports, and pipeline-only changes', async () => {
    const f = fixture();
    await f.prepare();
    for (const path of [
      'AGENTS.md',
      'docs/SPEC.md',
      'apps/web/AGENTS.md',
      'apps/web/lib/url.test.ts',
      'apps/web/e2e/smoke.spec.ts',
      'apps/web/vitest.config.ts',
      'apps/web/playwright.config.ts',
      'apps/web/.env.test',
      'apps/web/.env.development',
      'apps/web/scripts/test-e2e.ts',
      'apps/web/.next/types/test.ts',
      'apps/web/next-env.d.ts',
      'apps/web/tsconfig.tsbuildinfo',
      'apps/web/test-results/result.json',
      'apps/web/playwright-report/index.html',
      'packages/renderer/src/tiles.test.ts',
      'packages/content/src/__fixtures__/bad/city.json',
      'packages/data/scripts/normalize.ts',
      'packages/data/raw/fixture/map.json',
      'packages/data/build/fixture/merged.json',
    ])
      await write(path, 'changed');
    expect(await f.prepare()).toBe(false);
    expect(f.build).toHaveBeenCalledTimes(1);
  });

  it('ignores timestamp-only changes', async () => {
    const f = fixture();
    await f.prepare();
    await utimes(join(root, 'apps/web/app/page.tsx'), new Date(0), new Date(0));
    expect(await f.prepare()).toBe(false);
  });

  it('ignores test command changes but notices runtime dependency changes', async () => {
    const f = fixture();
    await f.prepare();
    await write(
      'apps/web/package.json',
      JSON.stringify({
        scripts: {
          build: 'tsx scripts/build.ts',
          'test:e2e': 'new test command',
        },
        devDependencies: { '@playwright/test': 'new' },
      }),
    );
    expect(await f.prepare()).toBe(false);
    await write('apps/web/package.json', JSON.stringify({ dependencies: { next: 'new' } }));
    expect(await f.prepare()).toBe(true);
  });

  it('tracks build environment values but ignores test ports, filters, and credentials', async () => {
    await write('apps/web/app/env.ts', "export const endpoint = process.env['CUSTOM_ENDPOINT'];");
    const f = fixture();
    await f.prepare();
    expect(await prepareExport({ ...f, env: { E2E_PORT: '1234', GITHUB_TOKEN: 'secret' } })).toBe(
      false,
    );
    expect(await prepareExport({ ...f, env: { CUSTOM_ENDPOINT: 'changed' } })).toBe(true);
    expect(
      await prepareExport({
        ...f,
        env: { CUSTOM_ENDPOINT: 'changed', NEXT_PUBLIC_LABEL: 'label' },
      }),
    ).toBe(true);
    const manifest = await readFile(cachePath(), 'utf8');
    expect(manifest).not.toContain('secret');
    expect(manifest).not.toContain('label');
  });

  it('records downloaded assets after fetching, avoiding a second unnecessary build', async () => {
    const f = fixture();
    f.fetchTiles.mockImplementation(() =>
      write('apps/web/public/tiles/fixture.pmtiles', 'downloaded'),
    );
    await f.prepare();
    expect(await f.prepare()).toBe(false);
  });

  it.each(['missing', 'corrupt'])('rebuilds when exported output is %s', async (kind) => {
    const f = fixture();
    await f.prepare();
    if (kind === 'missing') await rm(join(root, 'apps/web/out/_next/static/app.js'));
    else await write('apps/web/out/index.html', 'corrupted');
    expect(await f.prepare()).toBe(true);
  });

  it('rebuilds when the cache entry is invalid and supports a forced rebuild', async () => {
    const f = fixture();
    await f.prepare();
    await writeFile(cachePath(), '{invalid');
    expect(await f.prepare()).toBe(true);
    expect(await prepareExport({ ...f, force: true })).toBe(true);
    expect(f.build).toHaveBeenCalledTimes(3);
  });

  it('invalidates the old success entry before a failing build and retries next time', async () => {
    const f = fixture();
    await f.prepare();
    f.build.mockImplementationOnce(async () => {
      await expect(readFile(cachePath())).rejects.toMatchObject({ code: 'ENOENT' });
      throw new Error('failed build');
    });
    await expect(prepareExport({ ...f, force: true })).rejects.toThrow('failed build');
    await expect(readFile(cachePath())).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await f.prepare()).toBe(true);
  });

  it('does not cache incomplete output, or an export whose sources changed during the build', async () => {
    const f = fixture();
    f.build.mockImplementationOnce(async () => {
      await write('apps/web/out/index.html', '<html>partial</html>');
    });
    await expect(f.prepare()).rejects.toThrow('incomplete');
    await expect(readFile(cachePath())).rejects.toMatchObject({ code: 'ENOENT' });
    const original = f.build.getMockImplementation()!;
    f.build.mockImplementationOnce(async () => {
      await original();
      await write('apps/web/app/page.tsx', 'concurrent edit');
    });
    expect(await f.prepare()).toBe(true);
    expect(f.log).toHaveBeenLastCalledWith(expect.stringContaining('changed during export'));
    await expect(readFile(cachePath())).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await f.prepare()).toBe(true);
  });

  it('serializes concurrent preparation and lets the waiting caller reuse the finished export', async () => {
    const f = fixture();
    let started!: () => void;
    let finish!: () => void;
    const building = new Promise<void>((resolve) => {
      started = resolve;
    });
    const proceed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const original = f.build.getMockImplementation()!;
    f.build.mockImplementationOnce(async () => {
      started();
      await proceed;
      await original();
    });
    const first = f.prepare();
    await building;
    const second = f.prepare();
    finish();
    expect(await Promise.all([first, second])).toEqual([true, false]);
    expect(f.build).toHaveBeenCalledTimes(1);
  });

  it('recovers a lock left by a process that has exited', async () => {
    const f = fixture();
    await mkdir(join(root, 'apps/web/.next/cache'), { recursive: true });
    await write(
      'apps/web/.next/cache/atlas-export.lock',
      JSON.stringify({ pid: 2_147_483_647, token: 'old' }),
    );
    // Either simultaneous caller can reclaim the stale lock; exactly one builds.
    expect((await Promise.all([f.prepare(), f.prepare()])).sort()).toEqual([false, true]);
    expect(f.build).toHaveBeenCalledTimes(1);
  });
});
