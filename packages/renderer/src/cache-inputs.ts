/** Compare contributing references without making traversal order a cache dependency. */
export function sameReferenceMembers<T extends object>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false;
  if (a.every((value, i) => value === b[i])) return true;
  const counts = new Map<T, number>();
  for (const value of a) counts.set(value, (counts.get(value) ?? 0) + 1);
  for (const value of b) {
    const count = counts.get(value);
    if (!count) return false;
    counts.set(value, count - 1);
  }
  return true;
}
