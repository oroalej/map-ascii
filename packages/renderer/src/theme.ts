export type ThemeName = 'dark' | 'light';

export type Theme = {
  /** Canvas clear color as linear 0–1 RGBA. */
  background: readonly [number, number, number, number];
};

const rgb = (hex: number): readonly [number, number, number, number] => [
  ((hex >> 16) & 0xff) / 255,
  ((hex >> 8) & 0xff) / 255,
  (hex & 0xff) / 255,
  1,
];

// Feature classes, glyphs, and colors from SPEC.md §4 are added in Phase 1.
export const themes: Record<ThemeName, Theme> = {
  dark: { background: rgb(0x04050a) },
  light: { background: rgb(0xf4f1e8) },
};
