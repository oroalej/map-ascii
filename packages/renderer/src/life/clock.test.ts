import { describe, expect, it } from 'vitest';
import { atCityMinutes, cityTime, dayNumber, localTime } from './clock';

describe('localTime', () => {
  it('reads the date and time in the time zone, not the visitor’s', () => {
    // 2026-09-29 23:30 UTC is 07:30 on the 30th in Manila (UTC+8), a Wednesday.
    const at = new Date('2026-09-29T23:30:00Z');
    const manila = localTime(at, 'Asia/Manila');
    expect(manila.year).toBe(2026);
    expect(manila.month).toBe(9);
    expect(manila.day).toBe(dayNumber(2026, 9, 30));
    expect(manila.weekday).toBe(3);
    expect(manila.minutes).toBe(7 * 60 + 30);
  });
});

describe('cityTime', () => {
  it('uses the sun’s time at the longitude without a time zone', () => {
    // 120° east is 8 hours ahead of UTC.
    const local = cityTime(new Date('2026-12-31T20:00:00Z'), { lng: 120 });
    expect(local.year).toBe(2027);
    expect(local.month).toBe(1);
    expect(local.minutes).toBe(4 * 60);
  });
});

describe('atCityMinutes', () => {
  it('is the fixed time on the city’s day', () => {
    const zone = { timezone: 'Asia/Manila', lng: 123 };
    const at = atCityMinutes(new Date('2026-09-29T23:30:00Z'), zone, 18 * 60);
    expect(at.toISOString()).toBe('2026-09-30T10:00:00.000Z');
    expect(cityTime(at, zone).minutes).toBe(18 * 60);
  });
});
