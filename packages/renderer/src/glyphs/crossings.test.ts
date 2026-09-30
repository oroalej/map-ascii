import { expect, it } from 'vitest';
import {
  arrowVariant,
  ARROW_VARIANT,
  crossingGlyph,
  curbOutside,
  Dir,
  markingGlyph,
  wallMask,
} from './select';
import { Flags, Marking, markingByte, markingOf } from '../classes';
import { arrowGlyphs } from '../theme';

it('selects all arrow directions and compensates for taller cells', () => {
  for (let bin = 0; bin < 8; bin++) {
    expect(arrowVariant(bin * 45, 1)).toBe(ARROW_VARIANT + bin);
    expect(markingGlyph(markingByte(Marking.arrow, bin * 45), 1, 0, 1)).toBe(arrowGlyphs[bin]);
  }
  expect(arrowVariant(20, 1)).toBe(ARROW_VARIANT);
  expect(arrowVariant(20, 1.8)).toBe(ARROW_VARIANT + 1);
  expect(markingGlyph(markingByte(Marking.stop, 0), 1, 0, 1)).toBe('─');
  expect(markingGlyph(markingByte(Marking.stop, 90), 1, 0, 1)).toBe('│');
  expect(markingGlyph(markingByte(Marking.stop, 180), 1, 0, 1)).toBe('─');
});

it('keeps the curb next to sidewalks while looking through ordinary paths', () => {
  expect(curbOutside('path')).toBe(false);
  expect(curbOutside('path', Flags.sidewalk)).toBe(true);
  const mask = wallMask((dx, dy) =>
    curbOutside(dy < 0 ? 'path' : 'road_mid', dy < 0 ? Flags.sidewalk : 0),
  );
  expect(mask).toBe(Dir.E | Dir.W);
});

it('preserves stripe orientation at the old bearing boundaries', () => {
  for (let tenth = 0; tenth < 1800; tenth++) {
    const bearing = tenth / 10;
    const old = Math.round((bearing / 180) * 255);
    const byte = markingByte(Marking.crosswalk, bearing);
    expect(crossingGlyph(byte, 2, 0)).toBe(old < 64 || old >= 191 ? '═' : '║');
    expect(Math.abs(markingOf(byte).bearingDeg - bearing)).toBeLessThan(360 / 64);
  }
});

it('round trips marking kind and wrapped direction within one bearing step', () => {
  for (const kind of Object.values(Marking))
    for (const bearing of [-90, 0, 44, 90, 134, 180, 270, 359, 720]) {
      const decoded = markingOf(markingByte(kind, bearing));
      const wanted = ((bearing % 360) + 360) % 360;
      const difference = Math.abs(decoded.bearingDeg - wanted);
      expect(decoded.kind).toBe(kind);
      expect(Math.min(difference, 360 - difference)).toBeLessThan(360 / 64);
    }
});
it('uses existing transverse stripe glyphs and alternates at fine scale', () => {
  expect(crossingGlyph(0, 2, 1)).toBe('═');
  expect(crossingGlyph(markingByte(Marking.crosswalk, 90), 2, 1)).toBe('║');
  expect(crossingGlyph(0, 0.5, 1)).toBe(' ');
  expect(crossingGlyph(0, 0.5, 2)).toBe('═');
});
