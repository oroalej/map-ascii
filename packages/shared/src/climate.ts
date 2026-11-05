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
  /** What the harvest looks like around the fields; absent means nothing but the fields' color. */
  harvest?: HarvestConfig;
};
export type CropNow = { stage: CropStage; progress: number };

/** A span of the day in hours, `[start, end)`, on the shown clock. */
export type HourSpan = [start: number, end: number];

/** The city's harvest scene (the pack's `climate.crops.rice.harvest`, SPEC.md §4). */
export type HarvestConfig = {
  /** When palay lies spread out to dry; outside these hours it is heaped and covered. */
  dryingHours: HourSpan;
  /** When field piles of straw burn; absent means the city shows no smoke. */
  burningHours?: HourSpan;
  tractors: boolean;
  ducks: boolean;
  source: string;
};

/** The harvest scene at one moment of one crop stage. */
export type HarvestNow = {
  /** Share of drying slots in use, 0–1. */
  drying: number;
  /** Whether palay is out at this hour, rather than heaped and covered. */
  spread: boolean;
  /** Share of working farmers on a hand tractor rather than behind a carabao, 0–1. */
  tractors: number;
  /** Share of flocks out on the harvested paddies, 0–1. */
  ducks: number;
  burning: boolean;
};

const inHours = ([start, end]: HourSpan, minutes: number) =>
  minutes >= start * 60 && minutes < end * 60;

/** Where in `[from, to]` the value `at` falls, clamped to 0–1. */
const ramp = (at: number, from: number, to: number) =>
  Math.min(1, Math.max(0, (at - from) / (to - from)));

/** Progress of `harvested` by which drying, hauling and straw burning are over. */
const DRYING_FADE_END = 0.6;
/** Progress of `harvested` at which straw piled after threshing starts to burn. */
const STRAW_BURNING_START = 0.1;
/** Share of farmers who plow or haul with a hand tractor while the stage calls for one. */
const HAND_TRACTOR_SHARE = 0.5;

/**
 * The harvest scene for a crop stage at `minutes` past midnight. Drying swells through the last
 * half of `ripe` and fades over the first 60 % of `harvested`, so the window follows the calendar
 * rather than dates of its own.
 */
export function harvestAt(
  crop: CropNow | undefined,
  harvest: HarvestConfig | undefined,
  minutes: number,
): HarvestNow | undefined {
  if (!harvest || !crop) return undefined;
  const { stage, progress } = crop;
  const reaped = stage === 'harvested';
  const drying =
    stage === 'ripe' ? ramp(progress, 0.5, 1) : reaped ? 1 - ramp(progress, 0, DRYING_FADE_END) : 0;
  const early = reaped && progress < DRYING_FADE_END;
  return {
    drying,
    spread: inHours(harvest.dryingHours, minutes),
    tractors: harvest.tractors && (stage === 'flooded' || early) ? HAND_TRACTOR_SHARE : 0,
    ducks: harvest.ducks && reaped ? 1 : 0,
    burning:
      harvest.burningHours !== undefined &&
      early &&
      progress >= STRAW_BURNING_START &&
      inHours(harvest.burningHours, minutes),
  };
}

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
  /** Dawn mist over paddies and water; absent means none. */
  mist?: MistConfig;
};

/** How much dawn mist a city gets through the year. */
export type MistConfig = {
  /** Density by month, January first: twelve values in 0–1. */
  months: number[];
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
