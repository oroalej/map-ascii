import { SearchIndexFile, searchOptions, type SearchEntry, type SearchType } from '@atlas/shared';
import type MiniSearch from 'minisearch';
import type { AsPlainObject } from 'minisearch';

/** A city's search index, loaded (ARCHITECTURE.md §7). */
export type CitySearch = {
  entries: ReadonlyMap<string, SearchEntry>;
  index: MiniSearch<SearchEntry>;
};

const loaded = new Map<string, Promise<CitySearch>>();

/**
 * Load a city's `<city>.search-index.json` once (lazily, on the first search or when the
 * panel needs a name). A failed load is forgotten so the next call retries.
 */
export function loadSearch(city: string): Promise<CitySearch> {
  let promise = loaded.get(city);
  if (!promise) {
    promise = (async () => {
      // MiniSearch loads with the index, so it stays out of the initial bundle.
      const [response, { default: MiniSearchClass }] = await Promise.all([
        fetch(`/tiles/${city}.search-index.json`),
        import('minisearch'),
      ]);
      if (!response.ok) throw new Error(`search index for ${city}: HTTP ${response.status}`);
      const file = SearchIndexFile.parse(await response.json());
      return {
        entries: new Map(file.entries.map((e) => [e.id, e])),
        // The pipeline serialized it with `toJSON()` and the same shared options.
        index: MiniSearchClass.loadJS<SearchEntry>(file.index as AsPlainObject, searchOptions),
      };
    })();
    promise.catch(() => loaded.delete(city));
    loaded.set(city, promise);
  }
  return promise;
}

/** Result groups, in the order the results list shows them (SPEC.md §5: grouped by type). */
export const TYPE_ORDER: readonly SearchType[] = [
  'landmark',
  'subdivision',
  'street',
  'worship',
  'school',
  'market',
  'monument',
  'place',
];

export const TYPE_LABELS: Readonly<Record<SearchType, string>> = {
  landmark: 'Landmarks',
  subdivision: 'Subdivisions',
  street: 'Streets',
  worship: 'Places of worship',
  school: 'Schools',
  market: 'Markets',
  monument: 'Monuments',
  place: 'Places',
};

export type ResultGroup = { type: SearchType; entries: SearchEntry[] };

/**
 * Results for a query, grouped by type in `TYPE_ORDER`, best matches first within a group,
 * and at most `perGroup` per group. `ids` are MiniSearch's hits, best first.
 */
export function groupResults(
  ids: readonly string[],
  entries: ReadonlyMap<string, SearchEntry>,
  perGroup = 5,
): ResultGroup[] {
  const groups = new Map<SearchType, SearchEntry[]>();
  for (const id of ids) {
    const entry = entries.get(id);
    if (!entry) continue;
    const list = groups.get(entry.type) ?? [];
    if (list.length < perGroup) list.push(entry);
    groups.set(entry.type, list);
  }
  return TYPE_ORDER.filter((t) => groups.has(t)).map((type) => ({
    type,
    entries: groups.get(type)!,
  }));
}

/** Search a loaded index. */
export function search(city: CitySearch, query: string, perGroup = 5): ResultGroup[] {
  const q = query.trim();
  if (!q) return [];
  const hits = city.index.search(q);
  return groupResults(
    hits.map((h) => String(h.id)),
    city.entries,
    perGroup,
  );
}
