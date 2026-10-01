import { expect, it } from 'vitest';
import { CityStreets, UtilityRecordSchema } from './schemas';
import { isUtilityRecord, parseUtilityRecord, utilitySpanId, type UtilityPole } from './utilities';

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

it('keeps runtime validation in parity with the build schema for both record kinds', () => {
  const record = { version: 1, kind: 'pole', pole };
  const span = {
    version: 1,
    kind: 'span',
    span: {
      id: 's',
      kind: 'corridor',
      from: pole,
      to: { ...pole, id: 'b' },
      seed: 0xffffffff,
    },
  };
  const values: unknown[] = [
    null,
    [],
    {},
    record,
    span,
    { ...record, version: 2 },
    { ...record, extra: true },
    { ...span, span: { ...span.span, kind: 'other' } },
    { ...span, span: { ...span.span, to: pole } },
    ...[-1, 0.5, 0x100000000, Infinity, NaN, '1'].map((seed) => ({
      ...span,
      span: { ...span.span, seed },
    })),
  ];
  for (const change of [
    { id: '' },
    { road: '' },
    { component: '' },
    { transformer: 1 },
    { extra: 1 },
    { at: [180, 85.051129] },
    { at: [-180, -85.051129] },
    { at: [181, 0] },
    { at: [0, 85.05113] },
    { at: [Infinity, 0] },
    { at: [NaN, 0] },
    { at: [0] },
    { at: [0, 0, 0] },
    { heading: [0, 0] },
    { heading: [1.0005, 0] },
    { heading: [1.002, 0] },
    { normal: [0, 2] },
    { normal: [0, Infinity] },
    { sharedLamp: '' },
    { sharedLamp: undefined },
    { sharedLamp: 'lamp', partner: 'partner' },
    { partner: null },
  ]) {
    const changed = { ...pole, ...change };
    values.push({ ...record, pole: changed }, { ...span, span: { ...span.span, from: changed } });
  }
  for (const value of values) {
    expect(isUtilityRecord(value), JSON.stringify(value)).toBe(
      UtilityRecordSchema.safeParse(value).success,
    );
    const serialized = JSON.stringify(value);
    if (serialized !== undefined)
      expect(parseUtilityRecord(serialized) !== undefined).toBe(
        UtilityRecordSchema.safeParse(JSON.parse(serialized)).success,
      );
  }
  for (const bad of ['{', '', 'undefined', null, undefined, record])
    expect(parseUtilityRecord(bad)).toBeUndefined();
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
