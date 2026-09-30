/** Pixel masters for figures drawn into the glyph atlas (life/people.ts, life/birds.ts). */

/** A master at twice the size, each pixel doubled. */
export const doubled = (rows: readonly string[]) =>
  rows.flatMap((row) => {
    const wide = [...row].map((c) => c + c).join('');
    return [wide, wide];
  });
