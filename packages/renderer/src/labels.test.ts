import { describe, expect, it } from 'vitest';
import {
  createOverlay,
  labelVisibility,
  LabelRank,
  packOverlay,
  placeLabels,
  streetMode,
  wrapText,
  type LabelArea,
  type LabelCandidate,
} from './labels';

// A toy glyph index: ASCII letters and '?' map to their char code; anything else is unknown.
const index = (c: string) => (/^[A-Za-z?]$/.test(c) ? c.charCodeAt(0) : undefined);

/** Render a placed grid back to text: '.' empty, '_' halo or space, letters as themselves. */
function render(grid: ArrayLike<number>, cols: number): string[] {
  const rows: string[] = [];
  for (let y = 0; y < grid.length / cols; y++) {
    let row = '';
    for (let x = 0; x < cols; x++) {
      const v = grid[y * cols + x]!;
      row += v === 0 ? '.' : v === 1 ? '_' : String.fromCharCode(v - 1);
    }
    rows.push(row);
  }
  return rows;
}

/** Place labels on a fresh overlay and return its glyph codes. */
function placeLabelsGrid(
  candidates: LabelCandidate[],
  cols: number,
  rows: number,
  glyphIndex: (c: string) => number | undefined,
  area?: LabelArea,
) {
  const overlay = createOverlay(cols, rows);
  placeLabels(overlay, candidates, glyphIndex, area);
  return overlay.glyphs;
}

const label = (over: Partial<LabelCandidate>): LabelCandidate => ({
  id: 1,
  text: 'Plaza',
  rank: LabelRank.landmark,
  col: 5,
  row: 1,
  ...over,
});

describe('labelVisibility', () => {
  it('is full inside the band and fades over half a level outside it', () => {
    expect(labelVisibility({ min: 16 }, 15.4)).toBe(0);
    expect(labelVisibility({ min: 16 }, 15.75)).toBeCloseTo(0.5);
    expect(labelVisibility({ min: 16 }, 16)).toBe(1);
    expect(labelVisibility({ min: 16 }, 21)).toBe(1);
    expect(labelVisibility({ min: 0, max: 9.5 }, 9.5)).toBe(1);
    expect(labelVisibility({ min: 0, max: 9.5 }, 9.75)).toBeCloseTo(0.5);
    expect(labelVisibility({ min: 0, max: 9.5 }, 10)).toBe(0);
  });
});

describe('placeLabels while fading', () => {
  const long = label({ text: 'Plaza Quince Martires Plaza Rizal', col: 20, row: 2 });
  const place = (vis: number) => {
    const overlay = createOverlay(40, 8);
    const placed = placeLabels(overlay, [{ ...long, vis }], index);
    return { glyphs: [...overlay.glyphs], taken: overlay.taken, placed };
  };
  const drawn = (glyphs: number[]) => glyphs.filter((g) => g !== 0).length;

  it('keeps about that share of its cells, the same ones every time', () => {
    const full = drawn(place(1).glyphs);
    const half = drawn(place(0.5).glyphs);
    expect(half).toBeGreaterThan(full * 0.3);
    expect(half).toBeLessThan(full * 0.7);
    expect(place(0.5).glyphs).toEqual(place(0.5).glyphs);
  });

  it('still takes its whole box, so neighbors do not jump', () => {
    const { taken, placed } = place(0.1);
    expect(taken).toEqual(place(1).taken);
    expect(placed).toHaveLength(1);
  });

  it('draws exactly as before when fully shown', () => {
    expect(place(1).glyphs).toEqual([...placeLabelsGrid([long], 40, 8, index)]);
  });
});

describe('wrapText', () => {
  it('wraps at word boundaries', () => {
    expect(wrapText('Naga Metropolitan Cathedral')).toEqual(['Naga Metropolitan', 'Cathedral']);
    expect(wrapText('  Plaza   Rizal ')).toEqual(['Plaza Rizal']);
    expect(wrapText('Supercalifragilistic', 10)).toEqual(['Supercalifragilistic']);
    expect(wrapText('')).toEqual([]);
  });
});

describe('streetMode', () => {
  const deg = (d: number) => (d * Math.PI) / 180;

  it('puts names on near-horizontal and near-vertical streets, beside the rest', () => {
    expect([0, 15, 180, -170, 200].map((d) => streetMode(deg(d)))).toEqual(Array(5).fill('along'));
    expect([90, 75, -95, 270].map((d) => streetMode(deg(d)))).toEqual(Array(4).fill('down'));
    expect([30, 45, 135, -45].map((d) => streetMode(deg(d)))).toEqual(Array(4).fill('beside'));
  });
});

describe('placeLabels on streets', () => {
  it('writes a name along a horizontal street, over its cells', () => {
    const grid = placeLabelsGrid(
      [label({ text: 'Elias', col: 5, row: 1, mode: 'along' })],
      11,
      3,
      index,
    );
    expect(render(grid, 11)).toEqual(['...........', '.._Elias_..', '...........']);
  });

  it('writes a name down a vertical street, one letter per row', () => {
    const grid = placeLabelsGrid(
      [label({ text: 'Abc', col: 1, row: 2, mode: 'down' })],
      3,
      5,
      index,
    );
    expect(render(grid, 3)).toEqual(['._.', '.A.', '.b.', '.c.', '._.']);
  });

  it('places one name per street nearby, and again far away', () => {
    const ways = [
      label({ id: 1, text: 'Elias', col: 5, row: 1, mode: 'along' }),
      label({ id: 2, text: 'Elias', col: 20, row: 1, mode: 'along' }),
      label({ id: 3, text: 'Elias', col: 50, row: 1, mode: 'along' }),
    ];
    const row = render(placeLabelsGrid(ways, 60, 3, index), 60)[1]!;
    expect(row.match(/Elias/g)).toHaveLength(2);
  });
});

describe('placeLabels', () => {
  it('centers the label below its anchor with a one-cell halo', () => {
    expect(render(placeLabelsGrid([label({})], 11, 4, index), 11)).toEqual([
      '...........',
      '...........',
      '.._Plaza_..',
      '...........',
    ]);
  });

  it('goes above when there is no room below', () => {
    expect(render(placeLabelsGrid([label({ row: 2 })], 11, 3, index), 11)).toEqual([
      '...........',
      '.._Plaza_..',
      '...........',
    ]);
  });

  it('goes right, then left, when only the anchor row is available', () => {
    expect(
      render(placeLabelsGrid([label({ col: 1, row: 0, text: 'Ab' })], 8, 1, index), 8),
    ).toEqual(['.._Ab_..']);
    expect(
      render(placeLabelsGrid([label({ col: 7, row: 0, text: 'Ab' })], 8, 1, index), 8),
    ).toEqual(['..._Ab_.']);
  });

  it('never overlaps: lower ranks go first, then lower ids', () => {
    const grid = placeLabelsGrid(
      [
        label({ id: 9, text: 'Statue', rank: LabelRank.monument, row: 2 }),
        label({ id: 2, text: 'Plaza', row: 2 }),
        label({ id: 1, text: 'Cathedral', row: 2 }),
      ],
      13,
      5,
      index,
    );
    expect(render(grid, 13)).toEqual([
      '.............',
      '.._Plaza_....', // rank 0, id 2: below is taken, so above
      '......_Statue', // rank 1 goes last: above and below are taken, so right
      '_Cathedral_..', // rank 0, id 1: placed first, below
      '.............',
    ]);
  });

  it('keeps text inside the given area (e.g. the on-screen cells)', () => {
    const area = { left: 1, top: 1, right: 10, bottom: 3 };
    // Below (row 1) is inside; with the area starting at row 1, "above" would not be.
    const rows = render(placeLabelsGrid([label({ row: 0 })], 11, 4, index, area), 11);
    expect(rows[1]).toBe('.._Plaza_..');
    // A one-row area where below, above, right, and left all fall outside it.
    const strip = { left: 1, top: 1, right: 10, bottom: 2 };
    const none = placeLabelsGrid([label({ row: 1 })], 11, 4, index, strip);
    expect(none.every((v) => v === 0)).toBe(true);
  });

  it('drops a label that fits nowhere', () => {
    const grid = placeLabelsGrid([label({ text: 'Toolongforthisgrid' })], 8, 3, index);
    expect(grid.every((v) => v === 0)).toBe(true);
  });

  it('draws characters the atlas lacks as ?', () => {
    expect(render(placeLabelsGrid([label({ text: 'Peña' })], 11, 3, index), 11)[2]).toBe(
      '.._Pe?a_...',
    );
  });

  it('wraps long names onto centered lines', () => {
    const grid = placeLabelsGrid(
      [label({ col: 10, row: 0, text: 'Naga Metropolitan Cathedral' })],
      21,
      4,
      index,
    );
    expect(render(grid, 21).slice(1, 3)).toEqual([
      '._Naga_Metropolitan_.',
      '._____Cathedral_____.',
    ]);
  });
});

describe('packOverlay', () => {
  it('packs 16-bit glyph codes into RGBA texels', () => {
    const overlay = { ...createOverlay(1, 1), glyphs: Uint16Array.of(0x1234) };
    expect([...packOverlay(overlay)]).toEqual([0x34, 0x12, 0, 0]);
  });
});
