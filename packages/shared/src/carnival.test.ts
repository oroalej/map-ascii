import { expect, it } from 'vitest';
import { carnivalRing } from './carnival';
import {
  CARNIVAL_STYLES,
  isSeasonalRecord,
  parseSeasonalRecord,
  type SeasonalCarnivalRecord,
} from './seasonal-record';
import { SeasonalRecordSchema, CarnivalComponentSchema } from './seasonal-schema';
import { localMetricProjection } from './flat-geometry';

const ride: SeasonalCarnivalRecord = {
  version: 1,
  kind: 'carnival',
  id: 'ride',
  season: 'winter',
  installation: 'fair',
  anchor: 'osm:way/1',
  seed: 7,
  style: 'carousel',
  at: [123, 13],
  size_m: [18, 18],
  angle_deg: -20,
};
it('keeps the lightweight decoder and strict carnival schema equivalent for every bounded style', () => {
  for (const style of CARNIVAL_STYLES) {
    const valid = { ...ride, style };
    expect(parseSeasonalRecord(JSON.stringify(valid))).toEqual(SeasonalRecordSchema.parse(valid));
    for (const change of [
      { style: 'future' },
      { size_m: [0, 10] },
      { size_m: [121, 121] },
      { size_m: [10] },
      { size_m: [NaN, 10] },
      { angle_deg: Infinity },
      { angle_deg: 181 },
      { at: [0, 90] },
      { version: 2 },
      { extra: 1 },
      { seed: -1 },
    ]) {
      const invalid = { ...valid, ...change };
      expect(isSeasonalRecord(invalid)).toBe(false);
      expect(SeasonalRecordSchema.safeParse(invalid).success).toBe(false);
    }
  }
  expect(isSeasonalRecord({ ...ride, size_m: [10, 12] })).toBe(false);
  expect(
    CarnivalComponentSchema.safeParse({
      id: 'wheel',
      style: 'ferris-wheel',
      at: ride.at,
      size_m: [31, 10],
      angle_deg: 0,
    }).success,
  ).toBe(false);
  expect(isSeasonalRecord({ ...ride, style: 'midway', size_m: [40, 110] })).toBe(true);
});
it('retains complete metric envelopes under rotation and uses a circular carousel footprint', () => {
  const { to } = localMetricProjection(ride.at);
  const circle = carnivalRing(ride).map(to);
  expect(circle).toHaveLength(33);
  expect(circle.at(-1)).toEqual(circle[0]);
  for (const p of circle) expect(Math.hypot(...p)).toBeCloseTo(9, 5);
  const rectangle = carnivalRing({
    ...ride,
    style: 'ferris-wheel',
    size_m: [7, 22],
    angle_deg: 90,
  }).map(to);
  expect(rectangle).toHaveLength(5);
  expect(Math.max(...rectangle.map((p) => Math.abs(p[0])))).toBeCloseTo(11, 5);
  expect(Math.max(...rectangle.map((p) => Math.abs(p[1])))).toBeCloseTo(3.5, 5);
});
