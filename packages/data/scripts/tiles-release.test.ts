import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TilesLock } from '@atlas/shared';
import {
  buildLock,
  compareLocal,
  downloadFiles,
  generatedFiles,
  releaseTag,
  sha256,
} from './lib/tiles-release';

const bytes = (text: string) => new TextEncoder().encode(text);
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tiles-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const lockFor = (files: Record<string, string>): TilesLock => ({
  repo: 'owner/name',
  tag: 'tiles-naga-20260929-1930',
  files: Object.fromEntries(
    Object.entries(files).map(([name, text]) => [name, sha256(bytes(text))]),
  ),
});

describe('publishing', () => {
  it('names releases by city and UTC minute', () => {
    expect(releaseTag('naga', new Date('2026-09-29T19:30:59Z'))).toBe('tiles-naga-20260929-1930');
  });

  it("lists a city's generated files, and locks each by its hash", async () => {
    await writeFile(join(dir, 'naga.pmtiles'), 'tiles');
    await writeFile(join(dir, 'naga.meta.json'), '{}');
    await writeFile(join(dir, 'naga.pmtiles.download'), 'partial');
    await writeFile(join(dir, 'other.pmtiles'), 'x');
    const files = await generatedFiles(dir, 'naga');
    expect(files).toEqual(['naga.meta.json', 'naga.pmtiles']);
    const lock = await buildLock('owner/name', 'tiles-naga-1', dir, files);
    expect(lock.files['naga.pmtiles']).toBe(sha256(bytes('tiles')));
  });
});

describe('fetching', () => {
  it('tells missing, changed, and matching files apart', async () => {
    await writeFile(join(dir, 'naga.meta.json'), '{}');
    await writeFile(join(dir, 'naga.art.json'), 'rebuilt');
    const lock = lockFor({ 'naga.pmtiles': 'tiles', 'naga.meta.json': '{}', 'naga.art.json': 'a' });
    expect(await compareLocal(lock, dir)).toEqual({
      missing: ['naga.pmtiles'],
      differ: ['naga.art.json'],
      match: ['naga.meta.json'],
    });
  });

  it('downloads public assets and checks them against the lock', async () => {
    const lock = lockFor({ 'naga.pmtiles': 'tiles' });
    const fetch = vi.fn(() => Promise.resolve(new Response('tiles')));
    await downloadFiles(lock, ['naga.pmtiles'], dir, { fetch });
    expect(fetch).toHaveBeenCalledWith(
      'https://github.com/owner/name/releases/download/tiles-naga-20260929-1930/naga.pmtiles',
      { headers: {} },
    );
    expect(await readFile(join(dir, 'naga.pmtiles'), 'utf8')).toBe('tiles');
  });

  it('goes through the API with a token (private repositories)', async () => {
    const lock = lockFor({ 'naga.pmtiles': 'tiles' });
    const fetch = vi.fn((url: string) =>
      Promise.resolve(
        url.includes('/releases/tags/')
          ? Response.json({ assets: [{ name: 'naga.pmtiles', url: 'https://api/asset/1' }] })
          : new Response('tiles'),
      ),
    );
    await downloadFiles(lock, ['naga.pmtiles'], dir, { fetch, token: 't0k' });
    expect(fetch).toHaveBeenLastCalledWith('https://api/asset/1', {
      headers: expect.objectContaining({
        Authorization: 'Bearer t0k',
        Accept: 'application/octet-stream',
      }) as Record<string, string>,
    });
  });

  it('refuses a download whose hash is wrong, leaving the old file', async () => {
    await writeFile(join(dir, 'naga.pmtiles'), 'old');
    const lock = lockFor({ 'naga.pmtiles': 'tiles' });
    const fetch = vi.fn(() => Promise.resolve(new Response('tampered')));
    await expect(downloadFiles(lock, ['naga.pmtiles'], dir, { fetch })).rejects.toThrow(
      /does not match the lock/,
    );
    expect(await readFile(join(dir, 'naga.pmtiles'), 'utf8')).toBe('old');
  });

  it('hints at a token when a public download is not found', async () => {
    const lock = lockFor({ 'naga.pmtiles': 'tiles' });
    const fetch = vi.fn(() => Promise.resolve(new Response('nope', { status: 404 })));
    await expect(downloadFiles(lock, ['naga.pmtiles'], dir, { fetch })).rejects.toThrow(
      /set GITHUB_TOKEN/,
    );
  });

  describe('after a failure', () => {
    const lock = lockFor({ 'naga.pmtiles': 'tiles' });
    const wait = vi.fn((_ms: number) => Promise.resolve());
    const status = (code: number) => new Response('nope', { status: code });

    beforeEach(() => {
      wait.mockClear();
      vi.spyOn(console, 'log').mockImplementation(() => {});
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('retries a 504 and keeps the download that follows', async () => {
      const fetch = vi
        .fn<() => Promise<Response>>()
        .mockResolvedValueOnce(status(504))
        .mockResolvedValueOnce(new Response('tiles'));
      await downloadFiles(lock, ['naga.pmtiles'], dir, { fetch, wait });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(wait).toHaveBeenCalledTimes(1);
      expect(await readFile(join(dir, 'naga.pmtiles'), 'utf8')).toBe('tiles');
    });

    it('gives up with the original error, backing off, when every attempt is a 504', async () => {
      const fetch = vi.fn(() => Promise.resolve(status(504)));
      await expect(downloadFiles(lock, ['naga.pmtiles'], dir, { fetch, wait })).rejects.toThrow(
        /^naga\.pmtiles: HTTP 504$/,
      );
      expect(fetch).toHaveBeenCalledTimes(4);
      const delays = wait.mock.calls.map(([ms]) => ms);
      expect(delays).toHaveLength(3);
      expect(delays).toEqual([...delays].sort((a, b) => a - b));
    });

    it('fails at once on a 404, keeping the hint', async () => {
      const fetch = vi.fn(() => Promise.resolve(status(404)));
      await expect(downloadFiles(lock, ['naga.pmtiles'], dir, { fetch, wait })).rejects.toThrow(
        /^naga\.pmtiles: HTTP 404 \(private repository\? set GITHUB_TOKEN\)$/,
      );
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(wait).not.toHaveBeenCalled();
    });

    it('retries a dropped connection, and one dropped while reading the body', async () => {
      const dropped = new Response('tiles');
      vi.spyOn(dropped, 'arrayBuffer').mockRejectedValue(new TypeError('terminated'));
      const fetch = vi
        .fn<() => Promise<Response>>()
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(dropped)
        .mockResolvedValueOnce(new Response('tiles'));
      await downloadFiles(lock, ['naga.pmtiles'], dir, { fetch, wait });
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(await readFile(join(dir, 'naga.pmtiles'), 'utf8')).toBe('tiles');
    });

    it('does not retry a download whose hash is wrong', async () => {
      const fetch = vi.fn(() => Promise.resolve(new Response('tampered')));
      await expect(downloadFiles(lock, ['naga.pmtiles'], dir, { fetch, wait })).rejects.toThrow(
        /does not match the lock/,
      );
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('retries the release lookup on a 502, but not on a 404', async () => {
      const release = () =>
        Response.json({ assets: [{ name: 'naga.pmtiles', url: 'https://api/asset/1' }] });
      const flaky = vi
        .fn<() => Promise<Response>>()
        .mockResolvedValueOnce(status(502))
        .mockResolvedValueOnce(release())
        .mockResolvedValueOnce(new Response('tiles'));
      await downloadFiles(lock, ['naga.pmtiles'], dir, { fetch: flaky, token: 't0k', wait });
      expect(flaky).toHaveBeenCalledTimes(3);

      const missing = vi.fn(() => Promise.resolve(status(404)));
      await expect(
        downloadFiles(lock, ['naga.pmtiles'], dir, { fetch: missing, token: 't0k', wait }),
      ).rejects.toThrow(/^release tiles-naga-20260929-1930 in owner\/name: HTTP 404$/);
      expect(missing).toHaveBeenCalledTimes(1);
    });
  });
});
