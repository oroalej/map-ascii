import { describe, expect, it } from 'vitest';
import {
  packOverlay,
  createOverlay,
  tiltedLabelShows,
  type LabelArea,
  type LabelCandidate,
  LabelRank,
  labelText,
  labelVisibility,
  placeLabels,
  streetMode,
  wrapText,
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

describe('labelText', () => {
  it('spells out characters the label atlas lacks', () => {
    expect(labelText('Ocampo Ⅱ Street')).toBe('Ocampo II Street');
    expect(labelText('Santiago Ⅲ Street')).toBe('Santiago III Street');
    expect(labelText('Tacolod Elementary School – Annex')).toBe(
      'Tacolod Elementary School - Annex',
    );
    expect(labelText('“Plaza” Rizal’s')).toBe(`"Plaza" Rizal's`);
  });

  it('keeps accented Latin letters, which the atlas has', () => {
    expect(labelText('Peñafrancia Basilica')).toBe('Peñafrancia Basilica');
  });
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

describe('tiltedLabelShows', () => {
  const rows = 100;

  it('keeps every label up to 15° (map mode)', () => {
    expect(tiltedLabelShows(LabelRank.street, 0, rows, 15)).toBe(true);
  });

  it('keeps street names to the nearer part of a 60° view, major roads farther', () => {
    expect(tiltedLabelShows(LabelRank.street, 50, rows, 60)).toBe(false);
    expect(tiltedLabelShows(LabelRank.street, 60, rows, 60)).toBe(true);
    expect(tiltedLabelShows(LabelRank.streetMinor, 50, rows, 60)).toBe(false);
    expect(tiltedLabelShows(LabelRank.streetMinor, 60, rows, 60)).toBe(true);
    expect(tiltedLabelShows(LabelRank.roadMajor, 30, rows, 60)).toBe(true);
    expect(tiltedLabelShows(LabelRank.roadMajor, 20, rows, 60)).toBe(false);
  });

  it('raises the far limit with the pitch', () => {
    expect(tiltedLabelShows(LabelRank.street, 30, rows, 30)).toBe(true);
    expect(tiltedLabelShows(LabelRank.street, 30, rows, 50)).toBe(false);
  });

  it('always keeps landmarks and place names', () => {
    for (const rank of [LabelRank.landmark, LabelRank.subdivision, LabelRank.city]) {
      expect(tiltedLabelShows(rank, 0, rows, 60)).toBe(true);
    }
  });
});

describe('placeLabels with a gap', () => {
  it('keeps rows clear above and below each label', () => {
    const labels: LabelCandidate[] = [
      { id: 1, text: 'AB', rank: 0, col: 5, row: 1, mode: 'along' },
      { id: 2, text: 'CD', rank: 0, col: 5, row: 2, mode: 'along' },
      { id: 3, text: 'EF', rank: 0, col: 5, row: 3, mode: 'along' },
    ];
    const placedIds = (gap: number) =>
      placeLabels(createOverlay(12, 6), labels, index, undefined, gap).map((l) => l.id);
    expect(placedIds(0)).toEqual([1, 2, 3]);
    expect(placedIds(1)).toEqual([1, 3]);
  });
});

describe('placeLabels by taken cells', () => {
  it('places the same labels as checking every box taken', () => {
    // A seeded mix of modes, lengths, and anchors, some off the grid, packed tight.
    let seed = 7;
    const rng = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    const words = ['A', 'BC', 'DEF', 'GHIJ', 'KLMNO', 'PQ RS', 'TUV WXY Z'];
    const modes = ['beside', 'along', 'down'] as const;
    const labels: LabelCandidate[] = Array.from({ length: 400 }, (_, id) => ({
      id,
      text: words[Math.floor(rng() * words.length)]!,
      rank: Math.floor(rng() * 4),
      col: Math.floor(rng() * 70) - 5,
      row: Math.floor(rng() * 30) - 5,
      mode: modes[Math.floor(rng() * modes.length)]!,
    }));
    for (const gap of [0, 1]) {
      const byCells = createOverlay(60, 20);
      const byBoxes = { ...createOverlay(60, 20), takenCells: undefined };
      const area = { left: 1, top: 1, right: 59, bottom: 19 };
      const a = placeLabels(byCells, labels, index, area, gap).map((l) => l.id);
      const b = placeLabels(byBoxes, labels, index, area, gap).map((l) => l.id);
      expect(a.length).toBeGreaterThan(10);
      expect(a).toEqual(b);
      expect([...byCells.glyphs]).toEqual([...byBoxes.glyphs]);
    }
  });
});

describe('packOverlay', () => {
  it('packs 16-bit glyph codes into RGBA texels', () => {
    const overlay = { ...createOverlay(1, 1), glyphs: Uint16Array.of(0x1234) };
    expect([...packOverlay(overlay)]).toEqual([0x34, 0x12, 0, 0]);
  });
});
