import { describe, expect, it } from 'vitest';
import { curveAt, DEFAULT_RHYTHM, placeShare, rhythmFor, shopHours, shopOpen } from './rhythm';
import { CityLife } from './schemas';

describe('curveAt', () => {
  const curve = [
    [6, 0.2],
    [12, 1],
    [18, 0.4],
  ] as const;

  it('reads straight between points', () => {
    expect(curveAt(curve, 6 * 60)).toBeCloseTo(0.2);
    expect(curveAt(curve, 9 * 60)).toBeCloseTo(0.6);
    expect(curveAt(curve, 15 * 60)).toBeCloseTo(0.7);
  });

  it('wraps across midnight', () => {
    // 18:00 → 06:00 is 12 hours from 0.4 to 0.2: midnight is halfway.
    expect(curveAt(curve, 0)).toBeCloseTo(0.3);
    expect(curveAt(curve, 24 * 60)).toBeCloseTo(0.3);
    expect(curveAt(curve, 3 * 60)).toBeCloseTo(0.25);
    expect(curveAt(curve, 21 * 60)).toBeCloseTo(0.35);
  });

  it('is flat for one point', () => {
    expect(curveAt([[8, 0.5]], 100)).toBe(0.5);
  });
});

describe('the default rhythm', () => {
  it('is busier in the rush hours than at midday or in the small hours', () => {
    for (const kind of ['vehicle', 'person'] as const) {
      const at = (hour: number) => curveAt(DEFAULT_RHYTHM[kind], hour * 60);
      expect(at(8)).toBeGreaterThan(at(14));
      expect(at(17.5)).toBeGreaterThan(at(14));
      expect(at(3)).toBeLessThan(at(14));
    }
  });

  it('is replaced per kind by the city’s', () => {
    const life = { rhythm: { boat: [[0, 1]] as const }, source: 'test' };
    expect(rhythmFor(life, 'boat')).toEqual([[0, 1]]);
    expect(rhythmFor(life, 'vehicle')).toBe(DEFAULT_RHYTHM.vehicle);
  });
});

describe('CityLife', () => {
  it('checks the curves', () => {
    const ok = {
      rhythm: {
        vehicle: [
          [0, 0.2],
          [8, 1],
        ],
      },
      source: 'x',
    };
    expect(CityLife.safeParse(ok).success).toBe(true);
    const descending = {
      rhythm: {
        vehicle: [
          [8, 1],
          [0, 0.2],
        ],
      },
      source: 'x',
    };
    expect(CityLife.safeParse(descending).success).toBe(false);
    const tooMuch = { rhythm: { vehicle: [[8, 1.5]] }, source: 'x' };
    expect(CityLife.safeParse(tooMuch).success).toBe(false);
    expect(CityLife.safeParse({ rhythm: { bird: [[8, 1]] }, source: 'x' }).success).toBe(false);
  });
});

describe('placeShare', () => {
  const monday = (hour: number) => ({ minutes: hour * 60, weekday: 1 });
  const sunday = (hour: number) => ({ minutes: hour * 60, weekday: 0 });

  it('fills school gates before classes and after, on school days only', () => {
    expect(placeShare('school', monday(6.75), undefined)).toBe(1);
    expect(placeShare('school', monday(16.5), undefined)).toBe(1);
    expect(placeShare('school', monday(10.5), undefined)).toBeLessThan(0.2);
    expect(placeShare('school', monday(3), undefined)).toBeLessThan(0.05);
    expect(placeShare('school', sunday(6.75), undefined)).toBeLessThan(0.05);
  });

  it('follows the city’s school hours', () => {
    const life = {
      schedules: { school: { weekdays: [1, 2, 3, 4, 5, 6], in: '08:00', out: '17:00' } },
      source: 'test',
    };
    expect(placeShare('school', monday(7.5), life)).toBe(1);
    expect(placeShare('school', monday(6.25), life)).toBeLessThan(0.2);
    expect(placeShare('school', { minutes: 450, weekday: 6 }, life)).toBe(1);
  });

  it('crowds places of worship only around the city’s services', () => {
    const at = (hour: number, weekday = 0, life?: Parameters<typeof placeShare>[2]) =>
      placeShare('worship', { minutes: hour * 60, weekday }, life);
    // No services given: a few visitors all day.
    expect(at(9)).toBeLessThan(0.2);
    const life = { schedules: { worship: [{ weekdays: [0], times: ['09:00'] }] }, source: 't' };
    expect(at(8.75, 0, life)).toBe(1);
    expect(at(9.9, 0, life)).toBe(1);
    expect(at(11, 0, life)).toBeLessThan(0.2);
    expect(at(9, 1, life)).toBeLessThan(0.2);
  });

  it('works the fields in two shifts', () => {
    expect(placeShare('farm', monday(7), undefined)).toBeGreaterThan(0.8);
    expect(placeShare('farm', monday(13), undefined)).toBeLessThan(0.2);
    expect(placeShare('farm', monday(22), undefined)).toBe(0);
  });
});

describe('shopHours', () => {
  const hours = Array.from({ length: 5000 }, (_, seed) => shopHours(seed));
  const openAt = (hour: number) =>
    hours.filter((h) => shopOpen(h, hour * 60)).length / hours.length;

  it('keeps each shop’s own hours, fixed by its seed', () => {
    expect(shopHours(42)).toEqual(shopHours(42));
    expect(new Set(hours.map((h) => h.close)).size).toBeGreaterThan(100);
  });

  it('has nearly every shop open at midday, and about nine in ten closed by 21:00', () => {
    expect(openAt(12)).toBeGreaterThan(0.95);
    expect(1 - openAt(21)).toBeGreaterThan(0.85);
    expect(1 - openAt(21)).toBeLessThan(0.95);
    // A few stay open late, and fewer all night.
    expect(openAt(22)).toBeGreaterThan(0.02);
    expect(openAt(3)).toBeLessThan(0.05);
  });

  it('shifts with the city’s own typical hours', () => {
    const late = { source: 'test', schedules: { shops: { open: '10:00', close: '22:00' } } };
    const share = (hour: number) =>
      Array.from({ length: 2000 }, (_, seed) => shopHours(seed, late)).filter((h) =>
        shopOpen(h, hour * 60),
      ).length / 2000;
    expect(share(21)).toBeGreaterThan(0.5);
  });

  it('handles hours that run past midnight', () => {
    const h = { open: 18 * 60, close: 2 * 60, allNight: false };
    expect(shopOpen(h, 23 * 60)).toBe(true);
    expect(shopOpen(h, 60)).toBe(true);
    expect(shopOpen(h, 12 * 60)).toBe(false);
  });
});
