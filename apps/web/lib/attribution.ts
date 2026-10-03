/** OSM has its permanent linked credit below; retain every other source in the pack. */
export function additionalCredits(credits: readonly string[]): string[] {
  return [
    ...new Set(
      credits.map((credit) =>
        credit
          .replace(
            /(?:Geometry:\s*|OSM geometry\s*)?© OpenStreetMap contributors(?:\s*\(ODbL\))?\.?/gi,
            '',
          )
          .replace(/\s{2,}/g, ' ')
          .replace(/;\s*;/g, ';')
          .trim(),
      ),
    ),
  ].filter(Boolean);
}
