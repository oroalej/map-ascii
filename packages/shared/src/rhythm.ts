import type { LifeSiteConfig } from './life-sites';
import type { PeddlerConfig } from './peddlers';
import {
  expandSeasons,
  runtimeSeason,
  type SeasonConfig,
  type RuntimeSeasonConfig,
  type SeasonWindow,
} from './seasons';
import type { Source } from './schemas';

/**
 * A city's daily rhythm, as far as the map shows it (SPEC.md §4 "Life layer"): how much of each
 * kind of traffic is out at each hour of the local day. Zod-free, like `climate.ts`, so the
 * renderer and the web app can use it; the `CityLife` schema in `schemas.ts` validates it.
 */

/** The agent kinds that follow the clock (birds follow the sun). */
export const RHYTHM_KINDS = ['vehicle', 'person', 'boat', 'train'] as const;
export type RhythmKind = (typeof RHYTHM_KINDS)[number];

/**
 * How much of a kind is out over the day: points of [local hour 0–24, share 0–1], hours
 * ascending. The share is read straight between points, and wraps from the last point to the
 * first across midnight.
 */
export type RhythmCurve = readonly (readonly [hour: number, share: number])[];

/**
 * The kinds of area people belong to: a commercial `centre` or a residential `home` street. A
 * district's curve is a factor (0–1) on the share of people out, not a share of its own.
 */
export const RHYTHM_DISTRICTS = ['centre', 'home'] as const;
export type RhythmDistrict = (typeof RHYTHM_DISTRICTS)[number];

export type Rhythm = Partial<Record<RhythmKind | RhythmDistrict, RhythmCurve>>;

/** Curves for some days of the week (0 = Sunday), replacing `life.rhythm`'s on those days. */
export type RhythmDay = { weekdays: number[]; rhythm: Rhythm };

/** Places where people gather (SPEC.md §4 "Places"), from the map's features. */
export const PLACE_KINDS = [
  'worship',
  'school',
  'pitch',
  'monument',
  'bench',
  'fountain',
  'farm',
] as const;
export type PlaceKind = (typeof PLACE_KINDS)[number];
/** Seasonal proximity anchors include mapped cemeteries without changing place storage. */
export const SEASON_ANCHOR_KINDS = [...PLACE_KINDS, 'cemetery'] as const;
export type SeasonAnchorKind = (typeof SEASON_ANCHOR_KINDS)[number];

/** Services at places of worship: on these weekdays (0 = Sunday), at these local times. */
export type WorshipSchedule = { weekdays: number[]; times: string[] };

/** School days (0 = Sunday … 6 = Saturday), and when classes start and end. */
export type SchoolSchedule = { weekdays: number[]; in: string; out: string };

/** When a city's shops typically open and close (each keeps its own hours around them). */
export type ShopSchedule = { open: string; close: string };

export type LifeSchedules = {
  /** Crowds at churches around service times; without it, only a few visitors. */
  worship?: WorshipSchedule[];
  /** Crowds at school gates before classes and after; default `DEFAULT_SCHOOL`. */
  school?: SchoolSchedule;
  /** Shops' typical hours, which light them at night (`shopHours`); default `DEFAULT_SHOPS`. */
  shops?: ShopSchedule;
  /** A bakery's typical hours; without it, a bakery keeps a shop's. */
  bakery?: ShopSchedule;
};

/** Illustrative night folklore; schedules describe the simulation, not reported hauntings. */
export const FOLKLORE_SITE_KINDS = ['cemetery', 'worship', 'hospital'] as const;
export type FolkloreSiteKind = (typeof FOLKLORE_SITE_KINDS)[number];

export type FolkloreConfig = {
  hours: { from: number; to: number };
  ghosts: {
    sites: FolkloreSiteKind[];
    per_cemetery: [number, number];
    undas_per_cemetery: [number, number];
    undas_season: string;
    site_share: number;
    range_m: [number, number];
  };
  manananggal: { window: SeasonWindow; night_chance: number };
  sources: Source[];
};

/** Rare illustrative runs; seconds of accepted simulation time, independently seeded. */
export type EmergencyConfig = {
  ambulance?: { max: number; interval_s: [number, number]; dwell_s: [number, number] };
  police?: {
    max: number;
    interval_s: [number, number];
    call_every_s: [number, number];
    call_s: [number, number];
  };
  fire?: { max: number; interval_s: [number, number]; dwell_s: [number, number] };
  exclude?: string[];
  source: string;
};

/** Which kerb or lot a parked vehicle keeps the hours of. */
export const PARKING_SLOTS = ['lot', 'centre', 'home'] as const;
export type ParkingSlot = (typeof PARKING_SLOTS)[number];

/** How full each kind of parking is through the day, as a share of the cars already placed. */
export type ParkingConfig = Record<ParkingSlot, RhythmCurve> & { source: string };

export const FLYWAY_SPECIES = ['egret', 'bat'] as const;
export type FlywaySpecies = (typeof FLYWAY_SPECIES)[number];

/**
 * Birds commuting between a roost and a point along each bearing, in two daily windows of local
 * times: egrets home at dusk and out at dawn, bats out at dusk and home at dawn.
 */
export type FlywayConfig = {
  species: FlywaySpecies;
  /** [lng, lat]. */
  roost: [number, number];
  bearings: number[];
  distance_m: number;
  dusk: [string, string];
  dawn: [string, string];
  source: string;
};

/** Kinds of building that keep their own window hours. */
export const WINDOW_GROUPS = [
  'home',
  'daytime',
  'market',
  'worship',
  'hospital',
  'station',
] as const;
export type WindowGroup = (typeof WINDOW_GROUPS)[number];
export type WindowCurves = Record<WindowGroup, RhythmCurve> & { source: string };

export type CityLifeConfig = {
  peddlers?: PeddlerConfig[];
  folklore?: FolkloreConfig;
  emergency?: EmergencyConfig;
  /** Sourced annual calendars and their illustrative map decorations. */
  seasons?: SeasonConfig[];
  signals?: {
    derive?: boolean;
    add?: {
      id: string;
      position: [number, number];
      linked_junctions?: [number, number][];
      source: string;
    }[];
    remove?: { id: string; osm_id?: number; position?: [number, number]; source: string }[];
  };
  /** Sourced transit-mode overrides and missing stops or shelters. */
  sites?: LifeSiteConfig[];
  /** Curves that replace the defaults, per kind. */
  rhythm?: Rhythm;
  /** Curves that replace `rhythm` on some days of the week; each must agree with it at midnight. */
  rhythm_days?: RhythmDay[];
  /** When places fill up (the pack's own; its `source` covers them). */
  schedules?: LifeSchedules;
  /** Parking that fills and empties through the day; without it, every parked car stays. */
  parking?: ParkingConfig;
  /** Roosts and the lines birds fly to them; without it, birds stay around their own flocks. */
  flyways?: FlywayConfig[];
  /** Presence turns on students walking home from schools; its `source` covers the scene. */
  dismissal?: { source: string };
  /** How many windows show lit through the night, per kind of building; default all the same. */
  windows?: WindowCurves;
  /** Where the rhythm comes from (content rule: claims carry a source). */
  source: string;
};
export type RuntimeCityLife = Omit<CityLifeConfig, 'seasons'> & { seasons?: RuntimeSeasonConfig[] };
export function runtimeCityLife(life: CityLifeConfig): RuntimeCityLife {
  const { seasons, ...general } = life;
  return { ...general, ...(seasons && { seasons: expandSeasons(seasons.map(runtimeSeason)) }) };
}

/**
 * The rhythm when a city gives none: a generic working day, with morning and evening rush
 * hours, a lull after lunch, and quiet small hours. An impression, not traffic data.
 */
export const DEFAULT_RHYTHM: Readonly<Record<RhythmKind, RhythmCurve>> = {
  vehicle: [
    [0, 0.3],
    [4, 0.25],
    [5.5, 0.5],
    [7.5, 1],
    [9.5, 0.75],
    [12, 0.7],
    [14.5, 0.6],
    [17.5, 1],
    [19.5, 0.75],
    [22, 0.45],
  ],
  person: [
    [0, 0.12],
    [4, 0.08],
    [5.5, 0.35],
    [7.5, 0.9],
    [9.5, 0.7],
    [12, 0.8],
    [14.5, 0.6],
    [17.5, 1],
    [19.5, 0.85],
    [22, 0.35],
  ],
  boat: [
    [0, 0.2],
    [4, 0.3],
    [5.5, 0.85],
    [8, 1],
    [12, 0.6],
    [16, 0.85],
    [18.5, 0.5],
    [21, 0.25],
  ],
  train: [
    [0, 0.5],
    [5, 0.6],
    [7, 1],
    [20, 1],
    [22, 0.6],
  ],
};

/** The share of `curve` out at `minutes` past local midnight. */
export function curveAt(curve: RhythmCurve, minutes: number): number {
  const n = curve.length;
  if (n === 0) return 1;
  const hour = (((minutes / 60) % 24) + 24) % 24;
  for (let i = 0; i < n; i++) {
    const [h1, s1] = curve[i]!;
    if (hour < h1) {
      // Between the previous point (the last one, yesterday, before the first) and this one.
      const [h0, s0] = i > 0 ? curve[i - 1]! : [curve[n - 1]![0] - 24, curve[n - 1]![1]];
      return s0 + ((s1 - s0) * (hour - h0)) / (h1 - h0 || 1);
    }
  }
  // After the last point: towards the first one, tomorrow.
  const [h0, s0] = curve[n - 1]!;
  const [h1, s1] = [curve[0]![0] + 24, curve[0]![1]];
  return s0 + ((s1 - s0) * (hour - h0)) / (h1 - h0 || 1);
}

type RhythmLife = Pick<CityLifeConfig, 'rhythm' | 'rhythm_days'>;

/** A city's curve for `key` on `weekday`: that day's, else its everyday one. */
const cityCurve = (
  life: RhythmLife | undefined,
  key: RhythmKind | RhythmDistrict,
  weekday: number | undefined,
): RhythmCurve | undefined =>
  (weekday === undefined
    ? undefined
    : life?.rhythm_days?.find((day) => day.weekdays.includes(weekday))?.rhythm[key]) ??
  life?.rhythm?.[key];

/** A city's curve for `kind` (on `weekday`, when given), or the default. */
export const rhythmFor = (
  life: RhythmLife | undefined,
  kind: RhythmKind,
  weekday?: number,
): RhythmCurve => cityCurve(life, kind, weekday) ?? DEFAULT_RHYTHM[kind];

/** Whether a city's rhythm tells its districts apart at all. */
export const hasDistricts = (life: RhythmLife | undefined) =>
  RHYTHM_DISTRICTS.some(
    (district) =>
      life?.rhythm?.[district] !== undefined ||
      life?.rhythm_days?.some((day) => day.rhythm[district] !== undefined),
  );

/** The factor (0–1) on the people out in `district` at `clock`; 1 without a curve for it. */
export const districtFactor = (
  life: RhythmLife | undefined,
  district: RhythmDistrict,
  clock: { minutes: number; weekday: number },
): number => {
  const curve = cityCurve(life, district, clock.weekday);
  return curve ? curveAt(curve, clock.minutes) : 1;
};

/** The share of a building's cells lit at full night when a city gives no `windows`. */
export const DEFAULT_WINDOW_SHARE = 0.12;

/** The share of windows lit at `minutes` past local midnight, per group. An impression. */
export function windowShares(
  minutes: number,
  life?: Pick<CityLifeConfig, 'windows'>,
): Record<WindowGroup, number> {
  const curves = life?.windows;
  return Object.fromEntries(
    WINDOW_GROUPS.map((group) => [
      group,
      curves ? curveAt(curves[group], minutes) : DEFAULT_WINDOW_SHARE,
    ]),
  ) as Record<WindowGroup, number>;
}

/** School hours when a city gives none: weekdays, 07:00 to 16:00. An impression. */
export const DEFAULT_SCHOOL: SchoolSchedule = {
  weekdays: [1, 2, 3, 4, 5],
  in: '07:00',
  out: '16:00',
};

/** Shops' typical hours when a city gives none: 08:00 to 20:00. An impression. */
export const DEFAULT_SHOPS: ShopSchedule = { open: '08:00', close: '20:00' };

/** A shop's own hours, in minutes past local midnight; or open all night. */
export type ShopHours = { open: number; close: number; allNight: boolean };

/** A number in 0–1 from a shop's seed and a salt (an integer hash), for its own hours. */
function unitOf(seed: number, salt: number): number {
  let h = Math.imul((seed ^ Math.imul(salt, 0x27d4eb2f)) >>> 0, 0x9e3779b1) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca77) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae3d) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * A shop's own hours, fixed by its `seed`, spread around the city's typical hours (`DEFAULT_SHOPS`
 * unless the city gives its own): it opens from 2 hours before the typical time to 1½ after;
 * most (70%) close within an hour of the typical time, some (20%) close early, a few (7%) stay
 * open up to 2½ hours late, and 3% are open all night. With the default, about nine in ten are
 * closed by 21:00. An `early` shop, a bakery, spreads around `schedules.bakery` instead when the
 * city gives it. An impression, not data about any shop.
 */
export function shopHours(
  seed: number,
  life?: Pick<CityLifeConfig, 'schedules'>,
  early = false,
): ShopHours {
  const typical = (early && life?.schedules?.bakery) || life?.schedules?.shops || DEFAULT_SHOPS;
  const day = (m: number) => ((Math.round(m) % 1440) + 1440) % 1440;
  const which = unitOf(seed, 2);
  if (which < 0.03) return { open: 0, close: 0, allNight: true };
  const spread = unitOf(seed, 3);
  const close = minutesOf(typical.close);
  const closing =
    which < 0.23
      ? close - 150 + spread * 90
      : which < 0.93
        ? close - 60 + spread * 120
        : close + 60 + spread * 90;
  const open = minutesOf(typical.open) - 120 + unitOf(seed, 1) * 210;
  return { open: day(open), close: day(closing), allNight: false };
}

/** Whether a shop is open at `minutes` past local midnight (its hours may run past midnight). */
export function shopOpen(hours: ShopHours, minutes: number): boolean {
  if (hours.allNight) return true;
  const m = ((minutes % 1440) + 1440) % 1440;
  const { open, close } = hours;
  return open <= close ? m >= open && m < close : m >= open || m < close;
}

/** When people play on sports grounds: after school and work, most in the late afternoon. */
const PITCH: RhythmCurve = [
  [0, 0],
  [5.5, 0.1],
  [7, 0.3],
  [10, 0.25],
  [12, 0.05],
  [15, 0.4],
  [17, 1],
  [18.5, 0.7],
  [20, 0.1],
];

/** When people work the fields: a morning and a late-afternoon shift, out of the midday heat. */
const FARM: RhythmCurve = [
  [0, 0],
  [5, 0.2],
  [6.5, 1],
  [10, 0.8],
  [11.5, 0.1],
  [14.5, 0.1],
  [15.5, 0.9],
  [17.5, 0.6],
  [18.5, 0],
];

/** A few visitors at a place of worship outside service times: by day, fewer at night. */
const WORSHIP_VISITORS: RhythmCurve = [
  [0, 0.03],
  [5.5, 0.05],
  [7, 0.15],
  [19, 0.15],
  [21, 0.03],
];

export const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return h * 60 + m;
};

/** School letting out, in minutes around `schedules.school.out`. */
export const DISMISSAL = {
  /** The first tricycles come this long before classes end. */
  tricycleLead: 10,
  /** The last students leave this long after, and the last tricycles have gone by this. */
  release: 45,
  tricyclesLeave: 35,
  /** The longest walk there is, so the last of the stream can finish it. */
  lastWalk: 7,
} as const;

/**
 * Minutes after classes end on a school day (negative while tricycles gather), or null outside
 * the scene, so a pack without `life.dismissal` or a quiet hour costs nothing further.
 */
export function dismissalNow(
  clock: Pick<LifeClock, 'minutes' | 'weekday'>,
  life: Pick<CityLifeConfig, 'schedules' | 'dismissal'> | undefined,
): number | null {
  if (!life?.dismissal) return null;
  const school = life.schedules?.school ?? DEFAULT_SCHOOL;
  if (!school.weekdays.includes(clock.weekday)) return null;
  const after = clock.minutes - minutesOf(school.out);
  return after >= -DISMISSAL.tricycleLead && after < DISMISSAL.release + DISMISSAL.lastWalk
    ? after
    : null;
}

/**
 * How far into a window around `center` (minutes past midnight) `minutes` is: 1 from `before`
 * minutes before it to `after` minutes after it, easing over `ramp` minutes at each end, and 0
 * outside. Wraps across midnight.
 */
function inWindow(minutes: number, center: number, before: number, after: number, ramp = 10) {
  const d = ((((minutes - center + 720) % 1440) + 1440) % 1440) - 720;
  if (d < -before - ramp || d > after + ramp) return 0;
  if (d < -before) return (d + before + ramp) / ramp;
  if (d > after) return (after + ramp - d) / ramp;
  return 1;
}

/** The city's local time, as the life layer needs it. */
export type LifeClock = { minutes: number; weekday: number };

/**
 * The share (0–1) of a place's people out at `clock`: at places of worship, a crowd around each
 * service (20 minutes before to an hour after); at schools, crowds at the gates before classes
 * and after, a few during, none on other days; players on pitches mostly late in the afternoon;
 * farm workers in two shifts; and at benches, fountains, and monuments, the city's own rhythm
 * for people.
 */
export function placeShare(
  kind: PlaceKind,
  clock: LifeClock,
  life: Pick<CityLifeConfig, 'rhythm' | 'rhythm_days' | 'schedules'> | undefined,
): number {
  const { minutes, weekday } = clock;
  switch (kind) {
    case 'worship': {
      let share = curveAt(WORSHIP_VISITORS, minutes);
      for (const service of life?.schedules?.worship ?? []) {
        if (!service.weekdays.includes(weekday)) continue;
        for (const time of service.times) {
          share = Math.max(share, inWindow(minutes, minutesOf(time), 20, 60));
        }
      }
      return share;
    }
    case 'school': {
      const school = life?.schedules?.school ?? DEFAULT_SCHOOL;
      if (!school.weekdays.includes(weekday)) return 0.02;
      const start = minutesOf(school.in);
      const end = minutesOf(school.out);
      const gates = Math.max(
        inWindow(minutes, start - 20, 25, 5),
        inWindow(minutes, end + 20, 25, 25),
      );
      const inClass = minutes > start && minutes < end ? 0.1 : 0.02;
      return Math.max(gates, inClass);
    }
    case 'pitch':
      return curveAt(PITCH, minutes);
    case 'farm':
      return curveAt(FARM, minutes);
    case 'bench':
    case 'fountain':
    case 'monument':
      return 0.8 * curveAt(rhythmFor(life, 'person', weekday), minutes);
  }
}
