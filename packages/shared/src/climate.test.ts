import { describe, expect, it } from 'vitest';
import {
  cropStageAt,
  harvestAt,
  type ClimateConfig,
  type CropCalendarEntry,
  type CropStage,
  type HarvestConfig,
} from './climate';
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

describe('harvestAt', () => {
  const harvest: HarvestConfig = {
    dryingHours: [8, 16],
    burningHours: [15, 18],
    tractors: true,
    ducks: true,
    source: 'Synthetic',
  };
  const at = (stage: CropStage, progress: number, hour = 12) =>
    harvestAt({ stage, progress }, harvest, hour * 60)!;

  it('ramps drying up through late ripe and down through early harvested', () => {
    expect(at('growing', 0.9).drying).toBe(0);
    expect(at('ripe', 0.25).drying).toBe(0);
    expect(at('ripe', 0.5).drying).toBe(0);
    expect(at('ripe', 0.75).drying).toBeCloseTo(0.5);
    expect(at('ripe', 1).drying).toBe(1);
    expect(at('harvested', 0).drying).toBe(1);
    expect(at('harvested', 0.3).drying).toBeCloseTo(0.5);
    expect(at('harvested', 0.6).drying).toBe(0);
    expect(at('harvested', 0.9).drying).toBe(0);
  });
  it('spreads palay only inside the drying hours, end excluded', () => {
    expect(at('ripe', 1, 7.99).spread).toBe(false);
    expect(at('ripe', 1, 8).spread).toBe(true);
    expect(at('ripe', 1, 15.99).spread).toBe(true);
    expect(at('ripe', 1, 16).spread).toBe(false);
  });
  it('puts tractors on flooded fields and through early harvest only', () => {
    expect(at('flooded', 0.9).tractors).toBe(0.5);
    expect(at('harvested', 0.59).tractors).toBe(0.5);
    expect(at('harvested', 0.6).tractors).toBe(0);
    expect(at('growing', 0.5).tractors).toBe(0);
    expect(harvestAt({ stage: 'flooded', progress: 0 }, { ...harvest, tractors: false }, 720))
      .toMatchObject({ tractors: 0 });
  });
  it('lets ducks out on harvested fields only', () => {
    expect(at('harvested', 0.95).ducks).toBe(1);
    expect(at('flooded', 0).ducks).toBe(0);
    expect(harvestAt({ stage: 'harvested', progress: 0 }, { ...harvest, ducks: false }, 720))
      .toMatchObject({ ducks: 0 });
  });
  it('burns straw between 10 % and 60 % of harvested, inside its hours', () => {
    expect(at('harvested', 0.09, 16).burning).toBe(false);
    expect(at('harvested', 0.1, 16).burning).toBe(true);
    expect(at('harvested', 0.59, 16).burning).toBe(true);
    expect(at('harvested', 0.6, 16).burning).toBe(false);
    expect(at('harvested', 0.3, 12).burning).toBe(false);
  });
  it('shows no smoke without burning hours and no scene without a config or a crop', () => {
    const { burningHours: _, ...noSmoke } = harvest;
    expect(harvestAt({ stage: 'harvested', progress: 0.3 }, noSmoke, 16 * 60)?.burning).toBe(false);
    expect(harvestAt({ stage: 'harvested', progress: 0.3 }, undefined, 720)).toBeUndefined();
    expect(harvestAt(undefined, harvest, 720)).toBeUndefined();
  });
  it('follows the calendar across a leap year', () => {
    const crops = rice([
      { from: '01-01', stage: 'ripe' },
      { from: '03-01', stage: 'harvested' },
    ]);
    const midpoint = (year: number) =>
      harvestAt(cropStageAt(crops, year, day(year, 2, 28)), harvest, 720)!.drying;
    // 58 of 60 days ripe in 2024, 58 of 59 in 2025.
    expect(midpoint(2024)).toBeCloseTo((58 / 60 - 0.5) / 0.5);
    expect(midpoint(2025)).toBeCloseTo((58 / 59 - 0.5) / 0.5);
  });
});

describe('harvest and mist config', () => {
  const base = { wind: [], default: { from: 90, strength: 'breeze' }, source: 'Synthetic' };
  const calendar = [
    { from: '03-01', stage: 'growing' },
    { from: '12-01', stage: 'flooded' },
  ];
  const harvest = { dryingHours: [8, 16], tractors: true, ducks: false, source: 'Synthetic' };
  const parses = (rice: object) =>
    Climate.safeParse({ ...base, crops: { rice: { calendar, source: 'S', ...rice } } }).success;

  it('takes an optional harvest with optional burning hours', () => {
    expect(parses({})).toBe(true);
    expect(parses({ harvest })).toBe(true);
    expect(parses({ harvest: { ...harvest, burningHours: [15, 18] } })).toBe(true);
  });
  it.each([
    ['hours out of range', { dryingHours: [8, 25] }],
    ['negative hours', { dryingHours: [-1, 16] }],
    ['reversed hours', { dryingHours: [16, 8] }],
    ['reversed burning hours', { burningHours: [18, 15] }],
    ['no source', { source: '' }],
    ['an unknown key', { wet: true }],
  ])('rejects a harvest with %s', (_, change) => {
    expect(parses({ harvest: { ...harvest, ...change } })).toBe(false);
  });
  it('wants twelve densities in range and a source', () => {
    const months = Array.from({ length: 12 }, () => 0.5);
    const mist = (value: object) => Climate.safeParse({ ...base, mist: value }).success;
    expect(mist({ months, source: 'S' })).toBe(true);
    expect(mist({ months: months.slice(1), source: 'S' })).toBe(false);
    expect(mist({ months: [...months, 0.5], source: 'S' })).toBe(false);
    expect(mist({ months: [1.5, ...months.slice(1)], source: 'S' })).toBe(false);
    expect(mist({ months: [-0.1, ...months.slice(1)], source: 'S' })).toBe(false);
    expect(mist({ months })).toBe(false);
  });
});
