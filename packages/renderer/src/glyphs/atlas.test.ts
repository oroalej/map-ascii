import { PEDESTRIAN_GLYPHS } from '../life/pedestrian-glyphs';
import { MAX_GLYPHS } from './select';
import { describe, expect, it } from 'vitest';
import { PROCESSION_GLYPHS } from '../life/procession-glyphs';
import { FOLKLORE_GLYPHS } from '../life/folklore-glyphs';
import { ACCESS_GLYPHS, CANDLE_GLYPHS, SEASONAL_GLYPHS } from '../life/seasonal-glyphs';
import { createHash } from 'node:crypto';
import {
  doubleLine,
  fixtureGlyphs,
  arrowGlyphs,
  doubleWall,
  labelCharacters,
  mapGlyphs,
  railLine,
  rainGlyphs,
  sextantGlyphs,
  singleLine,
  singleWall,
  streetlightGlyph,
  themes,
} from '../theme';
import { birdGlyphs } from '../life/birds';
import { dogGlyphs } from '../life/dogs';
import { catGlyphs } from '../life/cats';
import { PUFF_GLYPHS } from '../life/puff-style';
import {
  FIGURE_TONE,
  figureGlyph,
  figureOf,
  figurePixels,
  MIN_FIGURE_PX,
  personGlyphs,
} from '../life/people';
import { STALL_GLYPH, vehicleGlyphs } from '../life/vehicles';
import { buildGlyphAtlas, drawProcedural, shadeCoverage } from './atlas';

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
  it('rejects a map atlas larger than its ten-bit index before allocating a canvas', () => {
    expect(() =>
      buildGlyphAtlas(
        Array.from({ length: MAX_GLYPHS + 1 }, (_, i) => `g${i}`),
        10,
        18,
        undefined,
        MAX_GLYPHS + 1,
      ),
    ).toThrow('1025 > 1024');
    for (const theme of Object.values(themes))
      expect(mapGlyphs(theme).length).toBeLessThanOrEqual(MAX_GLYPHS + 1);
  });
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

  it('draws track as two rails with crossties, joining the double-line corners', () => {
    for (const g of railLine) expect(draw(g).drawn, g).toBe(true);
    expect(draw('╪').edges).toEqual({ n: false, s: false, w: true, e: true });
    expect(draw('╫').edges).toEqual({ n: true, s: true, w: false, e: false });
    const railRows = (g: string) =>
      Array.from({ length: H }, (_, y) => y).filter((y) => draw(g).at(0, y) > 0);
    // Its rails meet the strokes of the corner beside it.
    expect(railRows('╪')).toEqual(railRows('═'));
    // Crossties: two columns inked across more rows than the rails alone.
    const track = draw('╪');
    const inked = (x: number) => Array.from({ length: H }, (_, y) => track.at(x, y) > 0);
    const ties = Array.from({ length: W }, (_, x) => x).filter(
      (x) => inked(x).filter(Boolean).length > railRows('╪').length,
    );
    expect(ties).toHaveLength(2);
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

describe('people', () => {
  /** Draw `glyph` into a `w` × `h` slot; returns its pixels, row by row. */
  const pixels = (glyph: string, w: number, h: number) => {
    const data = new Uint8Array(w * h);
    const drawn = drawProcedural({ data, stride: w, x0: 0, y0: 0, w, h }, glyph);
    const rows = Array.from({ length: h }, (_, y) => Array.from(data.subarray(y * w, y * w + w)));
    return { drawn, data, rows };
  };
  const sizes = [
    [5, 9],
    [8, 14],
    [10, 18],
    [15, 27],
  ] as const;

  it('draws every figure pixel for pixel, in paint and tone', () => {
    for (const glyph of personGlyphs()) {
      for (const [w, h] of sizes) {
        const { drawn, data } = pixels(glyph, w, h);
        expect(drawn, `${figureOf(glyph)!.figure} ${w}×${h}`).toBe(true);
        const inks = new Set(data);
        for (const ink of inks) expect([0, 255, FIGURE_TONE]).toContain(ink);
        // A 2×2 figure's corner may hold only one ink.
        if (figureOf(glyph)!.slice === undefined) {
          expect(inks.has(255) && inks.has(FIGURE_TONE), `${w}×${h}`).toBe(true);
        } else {
          expect(inks.size).toBeGreaterThan(1);
        }
      }
    }
  });

  it('draws a one-cell figure at its scale of the cell, never under MIN_FIGURE_PX', () => {
    const inkWidth = (glyph: string, w: number, h: number) => {
      const { rows } = pixels(glyph, w, h);
      const inked = rows[0]!.map((_, x) => rows.some((row) => row[x]! > 0));
      return inked.lastIndexOf(true) - inked.indexOf(true) + 1;
    };
    const canopy = (scale: 0 | 1 | 2) => figureGlyph('umbrella', false, 0, { scale });
    expect(([0, 1, 2] as const).map((s) => inkWidth(canopy(s), 10, 18))).toEqual([
      MIN_FIGURE_PX,
      8,
      10,
    ]);
    expect(inkWidth(canopy(0), 15, 27)).toBe(9);
    // A cell narrower than the minimum is filled.
    for (const s of [0, 1, 2] as const) expect(inkWidth(canopy(s), 5, 9)).toBe(5);
  });

  it('keeps staged canopies narrower at every scale and readable in five- and nine-pixel boxes', () => {
    const stageGlyph = (stage: 0 | 1, scale: 0 | 1 | 2) =>
      figureGlyph('umbrella', false, 0, { scale }, 0, undefined, undefined, stage);
    for (const stage of [0, 1] as const)
      for (const scale of [0, 1, 2] as const) {
        const { rows } = pixels(stageGlyph(stage, scale), 10, 18);
        const columns = rows[0]!.map((_, x) => rows.some((row) => row[x]! > 0));
        expect(columns.lastIndexOf(true) - columns.indexOf(true) + 1).toBeLessThan(
          [6, 8, 10][scale]!,
        );
        const small = new Set(pixels(stageGlyph(stage, scale), 5, 9).data);
        expect(small.has(255) && small.has(FIGURE_TONE)).toBe(true);
      }
    const nine = new Set(pixels(stageGlyph(0, 0), 15, 27).data);
    expect(nine.has(255) && nine.has(FIGURE_TONE)).toBe(true);
  });

  it('assembles all four staged slices into the intended smaller canopy', () => {
    for (const stage of [0, 1] as const)
      for (const [w, h] of sizes) {
        const whole = Array.from({ length: 2 * h }, () => new Array<number>(2 * w).fill(0));
        for (const slice of [0, 1, 2, 3] as const) {
          const glyph = figureGlyph(
            'umbrella',
            false,
            0,
            { slice },
            0,
            undefined,
            undefined,
            stage,
          );
          const { rows, data } = pixels(glyph, w, h);
          expect(data.some((value) => value > 0)).toBe(true);
          rows.forEach((row, y) =>
            row.forEach((value, x) => (whole[(slice >> 1) * h + y]![(slice & 1) * w + x] = value)),
          );
        }
        const mark = figurePixels({ figure: 'umbrella', across: false, frame: 0, stage }, 2 * w);
        const top = h - w;
        const expected = whole.map((row, y) =>
          row.map((_, x) => {
            const ink = y >= top && y < top + 2 * w ? mark(x, y - top) : '.';
            return ink === '#' ? 255 : ink === 'o' ? FIGURE_TONE : 0;
          }),
        );
        expect(whole).toEqual(expected);
      }
  });

  it('steps by mirroring, and turns across the screen', () => {
    const [w, h] = [10, 18];
    const up = pixels(figureGlyph('adult', false, 0), w, h).rows;
    const step = pixels(figureGlyph('adult', false, 1), w, h).rows;
    expect(step).toEqual(up.map((row) => [...row].reverse()));
    // Heading up, the shoulders run across the cell; heading across, down it.
    const across = pixels(figureGlyph('adult', true, 0), w, h).rows;
    const paintIn = (rows: number[][], pick: (x: number, y: number) => boolean) =>
      rows.flatMap((row, y) => row.filter((v, x) => v === 255 && pick(x, y))).length;
    const widest = (rows: number[][]) => Math.max(...rows.map((r) => r.filter((v) => v).length));
    expect(widest(up)).toBeGreaterThan(widest(across));
    expect(paintIn(across, (x) => x === 1 || x === 8)).toBe(0);
  });

  it('draws a 2×2 figure whose four cells piece together, the same turned half round', () => {
    const [w, h] = [10, 18];
    const whole = Array.from({ length: 2 * h }, () => new Array<number>(2 * w).fill(0));
    for (const slice of [0, 1, 2, 3] as const) {
      const { rows } = pixels(figureGlyph('adult', false, 0, { slice }), w, h);
      rows.forEach((row, y) =>
        row.forEach((v, x) => (whole[(slice >> 1) * h + y]![(slice & 1) * w + x] = v)),
      );
    }
    expect(whole.flat().filter((v) => v === 255).length).toBeGreaterThan(20);
    const turned = [...whole].reverse().map((row) => [...row].reverse());
    expect(turned).toEqual(whole);
  });

  it('draws a vendor’s cart as a striped awning', () => {
    const { drawn, rows } = pixels(STALL_GLYPH, 10, 18);
    expect(drawn).toBe(true);
    const inked = rows.map((row) => row.some((v) => v > 0));
    const first = inked.indexOf(true);
    const last = inked.lastIndexOf(true);
    expect(inked.slice(first, last + 1)).toContain(false);
  });
});

describe('glyph set', () => {
  const peddlerGlyphs = ['\uE0C9', '\uE0CA', '\uE0CB'];
  it('appends distinct procedural carts after the complete previous atlas', () => {
    for (const theme of Object.values(themes)) {
      expect(mapGlyphs(theme).slice(415)).toEqual([
        ...FOLKLORE_GLYPHS,
        ...PROCESSION_GLYPHS.slice(4),
        ...peddlerGlyphs,
      ]);
      for (const glyph of peddlerGlyphs) {
        expect(draw(glyph).drawn).toBe(true);
        expect(personGlyphs()).not.toContain(glyph);
        expect(FOLKLORE_GLYPHS).not.toContain(glyph);
      }
    }
  });
  it('draws candles after the complete unchanged atlas prefix in both themes', () => {
    expect(draw(CANDLE_GLYPHS[0]).drawn).toBe(true);
    expect(draw(CANDLE_GLYPHS[0]).at(5, 12)).toBeGreaterThan(0);
    for (const theme of Object.values(themes)) {
      const glyphs = mapGlyphs(theme);
      expect(
        createHash('sha256')
          .update(JSON.stringify(glyphs.slice(0, 415)))
          .digest('hex'),
      ).toBe('35aa289039b8d6935914eaa68161933bdac91f51b6afaeb09d03509683ddf96c');
      expect(glyphs.slice(415)).toEqual([
        ...FOLKLORE_GLYPHS,
        ...PROCESSION_GLYPHS.slice(4),
        ...peddlerGlyphs,
      ]);
      expect(glyphs.slice(408, 409 + PEDESTRIAN_GLYPHS.length)).toEqual([
        ...CANDLE_GLYPHS,
        ...PEDESTRIAN_GLYPHS,
      ]);
      expect(
        createHash('sha256')
          .update(JSON.stringify(glyphs.slice(0, 408)))
          .digest('hex'),
      ).toBe('16ed7be0bf44a29753e324bbc1b56c503efd4d087d13e5bd67c71481ffe16a9b');
    }
  });
  it('fits every map glyph (styles, walls, sextants) in the 1024 slots the glyph table holds', () => {
    for (const theme of Object.values(themes)) {
      const glyphs = mapGlyphs(theme);
      const expected = new Set([
        ...FOLKLORE_GLYPHS,
        ...PROCESSION_GLYPHS,
        ...PUFF_GLYPHS,
        ...fixtureGlyphs,
        ...arrowGlyphs,
        ...SEASONAL_GLYPHS,
        ...CANDLE_GLYPHS,
        ...PEDESTRIAN_GLYPHS,
        ...ACCESS_GLYPHS,
        ...Object.values(theme.styles).flatMap((s) => [...s.glyphs]),
        ...singleWall,
        ...doubleWall,
        ...sextantGlyphs,
        ...rainGlyphs,
        ...vehicleGlyphs(),
        ...personGlyphs(),
        ...birdGlyphs(),
        ...dogGlyphs(),
        ...catGlyphs(),
        streetlightGlyph,
        '\u2584',
        '\u263c',
        '\u2605',
      ]);
      expect(new Set(glyphs)).toEqual(expected);
      // Index 0 of the atlas is blank, so the glyphs take indices 1 on.
      expect(glyphs.length).toBeLessThanOrEqual(MAX_GLYPHS);
      expect(
        glyphs.slice(-PROCESSION_GLYPHS.length - FOLKLORE_GLYPHS.length - peddlerGlyphs.length),
      ).toEqual([
        ...PROCESSION_GLYPHS.slice(0, 4),
        ...FOLKLORE_GLYPHS,
        ...PROCESSION_GLYPHS.slice(4),
        ...peddlerGlyphs,
      ]);
      for (const glyph of [...PROCESSION_GLYPHS, ...FOLKLORE_GLYPHS]) {
        const rendered = draw(glyph);
        expect(rendered.drawn).toBe(true);
        expect(
          Array.from({ length: W * H }, (_, i) => rendered.at(i % W, Math.floor(i / W))).some(
            (pixel) => pixel > 0,
          ),
        ).toBe(true);
      }
    }
  });

  it('keeps label text in its own set', () => {
    for (const g of ['A', 'z', 'ñ', '?']) expect(labelCharacters.includes(g), g).toBe(true);
  });
});
