export type SeasonalWrite = (
  x: number,
  y: number,
  glyph: string,
  part: number,
  info: number,
  replace?: boolean,
) => boolean;

/** Seasonal strokes use pixel-space directions, independent of rectangular map cells. */
export const seasonalStroke = (x: number, y: number): string =>
  Math.abs(x) > Math.abs(y) * 1.8
    ? '─'
    : Math.abs(y) > Math.abs(x) * 1.8
      ? '│'
      : x * y > 0
        ? '╲'
        : '╱';
