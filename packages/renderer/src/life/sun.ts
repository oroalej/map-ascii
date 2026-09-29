/**
 * The sun, for the day/night look (SPEC.md §4 "Life layer"): its altitude over a place at a
 * moment, from the low-precision solar coordinates of the Astronomical Almanac (good to about a
 * degree, plenty for lighting). Computed on the client from the clock, so it is not live data.
 */

const RAD = Math.PI / 180;
/** J2000.0: 2000-01-01 12:00 UTC. */
const J2000_MS = Date.UTC(2000, 0, 1, 12);
const DAY_MS = 86_400_000;

/** The sun's altitude above the horizon in degrees at `date`, seen from `lng`, `lat`. */
export function solarAltitude(date: Date, lng: number, lat: number): number {
  const d = (date.getTime() - J2000_MS) / DAY_MS;
  const g = (357.529 + 0.98560028 * d) * RAD;
  const q = 280.459 + 0.98564736 * d;
  const longitude = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const obliquity = (23.439 - 0.00000036 * d) * RAD;
  const ra = Math.atan2(Math.cos(obliquity) * Math.sin(longitude), Math.cos(longitude));
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(longitude));
  const gmstHours = 18.697374558 + 24.06570982441908 * d;
  const hourAngle = (gmstHours * 15 + lng) * RAD - ra;
  const phi = lat * RAD;
  const sinAlt =
    Math.sin(phi) * Math.sin(declination) +
    Math.cos(phi) * Math.cos(declination) * Math.cos(hourAngle);
  return Math.asin(Math.max(-1, Math.min(1, sinAlt))) / RAD;
}

/**
 * How much daylight there is, 0 (night) to 1 (day), from the sun's altitude: full above 6°,
 * none below -6° (the end of civil twilight), smooth between.
 */
export function daylight(altitude: number): number {
  const t = Math.min(1, Math.max(0, (altitude + 6) / 12));
  return t * t * (3 - 2 * t);
}
