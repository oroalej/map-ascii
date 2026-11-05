import { describe, expect, it } from 'vitest';
import { bootGlyphFragment } from './boot';
import { glyphFragmentFor } from './glyph';

const mistCalls = (source: string) => source.match(/o_color = vec4\(mistOver\(/g)?.length ?? 0;

describe('mistOver', () => {
  it.each([
    ['full', {}],
    ['without seasonal ornaments', { seasonal: false }],
    ['with nothing optional', { seasonal: false, focus: false, effectClocks: false }],
  ])('wraps every map output %s, leaving the labels alone', (_, options) => {
    const source = glyphFragmentFor(options);
    expect(source).toContain('vec3 mistOver(vec3 color, ivec2 cell, vec2 grid, int cls)');
    // The ground fixture's agent, the agent, the empty cell and the map's own ink.
    expect(mistCalls(source)).toBe(4);
    // Every map output goes through it; only labels and the background return without.
    const outputs = source.match(/o_color = vec4\((?!mistOver)[^\n]+/g) ?? [];
    for (const output of outputs) expect(output).not.toContain('rainOver');
    expect(source).toContain('o_color = vec4(mix(u_background, u_labelColor, ink), 1.0);');
  });

  it('pays one branch outside the mist, so u_mist = 0 keeps today', () => {
    const source = glyphFragmentFor();
    const body = source.slice(source.indexOf('vec3 mistOver('));
    const first = body.slice(body.indexOf('{') + 1).trimStart();
    expect(first.startsWith('if (u_mist <= 0.0) return color;')).toBe(true);
  });

  it('keeps off roofs, crowns and focus, and softens banks with four taps', () => {
    const source = glyphFragmentFor();
    expect(source).toContain('if (u_focus || cls == u_crownClass || (u_cellBits[cls] &');
    const body = source.slice(
      source.indexOf('vec3 mistOver('),
      source.indexOf('bool fixtureSurface('),
    );
    expect(body).toContain('i < 4');
    expect(body.match(/texelFetch/g)).toHaveLength(1);
  });

  it('stays out of the boot shaders', () => {
    expect(bootGlyphFragment).not.toContain('u_mist');
  });
});
