/** Search tokenization shared by the pipeline and the web app; zod-free (see constants.ts). */

/**
 * Lowercase, strip diacritics, and spell out compatibility characters, so "Penafrancia" matches
 * "Peñafrancia" and "Ocampo II" matches "Ocampo Ⅱ" (ARCHITECTURE.md §7).
 */
export const foldTerm = (term: string): string =>
  term.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

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
