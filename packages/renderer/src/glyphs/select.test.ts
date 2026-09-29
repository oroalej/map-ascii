import { describe, expect, it } from 'vitest';
import { classId, MAX_CLASSES, type RenderClass } from '../classes';
import { buildingRamp, doubleLine, sextantGlyphs, singleLine, themes } from '../theme';
import {
  buildGlyphTables,
  buildingVariant,
  cellHash,
  connects,
  Dir,
  EXTRUDE_ROW,
  extrusionVariant,
  FALLING,
  kindCodes,
  MAX_VARIANTS,
  OUTLINE_ZOOM,
  patternVariant,
  rampVariant,
  RIDGE_VARIANT,
  ridgeGlyphs,
  ridgeVariant,
  RISING,
  ROAD_AREA_ZOOM,
  roadClasses,
  roadMask,
  roadVariant,
  roofCode,
  RoofCode,
  roofVariant,
  seeThrough,
  seeThroughMask,
  selectGlyph,
  SEXTANT_ROW,
  sextantMask,
  isEdgeMask,
  subcellEdge,
  type Sample,
  WALL_DOUBLE_ROW,
  WALL_SINGLE_ROW,
  wallGlyph,
  wallMask,
  wallStyle,
  waterVariant,
  type CellContext,
  type WallStyle,
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

describe('terrain ramp', () => {
  it('maps elevation bands (1 = lowest) onto . : - = + * # %', () => {
    expect([1, 2, 8, 9, 0].map((band) => rampVariant(band, 8))).toEqual([0, 1, 7, 7, 0]);
    const at = (height: number) =>
      selectGlyph(themes.dark, 'terrain', { ...sketch(['.'], {}), height });
    expect([1, 4, 8].map(at)).toEqual(['.', '=', '%']);
  });
});

describe('boundaries and the coast', () => {
  it('join their own class like roads, and subdivisions also meet the city boundary', () => {
    expect(connects('coastline', 'coastline')).toBe(true);
    expect(connects('coastline', 'road_major')).toBe(false);
    expect(connects('admin_subdivision', 'admin_city')).toBe(true);
    expect(connects('admin_city', 'admin_subdivision')).toBe(false);
  });

  it('are looked through by outlines and curbs', () => {
    expect(seeThrough).toContain('admin_city');
    expect(seeThrough).toContain('admin_subdivision');
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

  const riverAt = (rows: string[], y = 0, cls: RenderClass = 'water_river') =>
    selectGlyph(themes.dark, cls, {
      ...sketch(rows, { w: 'water_river', s: 'water_sea', l: 'water_area' }),
      y,
    });

  it('draws a thin river that runs down the screen as a wavy stroke', () => {
    expect(riverAt(['.w.', '.w.', '.w.'], 0)).toBe('(');
    expect(riverAt(['.w.', '.w.', '...'], 1)).toBe(')');
  });

  it('draws a diagonal thin river with slashes', () => {
    expect(riverAt(['..w', '.w.', 'w..'])).toBe('╱');
    expect(riverAt(['w..', '.w.', '..w'])).toBe('╲');
  });

  it('keeps animated water for horizontal runs, areas, and lone cells', () => {
    const animated = ['~', '≈'];
    expect(animated).toContain(riverAt(['...', 'www', '...']));
    expect(animated).toContain(riverAt(['www', 'www', 'www']));
    expect(animated).toContain(riverAt(['...', '.w.', '...']));
    // Any water counts as a neighbor: a river meeting the sea is part of it.
    expect(animated).toContain(riverAt(['.w.', 'sws', '...']));
  });

  it('draws lakes and the sea as animated water even where they are thin', () => {
    expect(['≈', '~']).toContain(riverAt(['.l.', '.l.', '.l.'], 0, 'water_area'));
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
    expect(tables.kinds[classId('admin_city')]).toBe(kindCodes.road);
    // Place names are labels (the overlay), never cells.
    expect(tables.kinds[classId('place_label')]).toBe(0);
    expect(tables.counts[classId('park')]).toBe(3);
    const mask = tables.connects[classId('path')]!;
    expect(mask & (1 << classId('road_major'))).not.toBe(0);
    expect(mask & (1 << classId('building'))).toBe(0);
    expect(tables.colors[classId('marker_landmark') * 3]).toBeCloseTo(0xff / 255);
  });

  it('records each class fill, none for lines and markers', () => {
    expect(tables.fills[classId('building')]).toBeGreaterThan(0);
    expect(tables.fills[classId('water_sea')]).toBeGreaterThan(0);
    expect(tables.fills[classId('path')]).toBe(0);
    expect(tables.fills[classId('marker_landmark')]).toBe(0);
  });

  it('holds the sextants by mask in two rows past the classes', () => {
    const at = (mask: number) =>
      tables.table[(SEXTANT_ROW + (mask >> 5)) * MAX_VARIANTS + (mask & 31)];
    for (const mask of [1, 21, 31, 32, 42, 62]) expect(at(mask)).toBe(index(sextantGlyphs[mask]!));
    expect(SEXTANT_ROW + 1).toBeLessThan(EXTRUDE_ROW);
  });
});

describe('sub-cell edges', () => {
  const B: Sample = { cls: 'building', id: 7 };
  const B2: Sample = { cls: 'building_school', id: 8 };
  const P: Sample = { cls: 'park', id: 3 };
  const R: Sample = { cls: 'road_mid', id: 5 };
  const _: Sample = { cls: null, id: 0 };
  const never = () => false;

  it('packs samples row by row from the top left', () => {
    expect(sextantMask((col) => col === 0)).toBe(21); // ▌
    expect(sextantMask((_col, row) => row === 0)).toBe(3);
    expect(sextantMask(() => true)).toBe(63);
    expect([isEdgeMask(0), isEdgeMask(63), isEdgeMask(21)]).toEqual([false, false, true]);
  });

  it("draws an area's edge with the other class behind it", () => {
    // Building on the left half, park on the right.
    expect(subcellEdge(B, [B, P, B, P, B, P], never)).toEqual({ fg: B, mask: 21, bg: 'park' });
    // Two buildings side by side keep their own shapes.
    expect(subcellEdge(B, [B, B2, B, B2, B, B], never)).toEqual({
      fg: B,
      mask: 0b110101,
      bg: 'building_school',
    });
  });

  it('keeps the glyph inside an area and where a line wins the cell', () => {
    expect(subcellEdge(B, [B, B, B, B, B, B], never)).toBeNull();
    expect(subcellEdge(R, [B, B, R, R, B, B], never)).toBeNull();
    expect(subcellEdge(_, [_, _, _, _, _, _], never)).toBeNull();
  });

  it('gives an empty cell the edge of an area that reaches into it', () => {
    expect(subcellEdge(_, [_, _, _, _, P, P], never)).toEqual({ fg: P, mask: 48, bg: null });
  });

  it('draws a building over the park it stands in', () => {
    expect(subcellEdge(P, [P, P, P, B, P, B], never)).toEqual({ fg: B, mask: 40, bg: 'park' });
  });

  it('leaves outlined features to their walls', () => {
    const outlined = (s: Sample) => s.cls === 'building';
    expect(subcellEdge(B, [B, P, B, P, B, P], outlined)).toBeNull();
  });
});

/** Wall glyph for the cell marked `@` in a sketch where `#` and `@` are the feature. */
function wallAt(rows: string[], style: WallStyle = 'single'): string | null {
  const y = rows.findIndex((r) => r.includes('@'));
  const x = rows[y]!.indexOf('@');
  const mask = wallMask((dx, dy) => !'#@'.includes(rows[y + dy]?.[x + dx] ?? '.'));
  return mask === null ? null : wallGlyph(style, mask);
}

/** Mark cell (x, y) of a sketch with `@`. */
const mark = (rows: string[], x: number, y: number) =>
  rows.map((r, j) => (j === y ? r.slice(0, x) + '@' + r.slice(x + 1) : r));

describe('building outlines', () => {
  it('draws the edges and corners of a rectangle, leaving the inside', () => {
    const box = ['......', '.####.', '.####.', '.####.', '......'];
    const at = (x: number, y: number) => wallAt(mark(box, x, y));
    expect([at(1, 1), at(2, 1), at(4, 1)]).toEqual(['┌', '─', '┐']);
    expect([at(1, 2), at(2, 2), at(4, 2)]).toEqual(['│', null, '│']);
    expect([at(1, 3), at(2, 3), at(4, 3)]).toEqual(['└', '─', '┘']);
  });

  it('turns concave corners the right way', () => {
    // An L-shape whose notch is at the bottom right of the marked cell.
    expect(wallAt(['.....', '.###.', '.#@#.', '.##..', '.##..'])).toBe('┌');
  });

  it('draws no false junctions where a building is two cells thick', () => {
    expect(wallAt(['.....', '.#@#.', '.###.', '.....'])).toBe('─');
    expect(wallAt(['.....', '.###.', '.#@#.', '.....'])).toBe('─');
  });

  it('draws a one-cell building as a square, and double walls for landmarks', () => {
    expect(wallAt(['...', '.@.', '...'])).toBe('□');
    expect(wallAt(['.....', '.@##.', '.###.', '.###.'], 'double')).toBe('╔');
  });

  it('outlines landmarks from z17 and every building from z18', () => {
    expect(wallStyle('building', true, 15, 16.9)).toBeNull();
    expect(wallStyle('building', true, 15, OUTLINE_ZOOM.landmark)).toBe('double');
    expect(wallStyle('diagonal', true, 0, 17.5)).toBe('single'); // a landmark plaza
    expect(wallStyle('building', false, 6, 17.9)).toBeNull();
    expect(wallStyle('building', false, 6, OUTLINE_ZOOM.building)).toBe('single');
    expect(wallStyle('diagonal', false, 0, 19)).toBeNull();
  });

  it('never outlines grounds (building classes without a height)', () => {
    expect(wallStyle('building', false, 0, 19)).toBeNull();
  });

  it('looks through paths, statues, and markers', () => {
    expect(seeThrough).toEqual(expect.arrayContaining(['path', 'monument', 'marker_landmark']));
    expect(seeThroughMask() & (1 << classId('path'))).not.toBe(0);
    expect(seeThroughMask() & (1 << classId('road_minor'))).toBe(0);
  });

  it('puts the wall glyphs in the last two table rows', () => {
    const glyphs = new Map<string, number>();
    const index = (g: string) => {
      if (!glyphs.has(g)) glyphs.set(g, glyphs.size + 1);
      return glyphs.get(g)!;
    };
    const { table } = buildGlyphTables(themes.dark, index);
    expect(table[WALL_SINGLE_ROW * MAX_VARIANTS + (Dir.E | Dir.S)]).toBe(index('┌'));
    expect(table[WALL_DOUBLE_ROW * MAX_VARIANTS + (Dir.E | Dir.S)]).toBe(index('╔'));
    expect(table[WALL_SINGLE_ROW * MAX_VARIANTS]).toBe(index('□'));
  });
});

describe('Place-level ground detail', () => {
  it('draws carriageways as strips from ROAD_AREA_ZOOM, with the other roads in one mask', () => {
    expect(ROAD_AREA_ZOOM).toBeGreaterThanOrEqual(OUTLINE_ZOOM.building);
    const mask = roadMask();
    for (const cls of roadClasses) expect(mask & (1 << classId(cls))).not.toBe(0);
    expect(mask & (1 << classId('path'))).toBe(0);
  });

  it('marks the cell a ridge line crosses, else the lit or shaded slope', () => {
    expect(roofCode(0.4, 1)).toBe(RoofCode.ridge);
    expect(roofCode(-0.5, 1)).toBe(RoofCode.ridge);
    expect(roofCode(0.6, 1)).toBe(RoofCode.lit);
    expect(roofCode(-3, 1)).toBe(RoofCode.shaded);
  });

  it('draws slopes ▓ (lit) and ▒ (shaded)', () => {
    expect(buildingRamp[roofVariant(RoofCode.lit, 0, 1.8)!]).toBe('▓');
    expect(buildingRamp[roofVariant(RoofCode.shaded, 0, 1.8)!]).toBe('▒');
    expect(roofVariant(RoofCode.none, 0, 1.8)).toBeNull(); // no ridge: the height ramp stays
  });

  it('draws the ridge along its direction, judged in cell units', () => {
    const glyph = (degrees: number) =>
      ridgeGlyphs[ridgeVariant(Math.round((degrees / 180) * 255), 1.8) - RIDGE_VARIANT];
    expect(glyph(0)).toBe('─');
    expect(glyph(90)).toBe('│');
    expect(glyph(179)).toBe('─');
    // Cells are 1.8× taller than wide: a 30° ridge in the world runs at about 18° in cells.
    expect(glyph(30)).toBe('─');
    // Running corner to corner of a cell (about 61°), down-right is ╲ and down-left is ╱.
    expect(glyph(61)).toBe('╲');
    expect(glyph(119)).toBe('╱');
    // Square cells: 45° is the diagonal.
    expect(ridgeGlyphs[ridgeVariant(Math.round(0.25 * 255), 1) - RIDGE_VARIANT]).toBe('╲');
  });

  it('puts the ridge glyphs after the ramp in the building row', () => {
    const glyphs = new Map<string, number>();
    const index = (g: string) => {
      if (!glyphs.has(g)) glyphs.set(g, glyphs.size + 1);
      return glyphs.get(g)!;
    };
    const { table } = buildGlyphTables(themes.dark, index);
    expect(table[EXTRUDE_ROW * MAX_VARIANTS + RIDGE_VARIANT + 2]).toBe(index('│'));
  });

  it('picks furniture glyphs by variant, falling back to a dot', () => {
    const at = (variant: number) =>
      selectGlyph(themes.dark, 'furniture', { ...sketch(['.'], {}), variant });
    expect([0, 1, 2, 3, 9].map(at)).toEqual(['•', '╥', '○', '¶', '¶']);
  });

  it('dashes barriers and joins them only to each other', () => {
    const legend = { b: 'barrier', r: 'road_minor' } as const;
    const at = (rows: string[]) => selectGlyph(themes.dark, 'barrier', sketch(rows, legend));
    expect(at(['.b.', '.b.', '.b.'])).toBe('┆');
    expect(at(['...', 'bbb', '...'])).toBe('┄');
    expect(connects('barrier', 'road_minor')).toBe(false);
  });
});

describe('3D buildings', () => {
  it('draws roofs solid and shades walls ░▒▓ by facing', () => {
    expect(buildingRamp[extrusionVariant(0, true)]).toBe('█');
    expect([10, 100, 200].map((shade) => buildingRamp[extrusionVariant(shade, false)])).toEqual([
      '░',
      '▒',
      '▓',
    ]);
  });
});
