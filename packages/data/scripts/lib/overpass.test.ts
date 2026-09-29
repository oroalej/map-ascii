import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cacheAnswers, overpass } from './overpass';

const q = (bbox: string, filter = 'way["highway"];') =>
  `[out:json][timeout:300][bbox:${bbox}];\n${filter}\nout body;`;
const city = q('13.5,123.1,13.7,123.4');
const downtown = q('13.602,123.17,13.64,123.213');

describe('cacheAnswers', () => {
  const online = { offline: false };

  it('keeps a saved download for the same query, however old', () => {
    expect(cacheAnswers(city, city, online)).toBe(true);
  });

  it('answers a smaller bbox from a saved larger one with the same filters', () => {
    expect(cacheAnswers(city, downtown, online)).toBe(true);
  });

  it('downloads when the bbox reaches outside the saved one, or the filters changed', () => {
    expect(cacheAnswers(downtown, city, online)).toBe(false);
    expect(cacheAnswers(city, q('13.602,123.17,13.64,123.213', 'way["building"];'), online)).toBe(
      false,
    );
    expect(cacheAnswers('rel(1);\nout;', 'rel(2);\nout;', online)).toBe(false);
    expect(cacheAnswers(undefined, city, online)).toBe(false);
  });

  it('downloads again on refresh', () => {
    expect(cacheAnswers(city, city, { offline: false, refresh: true })).toBe(false);
  });

  it('always uses the saved download offline', () => {
    expect(cacheAnswers('old', city, { offline: true })).toBe(true);
  });
});

describe('overpass', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('retries a dropped connection, on the next server, and saves the answer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const dropped = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNRESET' },
    });
    const answer = { elements: [{ type: 'way', id: 1 }] };
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(dropped)
      .mockResolvedValueOnce(new Response(JSON.stringify(answer)));
    vi.stubGlobal('fetch', fetch);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const dir = await mkdtemp(join(tmpdir(), 'atlas-overpass-'));
    try {
      const file = join(dir, 'rail.osm.json');
      let settled = false;
      const result = overpass(city, file, { offline: false }).finally(() => (settled = true));
      // Its file reads are real I/O, so the retry's timer is set a moment later: step the
      // clock until the call settles.
      while (!settled) {
        await new Promise((resolve) => setImmediate(resolve));
        await vi.advanceTimersByTimeAsync(10_000);
      }
      expect(await result).toEqual(answer);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch.mock.calls[0]![0]).not.toBe(fetch.mock.calls[1]![0]);
      expect(await readFile(`${file}.query`, 'utf8')).toBe(city);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
