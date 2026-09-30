import { expect, it } from 'vitest';
import { MAX_CLASSES, classId } from '../classes';
import { themes } from '../theme';
import {
  buildGlyphTables,
  MAX_GLYPHS,
  MAX_VARIANTS,
  packGlyph,
  tableGlyph,
  unpackGlyph,
} from './select';

it('round trips ten-bit glyphs without changing the class', () => {
  expect(MAX_CLASSES).toBeLessThanOrEqual(64);
  for (const glyph of [0, 255, 256, MAX_GLYPHS])
    for (const cls of [0, classId('road_mid'), 63]) {
      const [lo, packed] = packGlyph(glyph, cls);
      expect(unpackGlyph(lo, packed)).toEqual({ glyph, cls });
    }
});

it('retains high glyph bytes in the RG8 lookup table and rejects overflow', () => {
  const tables = buildGlyphTables(themes.dark, () => 1023);
  expect(tableGlyph(tables.table, classId('road_mid') * MAX_VARIANTS)).toBe(1023);
  expect(() => buildGlyphTables(themes.dark, () => 1024)).toThrow('outside');
});
