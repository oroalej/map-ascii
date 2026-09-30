/**
 * A city's climate, as far as the map shows it: which way the wind blows by season (the city
 * pack's `climate`, SPEC.md §4). Zod-free, like `constants.ts`, so the renderer and the web app
 * can use it; the `Climate` schema in `schemas.ts` validates it.
 */

/** How hard the wind blows, calmest first. */
export const WIND_STRENGTHS = ['calm', 'breeze', 'gusty', 'storm'] as const;
export type WindStrength = (typeof WIND_STRENGTHS)[number];

/** A prevailing wind: where it blows from (compass degrees, 0 north, 90 east) and how hard. */
export type PrevailingWind = { from: number; strength: WindStrength };

/** A season's wind, in the months (1–12) it blows. */
export type WindSeason = PrevailingWind & { name?: string; months: number[] };

export type ClimateConfig = {
  /** The seasons' winds; a month in none of them gets `default`. */
  wind: WindSeason[];
  default: PrevailingWind;
  /** Where the seasons come from (content rule: claims carry a source). */
  source: string;
};

/** The wind when a city has no climate: a breeze from the east. */
export const DEFAULT_WIND: PrevailingWind = { from: 90, strength: 'breeze' };

/** The prevailing wind in `month` (1–12). */
export function seasonalWind(climate: ClimateConfig | undefined, month: number): PrevailingWind {
  if (!climate) return DEFAULT_WIND;
  const season = climate.wind.find((s) => s.months.includes(month));
  return season ? { from: season.from, strength: season.strength } : climate.default;
}

/** An arrow pointing the way a wind from `from` degrees blows (for the HUD). */
export function windArrow(from: number): string {
  const arrows = ['↓', '↙', '←', '↖', '↑', '↗', '→', '↘'];
  return arrows[Math.round((((from % 360) + 360) % 360) / 45) % 8]!;
}
