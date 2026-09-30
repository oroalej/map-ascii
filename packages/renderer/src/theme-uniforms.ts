import type { Theme } from './theme';
import { classId, renderClasses } from './classes';

const rgb = (hex: number): [number, number, number] => [
  ((hex >> 16) & 255) / 255,
  ((hex >> 8) & 255) / 255,
  (hex & 255) / 255,
];
/** Immutable CPU uniforms, built once when an atlas changes theme. */
export function themeUniforms(theme: Theme) {
  const label = rgb(theme.label);
  return {
    label,
    accent: rgb(theme.accent),
    rain: label.map((c, i) => c * [0.82, 0.9, 1][i]!),
    paints: theme.vehiclePaints.flatMap(rgb),
    fixtures: theme.fixturePaints.flatMap(rgb),
    awnings: theme.awningPaints.flatMap(rgb),
    frontageMask: renderClasses.reduce(
      (mask, cls) =>
        cls.startsWith('building') || cls === 'furniture' ? mask | (1 << classId(cls)) : mask,
      0,
    ),
    birds: theme.birdPaints.flatMap((pair) => pair.flatMap(rgb)),
  };
}
export type ThemeUniforms = ReturnType<typeof themeUniforms>;
