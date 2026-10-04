import { normalizeCredits, OSM_ATTRIBUTION } from '@atlas/shared';

// Put licence/contributor records and provider-only copyrights before lengthy reference notes.
// Unknown formats retain their full text and stable order; only exact duplicates are grouped.
const referencePriority = (credit: string) =>
  /\b(?:CC BY(?:-SA)?\s|CC0\b|public domain\b)/i.test(credit) ||
  (/©/.test(credit) && !/\b(?:owner|draft|schematic|illustrative|survey|reference)\b/i.test(credit))
    ? 0
    : 1;

/** OSM has its permanent linked credit below; retain every other source in the pack. */
export function additionalCredits(credits: readonly string[]): string[] {
  return normalizeCredits(credits)
    .filter((credit) => credit !== OSM_ATTRIBUTION)
    .sort((a, b) => referencePriority(a) - referencePriority(b));
}

/** Preserve surrounding text while identifying complete HTTP(S) link targets. */
export function creditTokens(credit: string): { text: string; url?: string }[] {
  const tokens: { text: string; url?: string }[] = [];
  let position = 0;
  for (const match of credit.matchAll(/https?:\/\/[^\s()<>,;]*[^\s()<>,;.!?]/g)) {
    if (match.index > position) tokens.push({ text: credit.slice(position, match.index) });
    tokens.push({ text: match[0], url: match[0] });
    position = match.index + match[0].length;
  }
  if (position < credit.length) tokens.push({ text: credit.slice(position) });
  return tokens;
}
