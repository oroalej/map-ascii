/** OSM attribution stays available once, independently of supplemental sources. */
export const OSM_ATTRIBUTION = '© OpenStreetMap contributors (ODbL)';

/** Normalize known OSM clauses without discarding other providers or provenance. */
export function normalizeCredits(credits: readonly string[]): string[] {
  const additional = credits.map((credit) =>
    credit
      .replace(
        /(?:Geometry:?\s*|OSM geometry\s*)?© OpenStreetMap contributors(?:\s*\(ODbL\))?\.?/gi,
        '',
      )
      .replace(/\s{2,}/g, ' ')
      .replace(/;\s*;/g, ';')
      .replace(/—\s*;/g, '—')
      .trim(),
  );
  return [OSM_ATTRIBUTION, ...new Set(additional.filter(Boolean))];
}
