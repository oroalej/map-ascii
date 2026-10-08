import { describe, expect, it } from 'vitest';
import { cropStageAt, type CropCalendarEntry, type ClimateConfig } from './climate';
import { epochDay } from './seasons';
import { Climate, CropCalendarSchema } from './schemas';

const rice = (calendar: CropCalendarEntry[]): ClimateConfig['crops'] => ({
  rice: { calendar, source: 'Synthetic calendar' },
});
const day = (year: number, month: number, date: number) =>
  epochDay(year, month, date) - epochDay(year, 1, 1);
describe('crop calendar', () => {
  const crops = rice([
    { from: '03-01', stage: 'growing' },
    { from: '12-01', stage: 'flooded' },
  ]);
  it('resolves boundaries, middle and both leap-year wraps without mutation', () => {
    const before = JSON.stringify(crops);
    expect(cropStageAt(crops, 2024, day(2024, 3, 1))).toEqual({ stage: 'growing', progress: 0 });
    expect(cropStageAt(crops, 2024, day(2024, 1, 1))).toEqual({
      stage: 'flooded',
      progress: 31 / 91,
    });
    expect(cropStageAt(crops, 2025, day(2025, 1, 1))).toEqual({
      stage: 'flooded',
      progress: 31 / 90,
    });
    expect(cropStageAt(crops, 2024, day(2024, 2, 29))).toEqual({
      stage: 'flooded',
      progress: 90 / 91,
    });
    expect(JSON.stringify(crops)).toBe(before);
  });
  it('skips leap-day starts outside leap years, even with one annual entry', () => {
    const calendar = rice([
      { from: '02-29', stage: 'ripe' },
      { from: '06-01', stage: 'growing' },
    ]);
    expect(cropStageAt(calendar, 2024, day(2024, 2, 29))).toEqual({ stage: 'ripe', progress: 0 });
    expect(cropStageAt(calendar, 2025, day(2025, 3, 1))).toEqual({
      stage: 'growing',
      progress: 273 / 365,
    });
    expect(cropStageAt(calendar, 2024, day(2024, 1, 1))?.progress).toBe(214 / 273);
  });
  it('has no state without a rice calendar', () => {
    expect(cropStageAt(undefined, 2024, 0)).toBeUndefined();
    expect(cropStageAt({}, 2024, 0)).toBeUndefined();
    expect(
      Climate.parse({ wind: [], default: { from: 90, strength: 'breeze' }, source: 'Synthetic' })
        .crops,
    ).toBeUndefined();
  });
  it.each(['02-30', '04-31', '2-01', '01-1', '00-10', '13-01'])(
    'rejects invalid date %s',
    (from) => {
      expect(
        CropCalendarSchema.safeParse(
          rice([
            { from, stage: 'fallow' },
            { from: '06-01', stage: 'growing' },
          ])!.rice,
        ).success,
      ).toBe(false);
    },
  );
  it('rejects duplicate dates, one-entry, unsourced and leap-only calendars', () => {
    const good = crops!.rice!;
    expect(CropCalendarSchema.safeParse(good).success).toBe(true);
    for (const invalid of [
      { ...good, calendar: [good.calendar[0]] },
      { ...good, calendar: [good.calendar[0], good.calendar[0]] },
      { ...good, source: '' },
      {
        ...good,
        calendar: [
          { from: '02-29', stage: 'fallow' },
          { from: '02-29', stage: 'growing' },
        ],
      },
    ])
      expect(CropCalendarSchema.safeParse(invalid).success).toBe(false);
  });
});
