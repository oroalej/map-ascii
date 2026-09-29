import type { DateCertainty } from '@atlas/shared';

export type ParsedYear = { year: number; certainty: DateCertainty };

/**
 * Parse an OSM `start_date`/`end_date` value into a year (DATA.md §5). Plain years and ISO
 * dates are exact; `~1950`, `1950s`, and `c. 1950` are circa. Anything else (ranges, centuries,
 * "before 1950", free text) returns undefined rather than guessing.
 */
export function parseOsmDate(value: string | undefined): ParsedYear | undefined {
  const text = value?.trim();
  if (!text) return undefined;

  const exact = /^(\d{4})(-\d{2}(-\d{2})?)?$/.exec(text);
  if (exact) return { year: Number(exact[1]), certainty: 'exact' };

  const circa = /^(?:~|c\.\s*|ca\.?\s*|circa\s+)?(\d{4})(s)?$/i.exec(text);
  if (circa) return { year: Number(circa[1]), certainty: 'circa' };

  return undefined;
}
