import { describe, expect, it } from 'vitest';
import { GLINT } from '../glyphs/select';
import { LIFE_WAKE } from '../life/config';
import { themes } from '../theme';
import { glyphFragmentFor } from './glyph';
import { selectFragment } from './select';

const luminance = (hex: number) =>
  0.2126 * ((hex >> 16) & 255) + 0.7152 * ((hex >> 8) & 255) + 0.0722 * (hex & 255);

describe('sun glint', () => {
  it('needs the water detail, and a sun on it', () => {
    const source = glyphFragmentFor();
    expect(source).toContain('if (u_waterDepth && u_sunGlint > 0.0 && (water || paddy)) {');
    expect(source).toContain('u_sunGlint * directSun() * inPatch');
  });

  it('holds still with reduced motion, and leaves the moon as it was', () => {
    const source = glyphFragmentFor();
    expect(source).toContain(
      'int blockBeat = u_shimmer ? int(floor(u_time * 0.125 + blockStagger)) : 0;',
    );
    expect(source).toContain('< 0.04 * u_moon * night) glow += vec3(0.55, 0.6, 0.72) * 0.6;');
  });

  it('keeps the mean share at the peak: the patch gain undoes the patches', () => {
    const smooth = (t: number) => {
      const c = Math.min(1, Math.max(0, t));
      return c * c * (3 - 2 * c);
    };
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += smooth((i / 255 - 0.45) / 0.4);
    expect((sum / 256) * GLINT.patchGain).toBeCloseTo(1, 1);
  });
});

describe('wakes', () => {
  it('draws only on water, behind the detail gate', () => {
    const source = glyphFragmentFor();
    expect(source).toContain(
      `bool wakeCell = u_waterDepth && water && shadowByte == ${LIFE_WAKE};`,
    );
    expect(source).toContain('float wakeFoam = wakeCell ? float(lifeClass) / 63.0 : 0.0;');
    expect(source).toContain('if (wakeGlyph != 0) glyph = wakeGlyph;');
    expect(source).toContain('vec3 foam = u_waterFoam');
    expect(source).toContain('back = mix(back, foam * shade, wakeFoam');
  });
});

describe('water depth', () => {
  it('writes depth only for water, and 1 with the water detail off', () => {
    expect(selectFragment).toMatch(/o_shade = vec4\(shade, !u_waterDepth \? 1\.0 : kind == \d+ \?/);
  });

  it('tones water only behind the detail gate, for an unhighlighted cell', () => {
    const source = glyphFragmentFor();
    expect(source).toMatch(/bool waterTones = u_waterDepth && state == 0;/);
    const uses = source.match(/waterToned\(/g)?.length ?? 0;
    const gated = source.match(/waterTones && [^\n]*waterToned\(|if \(waterTones/g)?.length ?? 0;
    // The declaration, and three uses behind the gate.
    expect(uses).toBe(4);
    expect(gated).toBe(3);
  });

  it('has a lighter bank than deep in both themes', () => {
    for (const theme of Object.values(themes))
      expect(luminance(theme.waterBank)).toBeGreaterThan(luminance(theme.waterDeep));
  });
});
