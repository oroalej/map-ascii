/**
 * Appended atlas block, leaving every previous glyph index unchanged. Ghosts use the first six; the
 * rest stay blank so later glyphs keep their places (the manananggal has `manananggal-sprite.ts`).
 */
export const GHOST_GLYPHS = 6;
export const FOLKLORE_GLYPHS = Array.from({ length: 16 }, (_, i) =>
  String.fromCharCode(0xe420 + i),
);
