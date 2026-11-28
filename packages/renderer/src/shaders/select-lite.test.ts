import { describe, expect, it } from 'vitest';
import { selectFragment, selectLiteFragment, stubbed } from './select';

describe('stubbed', () => {
  const signature = 'vec2 shade(ivec2 p, float self)';

  it('replaces the body of the named function only', () => {
    const source = `float a() { return 1.0; }\n${signature} {\n  if (p.x > 0) { return vec2(self); }\n  return vec2(0.0);\n}\nfloat b() { return 2.0; }`;
    expect(stubbed(source, signature, 'return vec2(0.0);')).toBe(
      `float a() { return 1.0; }\n${signature} { return vec2(0.0); }\nfloat b() { return 2.0; }`,
    );
  });

  it('finds the function once the build has dropped the spaces around punctuation', () => {
    const source = 'float a(){return 1.0;}\nvec2 shade(ivec2 p,float self){\nreturn vec2(self);\n}';
    expect(stubbed(source, signature, 'return vec2(0.0);')).toBe(
      'float a(){return 1.0;}\nvec2 shade(ivec2 p,float self){ return vec2(0.0); }',
    );
  });

  it('fails loudly on a function the shader no longer has', () => {
    expect(() => stubbed('float a() {}', signature, '')).toThrow('no function');
    // A longer name is another function.
    expect(() => stubbed('vec2 shader(ivec2 p, float self) {}', signature, '')).toThrow();
  });
});

describe('selectLiteFragment', () => {
  it('is the full shader with its costly functions emptied', () => {
    expect(selectLiteFragment.length).toBeLessThan(selectFragment.length);
    expect(selectLiteFragment).toContain('int partyWallMask(ivec2 p) { return -2; }');
    expect(selectLiteFragment).toContain('const bool u_shadows = false;');
  });
});
