/**
 * The moon, for moonlit nights (SPEC.md §4 "Life layer"): how high it stands over a place at a
 * moment and how much of it is lit, from the low-precision lunar and solar coordinates of the
 * Astronomical Almanac (good to a degree or so, plenty for lighting). Computed on the client from
 * the clock, so it is not live data.
 */

const RAD = Math.PI / 180;
/** J2000.0: 2000-01-01 12:00 UTC. */
const J2000_MS = Date.UTC(2000, 0, 1, 12);
const DAY_MS = 86_400_000;
/** The obliquity of the ecliptic. */
const OBLIQUITY = 23.4397 * RAD;
/** The sun's mean distance, km. */
const SUN_DISTANCE_KM = 149_598_000;

const days = (date: Date) => (date.getTime() - J2000_MS) / DAY_MS;
const rightAscension = (l: number, b: number) =>
  Math.atan2(Math.sin(l) * Math.cos(OBLIQUITY) - Math.tan(b) * Math.sin(OBLIQUITY), Math.cos(l));
const declination = (l: number, b: number) =>
  Math.asin(Math.sin(b) * Math.cos(OBLIQUITY) + Math.cos(b) * Math.sin(OBLIQUITY) * Math.sin(l));

/** The moon's right ascension, declination (radians), and distance (km), `d` days from J2000. */
function moonCoords(d: number) {
  const l = RAD * (218.316 + 13.176396 * d); // mean longitude
  const m = RAD * (134.963 + 13.064993 * d); // mean anomaly
  const f = RAD * (93.272 + 13.22935 * d); // mean distance from its ascending node
  const longitude = l + RAD * 6.289 * Math.sin(m);
  const latitude = RAD * 5.128 * Math.sin(f);
  return {
    ra: rightAscension(longitude, latitude),
    dec: declination(longitude, latitude),
    distance: 385_001 - 20_905 * Math.cos(m),
  };
}

/** The sun's right ascension and declination (radians), `d` days from J2000. */
function sunCoords(d: number) {
  const m = RAD * (357.5291 + 0.98560028 * d);
  const center = RAD * (1.9148 * Math.sin(m) + 0.02 * Math.sin(2 * m) + 0.0003 * Math.sin(3 * m));
  const longitude = m + center + RAD * 102.9372 + Math.PI;
  return { ra: rightAscension(longitude, 0), dec: declination(longitude, 0) };
}

/** The moon's altitude above the horizon in degrees at `date`, seen from `lng`, `lat`. */
export function moonAltitude(date: Date, lng: number, lat: number): number {
  const d = days(date);
  const { ra, dec } = moonCoords(d);
  const sidereal = RAD * (280.16 + 360.9856235 * d) + lng * RAD;
  const hourAngle = sidereal - ra;
  const phi = lat * RAD;
  const sinAlt =
    Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(hourAngle);
  return Math.asin(Math.max(-1, Math.min(1, sinAlt))) / RAD;
}

/** How much of the moon's face is lit at `date`: 0 at new moon, 1 at full moon. */
export function moonIllumination(date: Date): number {
  const d = days(date);
  const sun = sunCoords(d);
  const moon = moonCoords(d);
  const elongation = Math.acos(
    Math.sin(sun.dec) * Math.sin(moon.dec) +
      Math.cos(sun.dec) * Math.cos(moon.dec) * Math.cos(sun.ra - moon.ra),
  );
  const phase = Math.atan2(
    SUN_DISTANCE_KM * Math.sin(elongation),
    moon.distance - SUN_DISTANCE_KM * Math.cos(elongation),
  );
  return (1 + Math.cos(phase)) / 2;
}

const smoothstep = (lo: number, hi: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
};

/**
 * How much moonlight falls at `date` on `lng`, `lat`, 0–1: how much of the moon is lit, while
 * it is up (fading in from just below the horizon to 15° up).
 */
export function moonlight(date: Date, lng: number, lat: number): number {
  return moonIllumination(date) * smoothstep(-3, 15, moonAltitude(date, lng, lat));
}
