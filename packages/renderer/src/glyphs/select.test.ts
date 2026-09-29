import { describe, expect, it } from 'vitest';
import { classId, MAX_CLASSES, type RenderClass } from '../classes';
import { doubleLine, singleLine, themes } from '../theme';
import {
  buildGlyphTables,
  buildingVariant,
  cellHash,
  connects,
  Dir,
  FALLING,
  kindCodes,
  MAX_VARIANTS,
  patternVariant,
  RISING,
  roadVariant,
  selectGlyph,
  waterVariant,
  type CellContext,
} from './select';

/** A cell context whose neighbors come from a small ASCII sketch centered on the cell. */
function sketch(rows: string[], legend: Record<string, RenderClass>): CellContext {
  const cy = Math.floor(rows.length / 2);
  const cx = Math.floor(rows[0]!.length / 2);
  return {
    x: 0,
    y: 0,
    height: 0,
    time: 0,
    neighbor: (dx, dy) => legend[rows[cy + dy]?.[cx + dx] ?? '.'] ?? null,
  };
}

const roadAt = (rows: string[], cls: RenderClass = 'road_mid') =>
  selectGlyph(themes.dark, cls, sketch(rows, { r: 'road_mid', R: 'road_major', p: 'path' }));

describe('road connectivity LUT', () => {
  it('maps every N/E/S/W mask to the matching box-drawing glyph', () => {
    const expected: Record<number, [string, string]> = {
      0: ['─', '═'],
      [Dir.N]: ['│', '║'],
      [Dir.E]: ['─', '═'],
      [Dir.N | Dir.E]: ['└', '╚'],
      [Dir.S]: ['│', '║'],
      [Dir.N | Dir.S]: ['│', '║'],
      [Dir.E | Dir.S]: ['┌', '╔'],
      [Dir.N | Dir.E | Dir.S]: ['├', '╠'],
      [Dir.W]: ['─', '═'],
      [Dir.N | Dir.W]: ['┘', '╝'],
      [Dir.E | Dir.W]: ['─', '═'],
      [Dir.N | Dir.E | Dir.W]: ['┴', '╩'],
      [Dir.S | Dir.W]: ['┐', '╗'],
      [Dir.N | Dir.S | Dir.W]: ['┤', '╣'],
      [Dir.E | Dir.S | Dir.W]: ['┬', '╦'],
      [Dir.N | Dir.E | Dir.S | Dir.W]: ['┼', '╬'],
    };
    for (let mask = 0; mask < 16; mask++) {
      expect([singleLine[mask], doubleLine[mask]], `mask ${mask}`).toEqual(expected[mask]);
    }
  });

  it('reads the mask from neighbors, with north up', () => {
    expect(roadAt(['.r.', 'rr.', '...'])).toBe('┘');
    expect(roadAt(['...', '.rr', '.r.'])).toBe('┌');
    expect(roadAt(['.r.', 'rrr', '.r.'])).toBe('┼');
    expect(roadAt(['...', 'rrr', '.r.'])).toBe('┬');
    expect(roadAt(['.R.', 'RRR', '...'], 'road_major')).toBe('╩');
  });

  it('draws diagonal steps only when no orthogonal neighbor joins', () => {
    expect(roadVariant(0, true, false)).toBe(RISING);
    expect(roadVariant(0, false, true)).toBe(FALLING);
    expect(roadVariant(Dir.W, true, false)).toBe(Dir.W);
    expect(roadAt(['..r', '.r.', 'r..'])).toBe('╱');
    expect(roadAt(['r..', '.r.', '..r'])).toBe('╲');
    expect(roadAt(['...', '.r.', '...'])).toBe('─');
  });

  it('joins road classes to each other, and paths to roads, but not roads to paths', () => {
    expect(connects('road_minor', 'road_major')).toBe(true);
    expect(connects('path', 'road_minor')).toBe(true);
    expect(connects('road_minor', 'path')).toBe(false);
    expect(connects('road_minor', 'building')).toBe(false);
    expect(connects('road_minor', null)).toBe(false);
    expect(roadAt(['.p.', 'rrr', '...'])).toBe('─');
    expect(roadAt(['.p.', '.p.', '.r.'], 'path')).toBe(':');
  });
});

describe('building ramp', () => {
  it('maps height onto ░▒▓█', () => {
    expect([0, 2.9, 3, 6, 7, 11, 12, 60].map(buildingVariant)).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
    const at = (height: number) =>
      selectGlyph(themes.dark, 'building', { ...sketch(['.'], {}), height });
    expect([0, 6, 9, 30].map(at)).toEqual(['░', '▒', '▓', '█']);
  });
});

describe('area patterns', () => {
  it('forms diagonals and rows from world cell coordinates', () => {
    expect([0, 1, 2, 3].map((x) => patternVariant('diagonal', x, 0, 3))).toEqual([0, 1, 2, 0]);
    expect(patternVariant('diagonal', 1, 1, 3)).toBe(patternVariant('diagonal', 2, 0, 3));
    expect([0, 1, 2].map((y) => patternVariant('rows', 5, y, 2))).toEqual([0, 1, 0]);
    expect(patternVariant('rows', 0, -1, 2)).toBe(1);
  });

  it('scatters deterministically within the glyph count', () => {
    for (let x = 0; x < 50; x++) {
      const v = patternVariant('scatter', x, 7, 3);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(3);
      expect(patternVariant('scatter', x, 7, 3)).toBe(v);
    }
  });
});

describe('water', () => {
  it('uses a stable 32-bit cell hash', () => {
    expect(cellHash(12, 34)).toBe(cellHash(12, 34));
    expect(cellHash(12, 34)).not.toBe(cellHash(34, 12));
    expect(cellHash(0x7fffffff, 1)).toBeLessThan(2 ** 32);
    expect(cellHash(0x7fffffff, 1)).toBeGreaterThanOrEqual(0);
  });

  it('alternates each cell over time, at different phases', () => {
    const flips = (x: number, y: number) => {
      const seen = new Set<number>();
      for (let t = 0; t < 10; t += 0.25) seen.add(waterVariant(x, y, t));
      return seen;
    };
    expect(flips(3, 4)).toEqual(new Set([0, 1]));
    const atZero = Array.from({ length: 20 }, (_, x) => waterVariant(x, 0, 0));
    expect(new Set(atZero)).toEqual(new Set([0, 1]));
  });

  it('holds still with reduced motion (time 0)', () => {
    expect(waterVariant(5, 5, 0)).toBe(cellHash(5, 5) % 2);
  });
});

describe('glyph tables', () => {
  const glyphs = new Map<string, number>();
  const index = (g: string) => {
    if (!glyphs.has(g)) glyphs.set(g, glyphs.size + 1);
    return glyphs.get(g)!;
  };
  const tables = buildGlyphTables(themes.dark, index);

  it('fills a row per class with its glyphs, padding with the last one', () => {
    const row = (cls: RenderClass) => [
      ...tables.table.slice(classId(cls) * MAX_VARIANTS, classId(cls) * MAX_VARIANTS + 20),
    ];
    expect(row('road_major').slice(0, 18)).toEqual(doubleLine.map(index));
    expect(row('building').slice(0, 5)).toEqual(['░', '▒', '▓', '█', '█'].map(index));
    expect(tables.table.length).toBe(MAX_VARIANTS * MAX_CLASSES);
  });

  it('records kinds, counts, connectivity, and colors', () => {
    expect(tables.kinds[classId('road_mid')]).toBe(kindCodes.road);
    expect(tables.kinds[classId('admin_city')]).toBe(0);
    expect(tables.counts[classId('park')]).toBe(3);
    const mask = tables.connects[classId('path')]!;
    expect(mask & (1 << classId('road_major'))).not.toBe(0);
    expect(mask & (1 << classId('building'))).toBe(0);
    expect(tables.colors[classId('marker_landmark') * 3]).toBeCloseTo(0xff / 255);
  });
});
