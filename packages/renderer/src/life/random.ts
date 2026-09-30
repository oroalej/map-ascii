/** Seeded randomness for the life layer, so every visitor sees the same agents. */

/** A deterministic random number generator (mulberry32), 0 ≤ n < 1. */
export function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A value in `[lo, hi)`. */
export const between = (rng: () => number, [lo, hi]: readonly [number, number]) =>
  lo + (hi - lo) * rng();

/** A string's FNV-1a hash, for seeds. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}
