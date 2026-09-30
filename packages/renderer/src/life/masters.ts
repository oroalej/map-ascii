/** Pixel masters for figures drawn into the glyph atlas (life/people.ts, birds.ts, dogs.ts). */

/** A master at twice the size, each pixel doubled. */
export const doubled = (rows: readonly string[]) =>
  rows.flatMap((row) => {
    const wide = [...row].map((c) => c + c).join('');
    return [wide, wide];
  });

/** Which way a one-cell figure faces on screen. */
export const Heading = { up: 0, right: 1, down: 2, left: 3 } as const;
export type Heading = (typeof Heading)[keyof typeof Heading];

/** The heading on screen nearest a direction in pixels (`y` down the screen). */
export const headingOf = (x: number, y: number): Heading =>
  Math.abs(x) >= Math.abs(y)
    ? x >= 0
      ? Heading.right
      : Heading.left
    : y > 0
      ? Heading.down
      : Heading.up;

/**
 * A figure's pixels in a `box` × `box` square, from `masters` (by size, each drawn heading up):
 * the smallest at least `box` wide (the largest, if none is), sampled down to it and turned
 * clockwise to `heading`. '.' outside it.
 */
export function turnedPixels(
  masters: Readonly<Record<number, readonly string[]>>,
  box: number,
  heading: Heading,
): (x: number, y: number) => string {
  const sizes = Object.keys(masters)
    .map(Number)
    .sort((a, b) => a - b);
  const size = sizes.find((s) => s >= box) ?? sizes[sizes.length - 1]!;
  const master = masters[size]!;
  const n = box - 1;
  return (x, y) => {
    const [mx, my] =
      heading === Heading.up
        ? [x, y]
        : heading === Heading.right
          ? [y, n - x]
          : heading === Heading.down
            ? [n - x, n - y]
            : [n - y, x];
    const row = master[Math.floor(((my + 0.5) * size) / box)];
    return row?.[Math.floor(((mx + 0.5) * size) / box)] ?? '.';
  };
}

/**
 * A stamped figure's ink at (`u` forward, `v` to the right), both 0–1 over its square: from the
 * largest of `masters` no finer than `detail` (how many sixths of a cell it spans; the smallest
 * if all are).
 */
export function inkAt(
  masters: Readonly<Record<number, readonly string[]>>,
  u: number,
  v: number,
  detail: number,
): string {
  const sizes = Object.keys(masters)
    .map(Number)
    .sort((a, b) => a - b);
  let size = sizes[0]!;
  for (const s of sizes) if (s <= detail) size = s;
  const at = (t: number) => Math.min(size - 1, Math.max(0, Math.floor(t * size)));
  return masters[size]![at(1 - u)]![at(v)]!;
}
