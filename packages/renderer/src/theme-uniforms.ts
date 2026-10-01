import type { Theme } from './theme';
import { classId, MAX_CLASSES, renderClasses } from './classes';

const rgb = (hex: number): [number, number, number] => [
  ((hex >> 16) & 255) / 255,
  ((hex >> 8) & 255) / 255,
  (hex & 255) / 255,
];
/** Immutable CPU uniforms, built once when an atlas changes theme. */
export function themeUniforms(theme: Theme) {
  const label = rgb(theme.label);
  const frontageClasses = new Int32Array(MAX_CLASSES);
  for (const cls of renderClasses)
    if (cls.startsWith('building') || cls === 'furniture') frontageClasses[classId(cls)] = 1;
  return {
    label,
    accent: rgb(theme.accent),
    rain: label.map((c, i) => c * [0.82, 0.9, 1][i]!),
    paints: theme.vehiclePaints.flatMap(rgb),
    fixtures: theme.fixturePaints.flatMap(rgb),
    awnings: theme.awningPaints.flatMap(rgb),
    frontageClasses,
    birds: theme.birdPaints.flatMap((pair) => pair.flatMap(rgb)),
  };
}
export type ThemeUniforms = ReturnType<typeof themeUniforms>;
