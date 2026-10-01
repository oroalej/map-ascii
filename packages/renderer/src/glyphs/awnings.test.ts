import { expect, it } from 'vitest';
import { awningSide, awningCode, packGlyph, unpackGlyph } from './select';
import { mapGlyphs, themes } from '../theme';
import { classId, renderClasses } from '../classes';
import { themeUniforms } from '../theme-uniforms';

it('colors eligible classes above 31 without aliasing unrelated classes', () => {
  const { frontageClasses } = themeUniforms(themes.dark);
  expect(classId('building_station')).toBeGreaterThan(31);
  for (const cls of renderClasses)
    expect(frontageClasses[classId(cls)]).toBe(
      Number(cls.startsWith('building') || cls === 'furniture'),
    );
  const packed = packGlyph(290, classId('building_station'));
  expect(unpackGlyph(...packed)).toEqual({ glyph: 290, cls: classId('building_station') });
});
it('uses each outward side only within the three-cell probe reach', () => {
  for (let side = 0; side < 4; side++)
    for (let distance = 1; distance <= 4; distance++) {
      const outside = [0, 1, 2, 3].map((i) => i === side);
      expect(awningSide(outside, (s, d) => s === side && d === distance)).toBe(
        distance <= 3 ? side : -1,
      );
      if (distance > 1)
        expect(
          awningSide(
            outside,
            (s, d) => s === side && d === distance,
            () => true,
          ),
        ).toBe(-1);
    }
});
it('limits awnings to outside walls facing a street within three cells', () => {
  expect(
    awningSide([true, false, true, false], (side, distance) => side === 2 && distance === 3),
  ).toBe(2);
  expect(awningSide([false, false, false, false], () => true)).toBe(-1);
  expect(awningSide([true, true, true, true], (_side, distance) => distance === 4)).toBe(-1);
  expect(awningCode(3, 0)).toBe(7);
  expect(awningCode(3, 1)).toBe(8);
  expect(
    awningSide(
      [true, false, false, false],
      (_side, distance) => distance === 3,
      (_side, distance) => distance === 2,
    ),
  ).toBe(-1);
});
it('adds only one map glyph and eight awning paints per theme', () => {
  const channel = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = (rgb: readonly number[]) =>
    rgb.slice(0, 3).reduce((y, c, i) => y + channel(c) * [0.2126, 0.7152, 0.0722][i]!, 0);
  for (const theme of Object.values(themes)) {
    expect(mapGlyphs(theme).filter((glyph) => glyph === '¤')).toHaveLength(1);
    expect(theme.awningPaints).toHaveLength(8);
    expect(theme.styles.furniture!.glyphs.slice(9, 12)).toEqual(['¤', '¤', '¤']);
    const back = luminance(theme.background);
    for (const paint of theme.awningPaints) {
      const ink = luminance([
        ((paint >> 16) & 255) / 255,
        ((paint >> 8) & 255) / 255,
        (paint & 255) / 255,
      ]);
      expect((Math.max(back, ink) + 0.05) / (Math.min(back, ink) + 0.05)).toBeGreaterThanOrEqual(3);
    }
  }
});
