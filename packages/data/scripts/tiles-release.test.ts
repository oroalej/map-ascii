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
});
