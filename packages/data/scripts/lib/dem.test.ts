import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { demTileName, downloadDem } from './dem';

describe('downloadDem', () => {
  afterEach(() => vi.unstubAllGlobals());

  it("copies another checkout's tiles and ocean markers instead of downloading them", async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const dir = await mkdtemp(join(tmpdir(), 'atlas-dem-'));
    try {
      const main = join(dir, 'main');
      await mkdir(main);
      await writeFile(join(main, `${demTileName(123, 13)}.tif`), 'tile');
      await writeFile(join(main, `${demTileName(124, 13)}.missing`), '');
      const here = join(dir, 'here');
      const found = await downloadDem([123.2, 13.1, 124.5, 13.9], here, {
        offline: true,
        copies: (file) => [join(main, basename(file))],
      });
      expect(found).toEqual([join(here, `${demTileName(123, 13)}.tif`)]);
      expect((await readdir(here)).sort()).toEqual(
        [`${demTileName(123, 13)}.tif`, `${demTileName(124, 13)}.missing`].sort(),
      );
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
