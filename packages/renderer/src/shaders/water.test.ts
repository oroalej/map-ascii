import { describe, expect, it } from 'vitest';
import { themes } from '../theme';
import { glyphFragmentFor } from './glyph';
import { selectFragment } from './select';

const luminance = (hex: number) =>
  0.2126 * ((hex >> 16) & 255) + 0.7152 * ((hex >> 8) & 255) + 0.0722 * (hex & 255);

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
