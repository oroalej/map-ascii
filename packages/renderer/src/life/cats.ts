/** Top-down cats: two walking steps, curled rest, and grooming. */
import { doubled, inkAt, turnedPixels, type Heading } from './masters';
import { Paint } from './vehicles';
export const CAT_LENGTH_M = 0.65;
export const CAT_PAINTS = [
  Paint.orange,
  Paint.cream,
  Paint.graphite,
  Paint.white,
  Paint.maroon,
] as const;
// prettier-ignore
const frames = [
  ['..o..o....','..####....','...##.....','..####....','.#.###....','...###....','...###.#..','....##....','.....#....','......##..'],
  ['..o..o....','..####....','...##.....','..####....','...###.#..','...###....','.#.###....','....##....','.....#....','...##.....'],
  ['..........','..........','...#####..','..#######.','..##oo###.','..##o####.','...#####..','....###...','..........','..........'],
  ['..........','...o..o...','...####...','....##....','...####...','..######..','...#####..','....###...','.....##...','..........'],
] as const;
const masters = frames.map((rows) => ({
  5: rows.filter((_, i) => i % 2 === 0).map((r) => [...r].filter((_, i) => i % 2 === 0).join('')),
  10: rows,
  20: doubled(rows),
}));
export const CAT_ICON = frames[0];
export type CatGlyph = { frame: number; heading: Heading };
// Rest/groom use one orientation in a cell, keeping the map atlas within its byte budget.
export const catGlyph = (frame: number, heading: Heading) =>
  String.fromCharCode(0xe210 + (frame < 2 ? frame * 4 + heading : frame + 6));
export const catOf = (glyph: string): CatGlyph | undefined => {
  const code = glyph.charCodeAt(0) - 0xe210;
  return code >= 0 && code < 10
    ? { frame: code < 8 ? code >> 2 : code - 6, heading: (code < 8 ? code & 3 : 0) as Heading }
    : undefined;
};
export const catGlyphs = () =>
  Array.from({ length: 10 }, (_, i) => String.fromCharCode(0xe210 + i));
export const catInk = (frame: number, u: number, v: number, detail: number) =>
  inkAt(masters[frame]!, u, v, detail);
export const catPixels = (g: CatGlyph, box: number) =>
  turnedPixels(masters[g.frame]!, box, g.heading);
