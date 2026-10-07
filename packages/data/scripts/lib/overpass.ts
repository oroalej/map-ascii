import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { bboxContains, splitOverpassBbox } from './geo';

/** Public instances, tried in turn on retries. `OVERPASS_URL` pins one. */
const endpoints = process.env.OVERPASS_URL
  ? [process.env.OVERPASS_URL]
  : [
      'https://overpass-api.de/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter',
      'https://overpass.private.coffee/api/interpreter',
    ];
const maxAttempts = 6;
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

/** How `overpass()` may use saved downloads. */
export type FetchOptions = {
  /** Use saved downloads only; never query Overpass. */
  offline: boolean;
  /** Download again, replacing saved copies. */
  refresh?: boolean;
  /** Require matching query filters and bbox coverage even when offline. */
  requireCoverage?: boolean;
};

/**
 * Whether a saved download, made with the query `saved`, answers `query`. Saved data is kept until it is
 * refreshed, and it answers the same query, or the same query over a bbox inside the saved one
 * (the pipeline clips to the region). Offline, any saved download is used unless `requireCoverage`
 * requires matching query metadata, filters and bbox coverage.
 */
export function cacheAnswers(
  saved: string | undefined,
  query: string,
  { offline, refresh = false, requireCoverage = false }: FetchOptions,
): boolean {
  if (offline)
    return requireCoverage ? cacheAnswers(saved, query, { offline: false, refresh: false }) : true;
  if (refresh || saved === undefined) return false;
  if (saved === query) return true;
  const [a, b] = [splitOverpassBbox(saved), splitOverpassBbox(query)];
  return !!a && !!b && a.rest === b.rest && bboxContains(a.bbox, b.bbox);
}

/** Run an Overpass query, saving the response at `cacheFile` (see `cacheAnswers`). */
export async function overpass(
  query: string,
  cacheFile: string,
  options: FetchOptions,
): Promise<OverpassResponse> {
  const { offline } = options;
  const saved = await stat(cacheFile).catch(() => undefined);
  const savedQuery = await readFile(queryFile(cacheFile), 'utf8').catch(() => undefined);
  if (saved && cacheAnswers(savedQuery, query, options)) {
    console.log(`  cached ${cacheFile}`);
    return JSON.parse(await readFile(cacheFile, 'utf8')) as OverpassResponse;
  }
  if (offline)
    throw new Error(
      `--offline: no matching cached download at ${cacheFile}` +
        (options.requireCoverage
          ? ` covering ${JSON.stringify(splitOverpassBbox(query)?.bbox ?? 'the query')}`
          : ''),
    );

  for (let attempt = 1; ; attempt++) {
    const endpoint = endpoints[(attempt - 1) % endpoints.length]!;
    console.log(
      `  querying ${new URL(endpoint).host}${attempt > 1 ? ` (attempt ${attempt})` : ''}…`,
    );
    const wait = async (why: string) => {
      const waitMs = 10_000 * attempt;
      console.log(`  ${why}; retrying in ${waitMs / 1000} s`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    };
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': 'ascii-atlas-data-pipeline',
        },
        body: new URLSearchParams({ data: query }),
      });
    } catch (error) {
      // A dropped connection (a busy server resetting it) is as retryable as a 504.
      if (attempt >= maxAttempts) throw error;
      const cause = (error as { cause?: { code?: string } }).cause?.code;
      await wait(`Overpass connection failed${cause ? ` (${cause})` : ''}`);
      continue;
    }
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
    await wait(`Overpass HTTP ${response.status}`);
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
