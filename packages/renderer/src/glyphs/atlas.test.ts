import { describe, expect, it } from 'vitest';
import { doubleLine, doubleWall, singleLine, singleWall, themeGlyphs, themes } from '../theme';
import { drawProcedural, shadeCoverage } from './atlas';

const W = 10;
const H = 18;

/** Draw one glyph into its own slot; returns a coverage lookup. */
function draw(glyph: string) {
  const data = new Uint8Array(W * H);
  const drawn = drawProcedural({ data, stride: W, x0: 0, y0: 0, w: W, h: H }, glyph);
  const at = (x: number, y: number) => data[y * W + x]!;
  const edges = {
    n: data.slice(0, W).some((v) => v > 0),
    s: data.slice((H - 1) * W).some((v) => v > 0),
    w: Array.from({ length: H }, (_, y) => at(0, y)).some((v) => v > 0),
    e: Array.from({ length: H }, (_, y) => at(W - 1, y)).some((v) => v > 0),
  };
  return { drawn, at, edges };
}

describe('procedural glyphs', () => {
  it('draws every road glyph as shapes', () => {
    for (const g of [...singleLine, ...doubleLine]) expect(draw(g).drawn, g).toBe(true);
    expect(draw('~').drawn).toBe(false);
  });

  it('reaches exactly the cell edges its arms point to, so lines join across cells', () => {
    expect(draw('─').edges).toEqual({ n: false, s: false, w: true, e: true });
    expect(draw('│').edges).toEqual({ n: true, s: true, w: false, e: false });
    expect(draw('┌').edges).toEqual({ n: false, s: true, w: false, e: true });
    expect(draw('╬').edges).toEqual({ n: true, s: true, w: true, e: true });
    expect(draw('╝').edges).toEqual({ n: true, s: false, w: true, e: false });
  });

  it('lines up horizontal strokes between neighbors', () => {
    const rows = (g: string) =>
      Array.from({ length: H }, (_, y) => y).filter((y) => draw(g).at(0, y) > 0);
    expect(rows('─')).toEqual(rows('┼'));
    expect(rows('═')).toEqual(rows('╬'));
    expect(rows('═')).toHaveLength(2);
  });

  it('draws diagonals corner to corner', () => {
    const rising = draw('╱');
    expect(rising.at(0, H - 1) + rising.at(1, H - 1)).toBeGreaterThan(0);
    expect(rising.at(W - 1, 0) + rising.at(W - 2, 0)).toBeGreaterThan(0);
  });

  it('shades blocks by coverage', () => {
    expect(draw('█').at(W - 1, H - 1)).toBe(255);
    expect(draw('▓').at(3, 3)).toBe(shadeCoverage['▓']);
    expect(draw('░').at(3, 3)).toBeLessThan(draw('▒').at(3, 3));
  });

  it('draws a one-cell building as a closed square', () => {
    const square = draw('□');
    expect(square.drawn).toBe(true);
    expect(square.edges).toEqual({ n: false, s: false, w: false, e: false });
    expect(square.at(5, 9)).toBe(0); // hollow
  });
});

describe('glyph set', () => {
  it('puts every map glyph (styles and walls) in the first 256 atlas slots', () => {
    for (const theme of Object.values(themes)) {
      const glyphs = themeGlyphs(theme);
      const mapGlyphs = new Set([
        ...Object.values(theme.styles).flatMap((s) => [...s.glyphs]),
        ...singleWall,
        ...doubleWall,
      ]);
      for (const g of mapGlyphs) expect(glyphs.indexOf(g) + 1, g).toBeLessThan(256);
    }
  });

  it('includes the label text characters', () => {
    const glyphs = new Set(themeGlyphs(themes.dark));
    for (const g of ['A', 'z', 'ñ', '?']) expect(glyphs.has(g), g).toBe(true);
  });
});
