import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cacheAnswers, lagging, onlyRelation, overpass, type OverpassResponse } from './overpass';

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

/**
 * Await an `overpass()` call under fake timers. Its file reads are real I/O, so a retry's timer is
 * set a moment later: step the clock until the call settles.
 */
async function settle<T>(call: Promise<T>): Promise<T> {
  let settled = false;
  const result = call.finally(() => (settled = true));
  result.catch(() => {});
  while (!settled) {
    await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(10_000);
  }
  return result;
}

describe('lagging', () => {
  const at = (timestamp_osm_base: string) => ({ elements: [], osm3s: { timestamp_osm_base } });
  const received = Date.parse('2026-10-07T12:00:00Z');

  it('flags a response more than two days behind OSM when it was received', () => {
    expect(lagging(at('2026-07-24T11:04:51Z'), received)).toBe(
      'server had OSM data from 2026-07-24',
    );
    expect(lagging(at('2026-10-07T11:55:00Z'), received)).toBeUndefined();
    expect(lagging(at('2026-10-06T12:00:00Z'), received)).toBeUndefined();
  });

  it('accepts a response that does not say how current it is', () => {
    expect(lagging({ elements: [] }, received)).toBeUndefined();
  });
});

describe('overpass', () => {
  const boundary = { type: 'relation', id: 3084673, tags: { name: 'Naga City' } };
  const empty: OverpassResponse = { elements: [] };
  const hasBoundary = (data: OverpassResponse) =>
    void onlyRelation(data, 'Boundary', { name: 'Naga City' });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('retries an answer that fails its check on the next server, and saves only a usable one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const answer = { elements: [boundary] };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(empty)))
      .mockResolvedValueOnce(new Response(JSON.stringify(answer)));
    vi.stubGlobal('fetch', fetch);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const dir = await mkdtemp(join(tmpdir(), 'atlas-overpass-'));
    try {
      const file = join(dir, 'boundary.osm.json');
      const result = await settle(overpass(city, file, { offline: false }, hasBoundary));
      expect(result).toEqual(answer);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch.mock.calls[0]![0]).not.toBe(fetch.mock.calls[1]![0]);
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(answer);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('retries an answer from a lagging server on the next one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const stale = { ...empty, osm3s: { timestamp_osm_base: '2026-06-01T08:52:28Z' } };
    const fresh = { ...empty, osm3s: { timestamp_osm_base: new Date().toISOString() } };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(stale)))
      .mockResolvedValueOnce(new Response(JSON.stringify(fresh)));
    vi.stubGlobal('fetch', fetch);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const dir = await mkdtemp(join(tmpdir(), 'atlas-overpass-'));
    try {
      const file = join(dir, 'detail.osm.json');
      expect(await settle(overpass(city, file, { offline: false }))).toEqual(fresh);
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('downloads a saved answer that was lagging when saved again, but uses it offline', async () => {
    const stale = { ...empty, osm3s: { timestamp_osm_base: '2026-07-24T11:04:51Z' } };
    const fresh = { ...empty, osm3s: { timestamp_osm_base: new Date().toISOString() } };
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(fresh)));
    vi.stubGlobal('fetch', fetch);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const dir = await mkdtemp(join(tmpdir(), 'atlas-overpass-'));
    try {
      const file = join(dir, 'detail.osm.json');
      await writeFile(file, JSON.stringify(stale));
      await writeFile(`${file}.query`, city);
      expect(await overpass(city, file, { offline: true })).toEqual(stale);
      expect(fetch).not.toHaveBeenCalled();
      expect(await overpass(city, file, { offline: false })).toEqual(fresh);
      expect(fetch).toHaveBeenCalledTimes(1);
      // A download saved while the server was current is kept, however old.
      const saved = new Date('2026-07-24T12:00:00Z');
      await writeFile(file, JSON.stringify(stale));
      await utimes(file, saved, saved);
      expect(await overpass(city, file, { offline: false })).toEqual(stale);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('downloads a saved answer that fails its check again, and rejects it offline', async () => {
    const answer = { elements: [boundary] };
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(answer)));
    vi.stubGlobal('fetch', fetch);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const dir = await mkdtemp(join(tmpdir(), 'atlas-overpass-'));
    try {
      const file = join(dir, 'boundary.osm.json');
      await writeFile(file, JSON.stringify(empty));
      await writeFile(`${file}.query`, city);
      await expect(overpass(city, file, { offline: true }, hasBoundary)).rejects.toThrow(
        /--offline: Boundary lookup must match exactly one relation, got 0/,
      );
      expect(fetch).not.toHaveBeenCalled();
      expect(await overpass(city, file, { offline: false }, hasBoundary)).toEqual(answer);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(answer);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
      expect(await settle(overpass(city, file, { offline: false }))).toEqual(answer);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch.mock.calls[0]![0]).not.toBe(fetch.mock.calls[1]![0]);
      expect(await readFile(`${file}.query`, 'utf8')).toBe(city);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
