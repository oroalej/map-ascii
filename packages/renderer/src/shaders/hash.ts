/** `cellHash` from `glyphs/select.ts` in GLSL: a 32-bit hash of a world cell. */
export const cellHashGlsl = /* glsl */ `uint cellHash(ivec2 c) {
  uvec2 p = uvec2(c);
  uint h = (p.x * 0x8da6b343u) ^ (p.y * 0xd8163841u);
  h ^= h >> 13u;
  h *= 0x5bd1e995u;
  h ^= h >> 15u;
  return h;
}`;
