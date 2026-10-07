import { copyFile, mkdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
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
/** Mirrors can fall months behind OSM; an answer further behind than this is retried elsewhere. */
const maxLagMs = 2 * 24 * 60 * 60 * 1000;
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

export type OverpassResponse = {
  elements: OsmElement[];
  remark?: string;
  /** When the server's copy of OSM was last updated. */
  osm3s?: { timestamp_osm_base?: string };
};

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
  /** Where other checkouts keep the same download (`copiesElsewhere`), tried before Overpass. */
  copies?: (file: string) => string[];
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

/** Throws when a response can't be used, e.g. a lookup that matched nothing. */
export type ResponseCheck = (data: OverpassResponse) => void;

/** The message of whatever `check` throws on `data`, or undefined when the response is usable. */
function rejection(check: ResponseCheck | undefined, data: OverpassResponse) {
  try {
    check?.(data);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Why a response received at `receivedAt` (ms) is too far behind OSM to use, or undefined. */
export function lagging(data: OverpassResponse, receivedAt: number) {
  const base = Date.parse(data.osm3s?.timestamp_osm_base ?? '');
  if (Number.isNaN(base) || receivedAt - base <= maxLagMs) return undefined;
  return `server had OSM data from ${new Date(base).toISOString().slice(0, 10)}`;
}

/** Servers that answered `lagging` in this run. A mirror months behind stays behind, so skip it. */
const behind = new Set<string>();

/**
 * Another checkout's saved download at `copy`, when it answers `query` as a saved download here
 * would (`cacheAnswers`, `check`, not `lagging`). Copied in with its query and time, so it stays
 * judged by when it was downloaded.
 */
async function adopt(
  copy: string,
  cacheFile: string,
  query: string,
  check: ResponseCheck | undefined,
): Promise<OverpassResponse | undefined> {
  try {
    const saved = await stat(copy);
    const savedQuery = await readFile(queryFile(copy), 'utf8');
    if (!cacheAnswers(savedQuery, query, { offline: false })) return undefined;
    const data = JSON.parse(await readFile(copy, 'utf8')) as OverpassResponse;
    if (rejection(check, data) ?? lagging(data, saved.mtimeMs)) return undefined;
    await mkdir(dirname(cacheFile), { recursive: true });
    await copyFile(copy, cacheFile);
    await utimes(cacheFile, saved.atime, saved.mtime);
    await writeFile(queryFile(cacheFile), savedQuery);
    return data;
  } catch {
    // Missing, or being written by another session: not usable.
    return undefined;
  }
}

/** Read admitted local or peer downloads, preserving coverage, checks, lag policy and logging. */
export async function readCached(
  query: string,
  cacheFile: string,
  options: FetchOptions,
  check?: ResponseCheck,
): Promise<OverpassResponse | undefined> {
  const { offline } = options;
  const saved = await stat(cacheFile).catch(() => undefined);
  const savedQuery = await readFile(queryFile(cacheFile), 'utf8').catch(() => undefined);
  if (saved && cacheAnswers(savedQuery, query, options)) {
    const data = JSON.parse(await readFile(cacheFile, 'utf8')) as OverpassResponse;
    const unusable = rejection(check, data);
    if (offline && unusable) throw new Error(`--offline: ${unusable} in ${cacheFile}`);
    const behind = lagging(data, saved.mtimeMs);
    const problem = unusable ?? (offline ? undefined : behind);
    if (!problem) {
      console.log(`  cached ${cacheFile}${behind ? ` (${behind})` : ''}`);
      return data;
    }
    console.log(`  ${problem} in ${cacheFile}; downloading again`);
  }
  if (!options.refresh) {
    for (const copy of options.copies?.(cacheFile) ?? []) {
      const data = await adopt(copy, cacheFile, query, check);
      if (data) {
        console.log(`  copied ${copy}`);
        return data;
      }
    }
  }
  return undefined;
}

/**
 * Run an Overpass query, saving only answers that pass `check` and the mirror lag check.
 * Saved downloads and other checkouts' copies are tried first (see `readCached`).
 */
export async function overpass(
  query: string,
  cacheFile: string,
  options: FetchOptions,
  check?: ResponseCheck,
): Promise<OverpassResponse> {
  const { offline } = options;
  const saved = await readCached(query, cacheFile, options, check);
  if (saved) return saved;
  if (offline) {
    const bbox = options.requireCoverage ? splitOverpassBbox(query)?.bbox : undefined;
    throw new Error(
      `--offline: no ${options.requireCoverage ? 'matching ' : ''}cached download at ${cacheFile}` +
        (bbox ? ` covering ${JSON.stringify(bbox)}` : ''),
    );
  }

  for (let attempt = 1; ; attempt++) {
    const current = endpoints.filter((url) => !behind.has(url));
    const choices = current.length > 0 ? current : endpoints;
    const endpoint = choices[(attempt - 1) % choices.length]!;
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
      const late = lagging(data, Date.now());
      if (late) behind.add(endpoint);
      const problem = late ?? rejection(check, data);
      if (problem) {
        if (attempt >= maxAttempts) throw new Error(`Overpass: ${problem}`);
        await wait(`Overpass: ${problem}`);
        continue;
      }
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
