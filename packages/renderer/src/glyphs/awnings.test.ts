import { expect, it } from 'vitest';
import { awningSide, awningCode } from './select';
import { mapGlyphs, themes } from '../theme';
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
    expect(mapGlyphs(theme).length).toBe(262);
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
