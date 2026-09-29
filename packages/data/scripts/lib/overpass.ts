import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Public instances, tried in turn on retries. `OVERPASS_URL` pins one. */
const endpoints = process.env.OVERPASS_URL
  ? [process.env.OVERPASS_URL]
  : ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const maxAttempts = 6;
const maxAgeMs = 7 * 24 * 60 * 60 * 1000;
const retryable = new Set([429, 502, 503, 504]);

export type OsmElement = {
  type: 'node' | 'way' | 'relation';
  id: number;
  tags?: Record<string, string>;
  bounds?: { minlat: number; minlon: number; maxlat: number; maxlon: number };
  /** Way node ids (`out body`). */
  nodes?: number[];
  /** Node position. */
  lat?: number;
  lon?: number;
  /** Center of a way or relation (`out center`). */
  center?: { lat: number; lon: number };
};

export type OverpassResponse = { elements: OsmElement[]; remark?: string };

/** Quote a string for Overpass QL (it accepts JSON-style escapes). */
export const quote = (value: string) => JSON.stringify(value);

/** The query a cache file was downloaded with is kept next to it. */
const queryFile = (cacheFile: string) => `${cacheFile}.query`;

/**
 * Whether a cached download can be reused: always when offline; otherwise only if it is under
 * 7 days old and was made with the same query (so changing a query triggers a new download).
 */
export function cacheIsFresh(
  cached: { mtimeMs: number; query: string | undefined },
  query: string,
  { offline, now }: { offline: boolean; now: number },
): boolean {
  if (offline) return true;
  return cached.query === query && now - cached.mtimeMs < maxAgeMs;
}

/** Run an Overpass query, caching the response at `cacheFile` (see `cacheIsFresh`). */
export async function overpass(
  query: string,
  cacheFile: string,
  { offline }: { offline: boolean },
): Promise<OverpassResponse> {
  const cached = await stat(cacheFile).catch(() => undefined);
  const cachedQuery = await readFile(queryFile(cacheFile), 'utf8').catch(() => undefined);
  if (
    cached &&
    cacheIsFresh({ mtimeMs: cached.mtimeMs, query: cachedQuery }, query, {
      offline,
      now: Date.now(),
    })
  ) {
    console.log(`  cached ${cacheFile}`);
    return JSON.parse(await readFile(cacheFile, 'utf8')) as OverpassResponse;
  }
  if (offline) throw new Error(`--offline: no cached download at ${cacheFile}`);

  for (let attempt = 1; ; attempt++) {
    const endpoint = endpoints[(attempt - 1) % endpoints.length]!;
    console.log(
      `  querying ${new URL(endpoint).host}${attempt > 1 ? ` (attempt ${attempt})` : ''}…`,
    );
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': 'ascii-atlas-data-pipeline',
      },
      body: new URLSearchParams({ data: query }),
    });
    if (response.ok) {
      const text = await response.text();
      const data = JSON.parse(text) as OverpassResponse;
      // Overpass reports timeouts and memory errors as a remark on an otherwise OK response.
      if (data.remark?.includes('error')) throw new Error(`Overpass: ${data.remark}`);
      await mkdir(dirname(cacheFile), { recursive: true });
      await writeFile(cacheFile, text);
      await writeFile(queryFile(cacheFile), query);
      return data;
    }
    if (!retryable.has(response.status) || attempt >= maxAttempts) {
      throw new Error(`Overpass HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }
    const waitMs = 10_000 * attempt;
    console.log(`  Overpass HTTP ${response.status}; retrying in ${waitMs / 1000} s`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

/** Find the one relation matching `tags`, or fail loudly. */
export function onlyRelation(
  response: OverpassResponse,
  what: string,
  tags: Record<string, string>,
) {
  const matches = response.elements.filter(
    (e) => e.type === 'relation' && Object.entries(tags).every(([k, v]) => e.tags?.[k] === v),
  );
  if (matches.length !== 1) {
    const ids = matches.map((m) => m.id).join(', ') || 'none';
    throw new Error(
      `${what} lookup must match exactly one relation, got ${matches.length} (${ids})`,
    );
  }
  return matches[0]!;
}
