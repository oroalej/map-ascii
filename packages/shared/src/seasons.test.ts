import { describe, expect, it } from 'vitest';
import cityPack from '../../content/cities/naga/city.json';
import {
  activeSeason,
  admitsSeasonRecord,
  epochDay,
  nthWeekdayDay,
  resolveSeason,
  seasonContains,
  validMonthDay,
  type SeasonWindow,
} from './seasons';

const winter: SeasonWindow = { from: { month: 12, day: 1 }, to: { month: 1, day: 6 } };
const contains = (window: SeasonWindow, year: number, month: number, day: number) =>
  seasonContains(window, year, epochDay(year, month, day));
describe('annual season calendars', () => {
  it('admits authored and explicitly included record seasons only', () => {
    const season = { id: 'new-year', includes: ['christmas'] };
    expect(admitsSeasonRecord(season, 'new-year')).toBe(true);
    expect(admitsSeasonRecord(season, 'christmas')).toBe(true);
    expect(admitsSeasonRecord(season, 'fiesta')).toBe(false);
    expect(admitsSeasonRecord({ id: 'new-year' }, 'christmas')).toBe(false);
  });
  it.each([
    [2024, 13, 22],
    [2026, 11, 20],
    [2030, 13, 22],
  ])(
    'uses the actual city-pack fiesta window in %s, including both boundaries',
    (year, from, to) => {
      const fiesta = cityPack.life.seasons.find((s) => s.id === 'penafrancia-fiesta')!;
      expect(fiesta).toBeDefined();
      for (let day = 1; day <= 30; day++)
        expect(contains(fiesta.window, year, 9, day)).toBe(day >= from && day <= to);
    },
  );
  it('prioritizes New Year across the year boundary and keeps Christmas outside its window', () => {
    const seasons = [
      { id: 'new-year', window: { from: { month: 12, day: 31 }, to: { month: 1, day: 1 } } },
      { id: 'christmas', window: winter },
    ];
    for (const year of [2024, 2026, 2027]) {
      for (const [month, date, expected] of [
        [12, 30, 'christmas'],
        [12, 31, 'new-year'],
        [1, 1, 'new-year'],
        [1, 2, 'christmas'],
        [1, 7, undefined],
      ] as const)
        expect(activeSeason(seasons, year, epochDay(year, month, date))?.id).toBe(expected);
      expect(resolveSeason(seasons, 'new-year', year, epochDay(year, 7, 10))?.id).toBe('new-year');
      expect(resolveSeason(seasons, 'christmas', year, epochDay(year, 1, 1))?.id).toBe('christmas');
    }
  });
  it('includes both edges of a New Year window', () => {
    for (const [month, day] of [
      [12, 1],
      [12, 31],
      [1, 3],
      [1, 6],
    ])
      expect(contains(winter, 2026, month!, day!)).toBe(true);
    for (const [month, day] of [
      [11, 30],
      [1, 7],
    ])
      expect(contains(winter, 2026, month!, day!)).toBe(false);
  });
  it('matches a moving feast without changing the procession date math', () => {
    const anchor = { month: 9, weekday: 0, nth: 3, offset_days: 0 };
    const window = { anchor, days_before: 9, days_after: 0 };
    expect(nthWeekdayDay(anchor, 2026)).toBe(epochDay(2026, 9, 20));
    expect(nthWeekdayDay({ ...anchor, offset_days: -1 }, 2025)).toBe(epochDay(2025, 9, 20));
    expect(contains(window, 2026, 9, 11)).toBe(true);
    expect(contains(window, 2026, 9, 20)).toBe(true);
    expect(contains(window, 2026, 9, 10)).toBe(false);
    expect(contains(window, 2026, 9, 21)).toBe(false);
  });
  it('checks next year anchors whose lead-in starts in December', () => {
    const window = {
      anchor: { month: 1, weekday: 0, nth: 1, offset_days: 0 },
      days_before: 9,
      days_after: 2,
    };
    expect(contains(window, 2026, 12, 31)).toBe(true);
    expect(contains(window, 2027, 1, 5)).toBe(true);
    expect(contains(window, 2027, 1, 6)).toBe(false);
  });
  it('skips missing leap days and fifth weekdays instead of normalizing into March', () => {
    const leap = { from: { month: 2, day: 29 }, to: { month: 2, day: 29 } };
    expect(validMonthDay(leap.from)).toBe(true);
    expect(validMonthDay({ month: 2, day: 30 })).toBe(false);
    expect(validMonthDay({ month: 4, day: 31 })).toBe(false);
    expect(contains(leap, 2024, 2, 29)).toBe(true);
    expect(contains(leap, 2025, 3, 1)).toBe(false);
    const fifth = {
      anchor: { month: 2, weekday: 0, nth: 5, offset_days: 0 },
      days_before: 0,
      days_after: 0,
    };
    expect(contains(fifth, 2026, 3, 1)).toBe(false);
  });
  it('keeps pack-order precedence and resolves explicit/unknown previews', () => {
    const seasons = [
      { id: 'first', window: winter },
      { id: 'second', window: winter },
    ];
    const day = epochDay(2026, 12, 10);
    expect(activeSeason(seasons, 2026, day)?.id).toBe('first');
    expect(resolveSeason(seasons, 'second', 2026, epochDay(2026, 7, 10))?.id).toBe('second');
    expect(resolveSeason(seasons, 'missing', 2026, day)?.id).toBe('first');
    expect(activeSeason(undefined, 2026, day)).toBeUndefined();
  });
});
