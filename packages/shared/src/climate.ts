/**
 * A city's climate, as far as the map shows it: which way the wind blows by season (the city
 * pack's `climate`, SPEC.md §4). Zod-free, like `constants.ts`, so the renderer and the web app
 * can use it; the `Climate` schema in `schemas.ts` validates it.
 */

import { epochDay, occurrence, validMonthDay } from './seasons';

export const CROP_STAGES = [
  'fallow',
  'flooded',
  'transplanted',
  'growing',
  'ripe',
  'harvested',
] as const;
export type CropStage = (typeof CROP_STAGES)[number];
/** A city-calendar stage beginning on canonical MM-DD, until the next entry. */
export type CropCalendarEntry = { from: string; stage: CropStage };
export type CropCalendar = {
  calendar: CropCalendarEntry[];
  source: string;
  notes?: string;
};
export type CropNow = { stage: CropStage; progress: number };

/** Parse an annual crop date without accepting rolled-over or noncanonical dates. */
export function cropDate(from: string): { month: number; day: number } | undefined {
  if (!/^\d{2}-\d{2}$/.test(from)) return undefined;
  const date = { month: Number(from.slice(0, 2)), day: Number(from.slice(3)) };
  return validMonthDay(date) ? date : undefined;
}

/** Resolve a validated calendar on a zero-based city day, preserving leap-day semantics. */
export function cropStageAt(
  crops: ClimateConfig['crops'],
  year: number,
  dayOfYear: number,
): CropNow | undefined {
  if (!crops?.rice) return undefined;
  const day = epochDay(year, 1, 1) + dayOfYear;
  const starts = [year - 1, year, year + 1]
    .flatMap((y) =>
      crops.rice!.calendar.flatMap((entry) => {
        const date = cropDate(entry.from);
        if (!date) throw new Error(`Invalid crop date: ${entry.from}`);
        const start = occurrence(y, date);
        return start === undefined ? [] : [{ day: start, stage: entry.stage }];
      }),
    )
    .sort((a, b) => a.day - b.day);
  const nextIndex = starts.findIndex((start) => start.day > day);
  const start = starts[nextIndex - 1];
  const next = starts[nextIndex];
  if (!start || !next) throw new Error('Crop calendar must contain an annual stage start');
  return { stage: start.stage, progress: (day - start.day) / (next.day - start.day) };
}

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
  crops?: { rice?: CropCalendar };
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
