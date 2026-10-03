// Put licence/contributor records and provider-only copyrights before lengthy reference notes.
// Unknown formats retain their full text and stable order; only exact duplicates are grouped.
const referencePriority = (credit: string) =>
  /\b(?:CC BY(?:-SA)?\s|CC0\b|public domain\b)/i.test(credit) ||
  (/©/.test(credit) && !/\b(?:owner|draft|schematic|illustrative|survey|reference)\b/i.test(credit))
    ? 0
    : 1;

/** OSM has its permanent linked credit below; retain every other source in the pack. */
export function additionalCredits(credits: readonly string[]): string[] {
  return [
    ...new Set(
      credits.map((credit) =>
        credit
          .replace(
            /(?:Geometry:?\s*|OSM geometry\s*)?© OpenStreetMap contributors(?:\s*\(ODbL\))?\.?/gi,
            '',
          )
          .replace(/\s{2,}/g, ' ')
          .replace(/;\s*;/g, ';')
          .replace(/—\s*;/g, '—')
          .trim(),
      ),
    ),
  ]
    .filter(Boolean)
    .sort((a, b) => referencePriority(a) - referencePriority(b));
}
