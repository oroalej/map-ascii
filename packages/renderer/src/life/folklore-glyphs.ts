/** Appended atlas block, leaving every previous glyph index unchanged. */
export const FOLKLORE_GLYPHS = Array.from({ length: 16 }, (_, i) =>
  String.fromCharCode(0xe420 + i),
);
