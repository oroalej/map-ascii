import { EtagMismatch, FetchSource, type RangeResponse, type Source } from 'pmtiles';

const CACHE = 'atlas-pmtiles-ranges-v1';
const epochs = new Map<string, number>();
let mutations = Promise.resolve();
const mutate = <T>(action: () => Promise<T>): Promise<T> => {
  const next = mutations.then(action);
  mutations = next.then(
    () => {},
    () => {},
  );
  return next;
};
const epoch = (url: string) => epochs.get(url) ?? 0;
const abort = (signal?: AbortSignal) => signal?.throwIfAborted();

/** Only pins validated by the web build opt into our independently stored range bytes. */
export function archiveSource(url: string): Source {
  const source = new FetchSource(url);
  // Chromium on Windows can corrupt sparse HTTP-cache ranges even for unchanged files.
  // Keep FetchSource's workaround for misses; CacheStorage holds complete status-200 bodies.
  return /^[a-f0-9]{8}$/.test(new URL(url, 'http://localhost').searchParams.get('v') ?? '')
    ? new RangeCacheSource(source)
    : source;
}

export class RangeCacheSource implements Source {
  constructor(private readonly source: FetchSource) {}
  getKey() {
    return this.source.getKey();
  }
  private key(offset?: number, length?: number) {
    const key = new URL('/__atlas_range_cache__', this.getKey());
    key.searchParams.set('archive', this.getKey());
    if (offset !== undefined) key.searchParams.set('range', `${offset}:${length}`);
    return key.href;
  }
  private async storage(): Promise<Cache | undefined> {
    try {
      return typeof caches === 'undefined' ? undefined : await caches.open(CACHE);
    } catch {
      return undefined;
    }
  }
  private async invalidate(cache?: Cache) {
    const url = this.getKey();
    epochs.set(url, epoch(url) + 1);
    if (!cache) return;
    try {
      await mutate(async () => {
        for (const key of await cache.keys())
          if (
            new URL(key.url).pathname === '/__atlas_range_cache__' &&
            new URL(key.url).searchParams.get('archive') === url
          )
            await cache.delete(key);
      });
    } catch {
      /* Storage failure must not prevent pmtiles' reload. */
    }
  }
  private async touch(cache: Cache) {
    const url = new URL(this.getKey());
    await cache.put(this.key(), new Response(String(Date.now())));
    const versions: { archive: string; at: number }[] = [];
    const keys = await cache.keys();
    for (const key of keys) {
      const parsed = new URL(key.url),
        archive = parsed.searchParams.get('archive');
      if (
        !archive ||
        parsed.pathname !== '/__atlas_range_cache__' ||
        parsed.searchParams.has('range')
      )
        continue;
      const other = new URL(archive);
      if (other.origin !== url.origin || other.pathname !== url.pathname) continue;
      versions.push({ archive, at: Number(await (await cache.match(key))?.text()) });
    }
    // The current pin wins timestamp ties and the newest previously used pin is retained.
    versions.sort(
      (a, b) =>
        Number(b.archive === this.getKey()) - Number(a.archive === this.getKey()) || b.at - a.at,
    );
    const stale = new Set(versions.slice(2).map(({ archive }) => archive));
    for (const archive of stale) epochs.set(archive, epoch(archive) + 1);
    for (const key of keys)
      if (
        new URL(key.url).pathname === '/__atlas_range_cache__' &&
        stale.has(new URL(key.url).searchParams.get('archive') ?? '')
      )
        await cache.delete(key);
  }
  async getBytes(
    offset: number,
    length: number,
    signal?: AbortSignal,
    etag?: string,
  ): Promise<RangeResponse> {
    abort(signal);
    const cache = await this.storage();
    abort(signal);
    if (this.source.mustReload) await this.invalidate(cache);
    const generation = epoch(this.getKey());
    let stored: Response | undefined;
    if (cache && !this.source.mustReload) {
      try {
        stored = await cache.match(this.key(offset, length));
      } catch {
        /* Fall back to the original source. */
      }
    }
    abort(signal);
    if (stored && generation === epoch(this.getKey())) {
      const cachedEtag = stored.headers.get('etag') ?? undefined;
      if (etag && cachedEtag && etag !== cachedEtag) {
        this.source.mustReload = true;
        await this.invalidate(cache);
        throw new EtagMismatch('Stored PMTiles range has a different ETag');
      }
      let data: ArrayBuffer | undefined;
      try {
        data = await stored.arrayBuffer();
      } catch {
        /* A damaged storage entry falls back to the network. */
      }
      abort(signal);
      if (data && generation === epoch(this.getKey())) {
        try {
          await mutate(() => this.touch(cache!));
        } catch {
          /* Best effort retention. */
        }
        abort(signal);
        return {
          data,
          etag: cachedEtag,
          cacheControl: stored.headers.get('cache-control') ?? undefined,
          expires: stored.headers.get('expires') ?? undefined,
        };
      }
    }
    let response: RangeResponse;
    try {
      response = await this.source.getBytes(offset, length, signal, etag);
    } catch (error) {
      if (error instanceof EtagMismatch) await this.invalidate(cache);
      throw error;
    }
    abort(signal);
    if (cache && !this.source.mustReload) {
      try {
        await mutate(async () => {
          if (generation !== epoch(this.getKey()) || signal?.aborted) return;
          const headers = new Headers();
          if (response.etag) headers.set('etag', response.etag);
          if (response.cacheControl) headers.set('cache-control', response.cacheControl);
          if (response.expires) headers.set('expires', response.expires);
          await cache.put(this.key(offset, length), new Response(response.data, { headers }));
          await this.touch(cache);
        });
      } catch {
        /* Quota or storage failure cannot break map loading. */
      }
    }
    abort(signal);
    return response;
  }
}
