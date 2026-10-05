/** Sourced annual decoration calendars. Runtime matching deliberately has no Zod dependency. */
import { PLACE_KINDS, type RhythmCurve } from './rhythm';
import type { LocalizedText, Source } from './schemas';
import type { SeasonalPoint, CarnivalComponent } from './seasonal-record';
export * from './seasonal-record';

/** Selected source ways, optionally trimmed to the frontage of an OSM feature. */
export type BuntingCorridor = {
  id: string;
  ways: string[];
  from?: string;
  to?: string;
  spacing_m: number;
  style: 'red-yellow-rectangles';
};

export type MonthDay = { month: number; day: number };
export type NthWeekday = { month: number; weekday: number; nth: number; offset_days: number };
export type SeasonWindow =
  | { from: MonthDay; to: MonthDay }
  | { anchor: NthWeekday; days_before: number; days_after: number };
/** Sourced, schematic property grounds; seasonal only, never permanent land cover. */
export type SeasonGrounds = {
  id: string;
  anchor: string;
  ring: SeasonalPoint[];
  sources: Source[];
};
/** Illustrative overhead fireworks, not surveyed launch sites or an event schedule. */
export const FIREWORK_VARIANTS = ['peony', 'chrysanthemum', 'ring', 'willow'] as const;
export type FireworkVariant = (typeof FIREWORK_VARIANTS)[number];
export type FireworksConfig = { label: string; variants: FireworkVariant[] };
/** Places a season's `near` may name: gathering places, plus mapped cemeteries. */
export const SEASON_ANCHOR_KINDS = [...PLACE_KINDS, 'cemetery'] as const;
export type SeasonAnchorKind = (typeof SEASON_ANCHOR_KINDS)[number];
/** Illustrative candles on a seeded `share` of the city's mapped burial markers. */
export type SeasonCandles = { label: string; share: number };
/** Simulated families standing at a seeded `share` of graves, shown by `hours`. */
export type SeasonVisitors = {
  label: string;
  share: number;
  per_grave_family: [number, number];
  max_per_tile: number;
  hours: RhythmCurve;
};
/** Simulated extra crowds around the pack's named landmark churches, shown by `hours`. */
export type SeasonCongregations = {
  label: string;
  landmarks: string[];
  extra: number;
  hours: RhythmCurve;
};
export type SeasonConfig = {
  id: string;
  title: LocalizedText;
  status: 'draft' | 'verified';
  window: SeasonWindow;
  note?: string;
  fireworks?: FireworksConfig;
  grounds?: SeasonGrounds[];
  installations?: SeasonInstallation[];
  lanterns?: { label: string; shape: 'star'; near?: SeasonAnchorKind[]; radius_m?: number };
  bunting?: {
    label: string;
    near: SeasonAnchorKind[];
    radius_m: number;
    spacing_m: number;
    corridors?: BuntingCorridor[];
  };
  stalls?: { label: string; near: SeasonAnchorKind[]; radius_m: number; per_tile: number };
  candles?: SeasonCandles;
  visitors?: SeasonVisitors;
  congregations?: SeasonCongregations;
  sources: Source[];
};

/** Layouts are illustrative; anchors and all geography are resolved by the pipeline. */
export type SeasonInstallation = {
  id: string;
  anchor: string;
  label: string;
  sources: Source[];
  grounds?: string;
} & (
  | { kind: 'christmas-tree'; radius_m: number }
  | {
      kind: 'light-string';
      layout: 'paths' | 'perimeter' | 'building-perimeter' | 'canopy';
      spacing_m: number;
      mount?: 'canopy';
      bulb_spacing_m?: number;
      palette?: 'warm' | 'christmas';
    }
  | { kind: 'decorated-canopy' }
  | {
      kind: 'access-path';
      grounds: string;
      style: 'walkway' | 'driveway' | 'parking';
      points: SeasonalPoint[];
      width_m: number;
    }
  | { kind: 'carnival'; grounds: string; components: CarnivalComponent[] }
);

/** A calendar day, as days since 1970-01-01 (the existing Life clock's arithmetic). */
export const epochDay = (year: number, month: number, day: number): number =>
  Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);

/** Legacy procession semantics include the offset and permit a fifth weekday to spill. */
export function nthWeekdayDay(rule: NthWeekday, year: number): number {
  const first = epochDay(year, rule.month, 1);
  const weekday = (((first + 4) % 7) + 7) % 7;
  return first + ((rule.weekday - weekday + 7) % 7) + (rule.nth - 1) * 7 + rule.offset_days;
}

/** February 29 is an admissible annual rule; February 30 and April 31 never are. */
export function validMonthDay({ month, day }: MonthDay): boolean {
  return (
    Number.isInteger(month) &&
    month >= 1 &&
    month <= 12 &&
    Number.isInteger(day) &&
    day >= 1 &&
    day <= new Date(Date.UTC(2000, month, 0)).getUTCDate()
  );
}
function occurrence(year: number, date: MonthDay): number | undefined {
  const day = epochDay(year, date.month, date.day);
  return new Date(day * 86_400_000).getUTCMonth() + 1 === date.month ? day : undefined;
}

/** Inclusive annual windows; missing leap-day/fifth-weekday occurrences are skipped. */
export function seasonContains(window: SeasonWindow, year: number, day: number): boolean {
  for (const anchorYear of [year - 1, year, year + 1]) {
    let from: number | undefined;
    let to: number | undefined;
    if ('from' in window) {
      const wraps = window.from.month * 32 + window.from.day > window.to.month * 32 + window.to.day;
      from = occurrence(anchorYear, window.from);
      to = occurrence(anchorYear + Number(wraps), window.to);
    } else {
      const anchor = nthWeekdayDay(window.anchor, anchorYear);
      const unshifted = anchor - window.anchor.offset_days;
      if (new Date(unshifted * 86_400_000).getUTCMonth() + 1 !== window.anchor.month) continue;
      from = anchor - window.days_before;
      to = anchor + window.days_after;
    }
    if (from !== undefined && to !== undefined && day >= from && day <= to) return true;
  }
  return false;
}

/** First match in city-pack order; overlapping seasons are intentionally deterministic. */
export function activeSeason<S extends { id: string; window: SeasonWindow }>(
  seasons: readonly S[] | undefined,
  year: number,
  day: number,
): S | undefined {
  return seasons?.find((season) => seasonContains(season.window, year, day));
}

/** Unknown preview IDs fall back to Today, just like migrated browser preferences. */
export function resolveSeason<S extends { id: string; window: SeasonWindow }>(
  seasons: readonly S[] | undefined,
  choice: string | undefined,
  year: number,
  day: number,
): S | undefined {
  return (
    (choice !== 'auto' && seasons?.find((s) => s.id === choice)) || activeSeason(seasons, year, day)
  );
}
