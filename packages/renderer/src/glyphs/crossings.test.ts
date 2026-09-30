import { expect, it } from 'vitest';
import { crossingGlyph } from './select';
it('uses existing transverse stripe glyphs and alternates at fine scale', () => {
  expect(crossingGlyph(0, 2, 1)).toBe('═');
  expect(crossingGlyph(128, 2, 1)).toBe('║');
  expect(crossingGlyph(0, 0.5, 1)).toBe(' ');
  expect(crossingGlyph(0, 0.5, 2)).toBe('═');
});
