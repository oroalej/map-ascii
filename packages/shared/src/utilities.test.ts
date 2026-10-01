import { expect, it } from 'vitest';
import { CityStreets, UtilityRecordSchema } from './schemas';
import { utilitySpanId, type UtilityPole } from './utilities';

const pole: UtilityPole = {
  id: 'a',
  road: 'r',
  component: 'r/0',
  at: [123.18, 13.62],
  heading: [1, 0],
  normal: [0, 1],
  transformer: false,
};
it('keeps utility derivation opt-in and requires provenance when configured', () => {
  expect(CityStreets.parse({}).utilities).toBeUndefined();
  expect(CityStreets.safeParse({ utilities: { derive: true } }).success).toBe(false);
  expect(CityStreets.safeParse({ utilities: { derive: false, source: ' ' } }).success).toBe(false);
  expect(
    CityStreets.safeParse({ utilities: { derive: true, source: 'Owner decision', typo: 1 } })
      .success,
  ).toBe(false);
});
it('validates versioned precise endpoints and rejects malformed records', () => {
  const record = { version: 1, kind: 'pole', pole };
  expect(UtilityRecordSchema.parse(record)).toEqual(record);
  for (const invalid of [
    { ...record, version: 2 },
    { ...record, pole: { ...pole, at: [NaN, 13] } },
    { ...record, pole: { ...pole, normal: [0, 2] } },
    { ...record, pole: { ...pole, at: [181, 13] } },
    {
      version: 1,
      kind: 'span',
      span: { id: 'self', from: pole, to: pole, kind: 'corridor', seed: 1 },
    },
  ])
    expect(UtilityRecordSchema.safeParse(invalid).success).toBe(false);
  expect(utilitySpanId('a/b', 'c')).toBe(utilitySpanId('c', 'a/b'));
  expect(utilitySpanId('a/b', 'c')).not.toBe(utilitySpanId('a', 'b/c'));
});
