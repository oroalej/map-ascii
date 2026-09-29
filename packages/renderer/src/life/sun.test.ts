import { describe, expect, it } from 'vitest';
import { daylight, solarAltitude } from './sun';

// Naga City's Centro.
const lng = 123.19;
const lat = 13.62;
const equinox = new Date(Date.UTC(2026, 2, 20));

/** The moment on `day`'s UTC date when local mean solar time at `lng` is `hours`. */
const atSolarHour = (hours: number, lng: number, day: Date) =>
  new Date(day.getTime() + (hours - lng / 15) * 3_600_000);

describe('solarAltitude', () => {
  it('puts the sun high at solar noon and far below at midnight', () => {
    expect(solarAltitude(atSolarHour(12, lng, equinox), lng, lat)).toBeCloseTo(90 - lat, -1);
    expect(solarAltitude(atSolarHour(0, lng, equinox), lng, lat)).toBeLessThan(-60);
  });

  it('puts the sun near the horizon at 6:00 and 18:00 on the equinox', () => {
    expect(Math.abs(solarAltitude(atSolarHour(6, lng, equinox), lng, lat))).toBeLessThan(3);
    expect(Math.abs(solarAltitude(atSolarHour(18, lng, equinox), lng, lat))).toBeLessThan(3);
  });

  it('matches the clock: noon in Manila time is daytime in Naga, 02:00 is night', () => {
    // UTC+8.
    expect(solarAltitude(new Date('2026-06-21T04:00:00Z'), lng, lat)).toBeGreaterThan(60);
    expect(solarAltitude(new Date('2026-06-20T18:00:00Z'), lng, lat)).toBeLessThan(-30);
  });
});

describe('daylight', () => {
  it('is full by day, none by night, and half at sunset', () => {
    expect(daylight(30)).toBe(1);
    expect(daylight(6)).toBe(1);
    expect(daylight(-6)).toBe(0);
    expect(daylight(-40)).toBe(0);
    expect(daylight(0)).toBeCloseTo(0.5);
  });
});
