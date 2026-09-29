import * as z from 'zod';
import { BBox, GeoJsonGeometry } from './schemas';

/** What a search result is; results are grouped by it (SPEC.md §5). */
export const SearchType = z.enum([
  'landmark',
  'subdivision',
  'street',
  'school',
  'worship',
  'market',
  'monument',
  'place',
]);
export type SearchType = z.infer<typeof SearchType>;

/** One searchable feature in `<city>.search-index.json` (ARCHITECTURE.md §7). */
export const SearchEntry = z.object({
  /** Feature id (`osm:way/123`), or a synthetic `street/<slug>` for a street's ways. */
  id: z.string().min(1),
  name: z.string().min(1),
  altNames: z.array(z.string().min(1)),
  type: SearchType,
  subdivision: z.string().min(1).optional(),
  /** The subdivision comes from an approximate area, not a mapped boundary. */
  approximate: z.boolean().optional(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  /** Zoom to fly to. */
  zoomHint: z.number().min(0).max(22),
  bbox: BBox.optional(),
  /** Every feature the entry stands for (e.g. a street's ways), to highlight together. */
  featureIds: z.array(z.string().min(1)).optional(),
});
export type SearchEntry = z.infer<typeof SearchEntry>;

export const SearchIndexFile = z.object({
  version: z.literal(1),
  entries: z.array(SearchEntry),
  /** A serialized MiniSearch index over `entries`, built with `searchOptions`. */
  index: z.unknown(),
});
export type SearchIndexFile = z.infer<typeof SearchIndexFile>;

/**
 * Lowercase and strip diacritics, so "Penafrancia" matches "Peñafrancia" (ARCHITECTURE.md §7).
 */
export const foldTerm = (term: string): string =>
  term.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/**
 * MiniSearch options. The pipeline builds the index and the web app loads it with these same
 * options, so both sides tokenize and fold terms identically.
 */
export const searchOptions = {
  idField: 'id',
  fields: ['name', 'altNames'],
  storeFields: [] as string[],
  extractField: (document: Record<string, unknown>, field: string): string => {
    const value = document[field];
    if (Array.isArray(value)) return value.join(' ');
    return typeof value === 'string' ? value : '';
  },
  processTerm: (term: string): string => foldTerm(term),
  searchOptions: { prefix: true, fuzzy: 0.2, boost: { name: 2 }, combineWith: 'AND' as const },
};

/** A city's subdivision areas (`<city>.subdivisions.json`), for the HUD. */
export const SubdivisionArea = z.object({
  name: z.string().min(1),
  /** Derived from `place` nodes rather than a mapped boundary (DATA.md §2 step 03). */
  approximate: z.boolean(),
  geometry: GeoJsonGeometry,
});
export type SubdivisionArea = z.infer<typeof SubdivisionArea>;

export const SubdivisionAreas = z.array(SubdivisionArea);
