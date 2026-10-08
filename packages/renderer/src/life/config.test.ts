import { describe, expect, it } from 'vitest';
import { hotAt, cropWork, activityLevels } from './config';
import { CROP_STAGES } from '@atlas/shared';

it('scales only ordinary farm attendance and preserves absent-calendar values', () => {
  const clock = { minutes: 480, weekday: 2 };
  const base = activityLevels(1, clock);
  expect(base.places.farm).toBeGreaterThan(0);
  expect(activityLevels(1, { ...clock, crop: undefined })).toEqual(base);
  expect(activityLevels(1).places.farm).toBe(activityLevels(1).person);
  for (const [i, stage] of CROP_STAGES.entries()) {
    expect(cropWork(stage, 0)).toBe([0.15, 0.8, 1, 0.35, 0.6, 1][i]);
    expect(cropWork(stage, 0.4)).toBe([0.15, 0.8, 0.5, 0.35, 0.6, 0.25][i]);
    const scaled = activityLevels(1, { ...clock, crop: { stage, progress: 0.4 } });
    expect(scaled.places.farm).toBe(base.places.farm * cropWork(stage, 0.4));
    expect({ ...scaled, places: { ...scaled.places, farm: base.places.farm } }).toEqual(base);
  }
});

describe('midday heat', () => {
  it.each([
    [659, 0, 60, false],
    [660, 0, 45, true],
    [869, 0, 60, true],
    [870, 0, 60, false],
    [720, 0.01, 60, false],
    [720, 1, 60, false],
    [720, 0, 44, false],
    [720, 0, 45, true],
    [undefined, 0, 60, false],
    [720, 0, undefined, false],
  ] as const)('checks minute %s, rain %s, altitude %s', (minutes, rain, altitude, expected) => {
    expect(hotAt(minutes, rain, altitude)).toBe(expected);
  });
});
