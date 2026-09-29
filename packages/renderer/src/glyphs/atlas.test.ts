import { describe, expect, it } from 'vitest';
import {
  doubleLine,
  doubleWall,
  labelCharacters,
  mapGlyphs,
  rainGlyphs,
  sextantGlyphs,
  singleLine,
  singleWall,
  themes,
} from '../theme';
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

  it('draws dashed lines on the line axis, with the given number of dashes', () => {
    const runs = (values: number[]) =>
      values.reduce((n, v, i) => n + (v > 0 && !(values[i - 1]! > 0) ? 1 : 0), 0);
    const midRow = (g: string) => {
      const rows = Array.from({ length: H }, (_, y) => y).filter((y) => draw('─').at(0, y) > 0);
      return Array.from({ length: W }, (_, x) => draw(g).at(x, rows[0]!));
    };
    const midColumn = (g: string) => {
      const cols = Array.from({ length: W }, (_, x) => x).filter((x) => draw('│').at(x, 0) > 0);
      return Array.from({ length: H }, (_, y) => draw(g).at(cols[0]!, y));
    };
    expect(runs(midRow('┄'))).toBe(3);
    expect(runs(midRow('╌'))).toBe(2);
    expect(runs(midColumn('┆'))).toBe(3);
    expect(runs(midColumn('╎'))).toBe(2);
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

describe('sextants', () => {
  it('maps masks to the Unicode sextants, half blocks, and full block', () => {
    expect(sextantGlyphs).toHaveLength(64);
    expect(new Set(sextantGlyphs).size).toBe(64);
    expect(sextantGlyphs[1]).toBe('\u{1FB00}'); // top-left sixth
    expect(sextantGlyphs[20]).toBe('\u{1FB13}');
    expect(sextantGlyphs[22]).toBe('\u{1FB14}'); // after skipping ▌ (21)
    expect(sextantGlyphs[62]).toBe('\u{1FB3B}');
    expect([sextantGlyphs[0], sextantGlyphs[21], sextantGlyphs[42], sextantGlyphs[63]]).toEqual([
      ' ',
      '▌',
      '▐',
      '█',
    ]);
  });

  it('fills exactly the sixths in the mask, edge to edge', () => {
    for (let mask = 1; mask < 63; mask++) {
      const { drawn, at } = draw(sextantGlyphs[mask]!);
      expect(drawn).toBe(true);
      // Sample the middle of each sixth (2 columns of 5 px, 3 rows of 6 px).
      for (let bit = 0; bit < 6; bit++) {
        const x = (bit % 2) * 5 + 2;
        const y = Math.floor(bit / 2) * 6 + 3;
        expect(at(x, y) > 0, `mask ${mask} bit ${bit}`).toBe((mask & (1 << bit)) !== 0);
      }
    }
    // The top-left sixth reaches the cell's corner, so neighbors join without a gap.
    const topLeft = draw(sextantGlyphs[1]!);
    expect([topLeft.at(0, 0), topLeft.at(4, 5), topLeft.at(5, 0), topLeft.at(0, 6)]).toEqual([
      255, 255, 0, 0,
    ]);
  });
});

describe('glyph set', () => {
  it('fits every map glyph (styles, walls, sextants) in the 256 slots the glyph table holds', () => {
    for (const theme of Object.values(themes)) {
      const glyphs = mapGlyphs(theme);
      const expected = new Set([
        ...Object.values(theme.styles).flatMap((s) => [...s.glyphs]),
        ...singleWall,
        ...doubleWall,
        ...sextantGlyphs,
        ...rainGlyphs,
      ]);
      expect(new Set(glyphs)).toEqual(expected);
      // Index 0 of the atlas is blank, so the glyphs take indices 1 on.
      expect(glyphs.length).toBeLessThan(256);
    }
  });

  it('keeps label text in its own set', () => {
    for (const g of ['A', 'z', 'ñ', '?']) expect(labelCharacters.includes(g), g).toBe(true);
  });
});
