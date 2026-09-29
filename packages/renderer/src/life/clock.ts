/**
 * The city's clock (SPEC.md §4 "Life layer"): the local date and time a moment is in the city,
 * which the daily rhythm, the fixed times of day, the seasons, and processions follow, whatever
 * the visitor's own time zone.
 */

const DAY_MS = 86_400_000;

/** A calendar day, as days since 1970-01-01. */
export const dayNumber = (year: number, month: number, day: number) =>
  Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);

/** Where the city's clock is: an IANA time zone, else the sun's time at a longitude. */
export type ClockZone = { timezone?: string | undefined; lng: number };

export type LocalTime = {
  year: number;
  /** 1–12. */
  month: number;
  /** The calendar day, as days since 1970-01-01. */
  day: number;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
  /** Minutes past local midnight, with seconds. */
  minutes: number;
};

const formats = new Map<string, Intl.DateTimeFormat>();
const formatFor = (timezone: string) => {
  let format = formats.get(timezone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    });
    formats.set(timezone, format);
  }
  return format;
};

/** The local date and time of `date` in `timezone` (an IANA name). */
export function localTime(date: Date, timezone: string): LocalTime {
  const parts = formatFor(timezone).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const year = get('year');
  const month = get('month');
  const day = dayNumber(year, month, get('day'));
  return {
    year,
    month,
    day,
    // 1970-01-01 was a Thursday (4).
    weekday: (((day + 4) % 7) + 7) % 7,
    minutes: get('hour') * 60 + get('minute') + date.getSeconds() / 60,
  };
}

/**
 * The local date and time of `date` in the city: by its time zone, or without one, by the sun
 * (mean solar time at its longitude, 15° an hour).
 */
export function cityTime(date: Date, zone: ClockZone): LocalTime {
  if (zone.timezone) return localTime(date, zone.timezone);
  const shifted = new Date(date.getTime() + (zone.lng / 15) * 3_600_000);
  const day = Math.floor(shifted.getTime() / DAY_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day,
    weekday: (((day + 4) % 7) + 7) % 7,
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes() + shifted.getUTCSeconds() / 60,
  };
}

/** The moment it is `minutes` past midnight in the city, on the city's day of `date`. */
export function atCityMinutes(date: Date, zone: ClockZone, minutes: number): Date {
  const local = cityTime(date, zone);
  return new Date(date.getTime() + (minutes - local.minutes) * 60_000);
}
