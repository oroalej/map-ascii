import { expect, it } from 'vitest';
import { themes } from '../theme';
import {
  CROP_STAGE,
  CropGlyph,
  cropCell,
  cropTint,
  cropTone,
  cropVariant,
  DEFAULT_WIND_DIR,
  Tone,
  variantFor,
} from './select';

it('preserves growing start and absent-calendar cells exactly, with monotonic ripening', () => {
  for (let y = -32; y < 32; y++)
    for (let x = -32; x < 32; x++) {
      expect(cropCell(x, y, 0.7, DEFAULT_WIND_DIR, CROP_STAGE.growing, 0)).toEqual({
        variant: cropVariant(y, 0.7, DEFAULT_WIND_DIR),
        tone: cropTone(x, y),
      });
      const end = cropCell(x, y, 0.7, DEFAULT_WIND_DIR, CROP_STAGE.growing, 1);
      expect(cropCell(x, y, 0.7, DEFAULT_WIND_DIR, CROP_STAGE.ripe, 0)).toEqual(end);
      let golden = false;
      for (const stage of [CROP_STAGE.growing, CROP_STAGE.ripe])
        for (const p of [0, 0.5, 1]) {
          const cell = cropCell(x, y, 0.7, DEFAULT_WIND_DIR, stage, p);
          if (golden) expect(cell.tone).toBe(Tone.dry);
          golden ||= cell.tone === Tone.dry;
        }
      expect(
        variantFor('crop', 'farmland', 10, {
          x,
          y,
          time: 0,
          wind: 0,
          height: 0,
          neighbor: () => null,
        }),
      ).toBe(cropVariant(y));
    }
});
it('uses stable, bounded roles in both themes and freezes flooded shimmer at time zero', () => {
  for (const theme of Object.values(themes)) {
    expect(theme.styles.farmland!.glyphs.slice(5)).toEqual(['≈', '.', ',', '·', ':']);
    const pigment = theme.styles.farmland!.color;
    const channels = [(pigment >> 16) & 255, (pigment >> 8) & 255, pigment & 255];
    const water = cropTint(CROP_STAGE.flooded).waterTint.map((scale, i) => scale * channels[i]!);
    expect(water[2]).toBeGreaterThan(water[0]!);
    expect(water[2]).toBeGreaterThan(water[1]!);
    for (let stage = 0; stage < 6; stage++)
      for (let y = -10; y < 10; y++)
        for (let x = -10; x < 10; x++) {
          const cell = cropCell(x, y, 1, DEFAULT_WIND_DIR, stage, 0.7, 100);
          expect(cell.variant).toBeLessThan(theme.styles.farmland!.glyphs.length);
          expect(cell.variant).toBeGreaterThanOrEqual(0);
        }
  }
  const water = cropCell(-2, -4, 1, DEFAULT_WIND_DIR, CROP_STAGE.flooded, 0.5);
  expect(water).toEqual({ variant: CropGlyph.water, tone: Tone.light });
  expect(cropCell(-2, -4, 0, DEFAULT_WIND_DIR, CROP_STAGE.flooded, 0.5)).toEqual(water);
  expect(cropCell(0, -3, 1, DEFAULT_WIND_DIR, CROP_STAGE.transplanted, 1).tone).toBe(Tone.light);
  expect(cropTint()).toEqual({ tint: [1, 1, 1], waterTint: [1, 1, 1] });
  expect(cropTint(CROP_STAGE.growing)).toEqual(cropTint());
  expect(cropTint(CROP_STAGE.transplanted).tint).toEqual([1, 1, 1]);
  expect(cropTint(CROP_STAGE.transplanted).waterTint[2]).toBeGreaterThan(1);
});
