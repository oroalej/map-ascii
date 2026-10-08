import { expect, it } from 'vitest';
import { CROP_STAGE, CROP, CropGlyph } from '../glyphs/select';
import { vegetationGlsl } from './vegetation';
import { selectFragment } from './select';
import { glyphFragment } from './glyph';

it('generates stage codes and selection arithmetic from the CPU constants', () => {
  expect(vegetationGlsl).not.toContain('\\n');
  for (const [name, value] of Object.entries(CROP_STAGE))
    if (Number.isInteger(value))
      expect(vegetationGlsl).toContain(`const int CROP_${name.toUpperCase()} = ${value};`);
  expect(vegetationGlsl).toContain(
    `valueNoise(c, ${CROP.ripeScale}, ${CROP.ripeSeed}) > threshold`,
  );
  expect(vegetationGlsl).toContain(`: ${CropGlyph.water}`);
  expect(selectFragment).toContain('if (u_cropStage >= 0)');
  expect(selectFragment).toContain(
    'cropCell(w, front.x, dir, u_cropStage, u_cropProgress, u_time, tone)',
  );
  expect(selectFragment).toContain('v = min(cropVariant(w, front.x, dir), u_count[cls] - 1)');
  expect(selectFragment).toContain('? windLevel(front.x, front.y) : 0');
});
it('uses the stage/tone pigment distinction for farmland ink, background and focus fill', () => {
  expect(glyphFragment).toContain('cls != u_farmlandClass || u_cropStage < 0');
  expect(glyphFragment).toContain('water ? u_cropWaterTint : u_cropTint');
  expect(glyphFragment).toContain('fillOf(bgClass, daylit(cropPigment(bgClass');
  expect(glyphFragment).toContain('toned(daylit(cropPigment(cls, tone)), tone, night)');
  expect(glyphFragment).toContain(
    'focusedClass(cls) ? mix(fillOf(cls, daylit(cropPigment(cls, tone)))',
  );
});
