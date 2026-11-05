import type { Theme } from './theme';

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
    birds: theme.birdPaints.flatMap((pair) => pair.flatMap(rgb)),
    mistCool: rgb(theme.mist[0]),
    mistWarm: rgb(theme.mist[1]),
    waterBank: rgb(theme.waterBank),
    waterDeep: rgb(theme.waterDeep),
    waterGlint: rgb(theme.waterGlint),
  };
}
export type ThemeUniforms = ReturnType<typeof themeUniforms>;
