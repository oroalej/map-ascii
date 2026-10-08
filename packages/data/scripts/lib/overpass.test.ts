import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cacheAnswers,
  lagging,
  onlyRelation,
  overpass,
  type FetchOptions,
  type OverpassResponse,
} from './overpass';

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

  it('requires metadata, matching filters and coverage in strict offline mode', () => {
    const strict = { offline: true, requireCoverage: true };
    expect(cacheAnswers(undefined, city, strict)).toBe(false);
    expect(cacheAnswers(downtown, city, strict)).toBe(false);
    expect(cacheAnswers(city, downtown, strict)).toBe(true);
    expect(cacheAnswers(city, q('13.602,123.17,13.64,123.213', 'node["place"];'), strict)).toBe(
      false,
    );
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

  it('skips a server that answered with lagging data for the rest of the run', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const stale = { ...empty, osm3s: { timestamp_osm_base: '2026-06-01T08:52:28Z' } };
    const fresh = { ...empty, osm3s: { timestamp_osm_base: new Date().toISOString() } };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(stale)))
      .mockResolvedValueOnce(new Response(JSON.stringify(fresh)))
      .mockResolvedValueOnce(new Response(JSON.stringify(fresh)));
    vi.stubGlobal('fetch', fetch);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // A fresh module, so the servers this test finds lagging stay skipped only here.
    vi.resetModules();
    const { overpass } = await import('./overpass');
    const dir = await mkdtemp(join(tmpdir(), 'atlas-overpass-'));
    try {
      await settle(overpass(city, join(dir, 'a.osm.json'), { offline: false }));
      await settle(overpass(city, join(dir, 'b.osm.json'), { offline: false }));
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(fetch.mock.calls[2]![0]).not.toBe(fetch.mock.calls[0]![0]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('retries an HTTP 500 on the next server and skips the broken one for the rest of the run', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const answer = { elements: [{ type: 'way', id: 1 }] };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('<title>500 Internal Server Error</title>', { status: 500 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(answer)))
      .mockResolvedValueOnce(new Response(JSON.stringify(answer)));
    vi.stubGlobal('fetch', fetch);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // A fresh module, so the server this test finds broken stays skipped only here.
    vi.resetModules();
    const { overpass } = await import('./overpass');
    const dir = await mkdtemp(join(tmpdir(), 'atlas-overpass-'));
    try {
      const file = join(dir, 'a.osm.json');
      expect(await settle(overpass(city, file, { offline: false }))).toEqual(answer);
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(answer);
      await settle(overpass(city, join(dir, 'b.osm.json'), { offline: false }));
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(fetch.mock.calls[2]![0]).not.toBe(fetch.mock.calls[0]![0]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('skips a server it could not connect to for the rest of the run', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const down = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'UND_ERR_CONNECT_TIMEOUT' },
    });
    const answer = { elements: [{ type: 'way', id: 1 }] };
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(down)
      .mockResolvedValueOnce(new Response(JSON.stringify(answer)))
      .mockResolvedValueOnce(new Response(JSON.stringify(answer)));
    vi.stubGlobal('fetch', fetch);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // A fresh module, so the server this test finds down stays skipped only here.
    vi.resetModules();
    const { overpass } = await import('./overpass');
    const dir = await mkdtemp(join(tmpdir(), 'atlas-overpass-'));
    try {
      await settle(overpass(city, join(dir, 'a.osm.json'), { offline: false }));
      await settle(overpass(city, join(dir, 'b.osm.json'), { offline: false }));
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(fetch.mock.calls[2]![0]).not.toBe(fetch.mock.calls[0]![0]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails at once on a rejected query', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('parse error', { status: 400 }));
    vi.stubGlobal('fetch', fetch);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const dir = await mkdtemp(join(tmpdir(), 'atlas-overpass-'));
    try {
      await expect(overpass(city, join(dir, 'a.osm.json'), { offline: false })).rejects.toThrow(
        'Overpass HTTP 400: parse error',
      );
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  describe('with another checkout', () => {
    const fresh: OverpassResponse = {
      elements: [{ ...boundary, type: 'relation' }],
      osm3s: { timestamp_osm_base: '2026-10-01T04:00:00Z' },
    };
    const downloaded = new Date('2026-10-01T05:00:00Z');
    let dir: string;
    let fetch: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'atlas-overpass-'));
      await mkdir(join(dir, 'main'));
      fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify(empty))));
      vi.stubGlobal('fetch', fetch);
      vi.spyOn(console, 'log').mockImplementation(() => {});
    });
    afterEach(() => rm(dir, { recursive: true, force: true }));

    /** Save `data` for `query` in the other checkout, downloaded at `downloaded`. */
    async function saveElsewhere(data: OverpassResponse, query: string) {
      const file = join(dir, 'main', 'boundary.osm.json');
      await writeFile(file, JSON.stringify(data));
      await writeFile(`${file}.query`, query);
      await utimes(file, downloaded, downloaded);
    }
    const options = (extra: Partial<FetchOptions> = {}): FetchOptions => ({
      offline: false,
      copies: (file) => [join(dir, 'missing', basename(file)), join(dir, 'main', basename(file))],
      ...extra,
    });

    it('copies its matching download in, with its query and time, instead of asking Overpass', async () => {
      await saveElsewhere(fresh, city);
      const file = join(dir, 'boundary.osm.json');
      expect(await overpass(downtown, file, options(), hasBoundary)).toEqual(fresh);
      expect(fetch).not.toHaveBeenCalled();
      expect(await readFile(`${file}.query`, 'utf8')).toBe(city);
      expect((await stat(file)).mtimeMs).toBe(downloaded.getTime());
      // Offline too, when this checkout saved nothing.
      await rm(file);
      expect(await overpass(downtown, file, options({ offline: true }), hasBoundary)).toEqual(
        fresh,
      );
    });

    it('asks Overpass when its download answers another query, fails the check, lagged, or on refresh', async () => {
      const file = join(dir, 'boundary.osm.json');
      const ask = (extra?: Partial<FetchOptions>) =>
        overpass(city, file, options(extra)).then(() => rm(file));
      await saveElsewhere(fresh, downtown);
      await ask();
      await saveElsewhere(fresh, city);
      await ask({ refresh: true });
      await saveElsewhere(
        { ...fresh, osm3s: { timestamp_osm_base: '2026-07-15T00:00:00Z' } },
        city,
      );
      await ask();
      expect(fetch).toHaveBeenCalledTimes(3);
      await saveElsewhere(empty, city);
      await expect(overpass(city, file, options({ offline: true }), hasBoundary)).rejects.toThrow(
        /--offline: no cached download/,
      );
    });
  });

  it('omits bbox coverage text from bbox-free strict offline errors', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atlas-overpass-bbox-free-'));
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    try {
      const file = join(dir, 'missing.osm.json');
      await expect(
        overpass('rel(1); out;', file, { offline: true, requireCoverage: true }),
      ).rejects.toThrow(`--offline: no matching cached download at ${file}`);
      await expect(overpass(city, file, { offline: true, requireCoverage: true })).rejects.toThrow(
        ' covering [123.1,13.5,123.4,13.7]',
      );
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('rejects smaller lighter/region caches and missing metadata without an offline network fallback', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atlas-coverage-'));
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    try {
      for (const name of ['detail-traffic.osm.json', 'region-part-1.osm.json']) {
        const path = join(dir, name);
        await writeFile(path, JSON.stringify({ elements: [] }));
        await expect(
          overpass(city, path, { offline: true, requireCoverage: true }),
        ).rejects.toThrow('covering');
        await writeFile(`${path}.query`, downtown);
        await expect(
          overpass(city, path, { offline: true, requireCoverage: true }),
        ).rejects.toThrow(path);
        await writeFile(`${path}.query`, city);
        expect(await overpass(downtown, path, { offline: true, requireCoverage: true })).toEqual({
          elements: [],
        });
      }
      expect(fetch).not.toHaveBeenCalled();
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
