import { expect, it } from 'vitest';
import { BuntingCorridorSchema, SeasonalRecordSchema } from './seasonal-schema';
import { isSeasonalRecord, parseSeasonalRecord, type SeasonalRecord } from './seasonal-record';
import { Season } from './schemas';
const row: SeasonalRecord = {
  version: 1,
  kind: 'bunting',
  id: 'a',
  season: 'feast',
  corridor: 'route',
  road: 'osm:way/1',
  from: [123, 13],
  to: [123.0001, 13],
  segment: [
    [123, 12.999],
    [123, 13.001],
  ],
  seed: 12,
};
it('reads every installation kind and rejects invalid envelopes without blocking older maps', () => {
  const base = {
    version: 1,
    id: 'display',
    season: 'winter',
    installation: 'tree',
    anchor: 'osm:way/1',
    seed: 1,
  };
  for (const kind of ['christmas-tree', 'decorated-canopy']) {
    const record = { ...base, kind, at: [123, 13], radius_m: 5 };
    expect(parseSeasonalRecord(JSON.stringify(record))).toEqual(SeasonalRecordSchema.parse(record));
    for (const extra of [
      { version: 2 },
      { radius_m: Infinity },
      { radius_m: 0 },
      { radius_m: 21 },
      { anchor: 'unknown' },
      { at: [0, 91] },
      { extra: 1 },
    ]) {
      const value = { ...record, ...extra };
      expect(isSeasonalRecord(value)).toBe(false);
      expect(SeasonalRecordSchema.safeParse(value).success).toBe(false);
    }
  }
  const string = { ...base, kind: 'light-string', from: [123, 13], to: [123.001, 13] };
  expect(parseSeasonalRecord(JSON.stringify(string))).toEqual(SeasonalRecordSchema.parse(string));
  const mounted = { ...string, mount: 'building' };
  expect(parseSeasonalRecord(JSON.stringify(mounted))).toEqual(SeasonalRecordSchema.parse(mounted));
  const canopy = { ...string, mount: 'canopy' };
  expect(parseSeasonalRecord(JSON.stringify(canopy))).toEqual(SeasonalRecordSchema.parse(canopy));
  for (const mount of ['ground', 'roof', null, 1]) {
    const invalid = { ...string, mount };
    expect(isSeasonalRecord(invalid)).toBe(false);
    expect(SeasonalRecordSchema.safeParse(invalid).success).toBe(false);
  }
  expect(parseSeasonalRecord(JSON.stringify({ ...string, to: string.from }))).toBeUndefined();
  expect(parseSeasonalRecord(JSON.stringify({ ...base, kind: 'future-display' }))).toBeUndefined();
});
it('accepts exact geographic records and safely ignores corrupt/newer optional payloads', () => {
  expect(SeasonalRecordSchema.parse(row)).toEqual(row);
  expect(parseSeasonalRecord(JSON.stringify(row))).toEqual(row);
  for (const value of [
    null,
    [],
    { ...row, version: 2 },
    { ...row, from: row.to },
    { ...row, seed: -1 },
    { ...row, from: [181, 0] },
    { ...row, segment: [row.from, row.from] },
    { ...row, extra: 1 },
  ]) {
    expect(isSeasonalRecord(value)).toBe(false);
    expect(SeasonalRecordSchema.safeParse(value).success).toBe(false);
  }
  expect(parseSeasonalRecord('{')).toBeUndefined();
  expect(parseSeasonalRecord(row)).toBeUndefined();
});
it('validates bounded corridor density, unique source ways and explicit distinct endpoints', () => {
  const c = { id: 'route', ways: ['osm:way/1'], spacing_m: 6, style: 'red-yellow-rectangles' };
  expect(BuntingCorridorSchema.parse(c)).toEqual(c);
  expect(BuntingCorridorSchema.safeParse({ ...c, spacing_m: 3 }).success).toBe(true);
  for (const value of [
    { ...c, spacing_m: 0 },
    { ...c, spacing_m: 2.99 },
    { ...c, spacing_m: 81 },
    { ...c, ways: [] },
    { ...c, ways: ['osm:way/1', 'osm:way/1'] },
    { ...c, ways: ['osm:node/1'] },
    { ...c, from: 'osm:way/1', to: 'osm:way/1' },
    { ...c, style: 'unknown' },
  ])
    expect(BuntingCorridorSchema.safeParse(value).success).toBe(false);
});
it('accepts corridors in the season schema and rejects duplicate corridor identities', () => {
  const corridor = {
    id: 'route',
    ways: ['osm:way/1'],
    spacing_m: 6,
    style: 'red-yellow-rectangles',
  };
  const s = {
    id: 'feast',
    title: { en: 'Feast' },
    status: 'draft',
    note: 'TODO(verify)',
    sources: [{ title: 'Reference', url: 'https://example.com/calendar' }],
    window: { from: { month: 9, day: 1 }, to: { month: 9, day: 20 } },
    bunting: {
      label: 'Banderitas',
      near: ['worship'],
      radius_m: 400,
      spacing_m: 30,
      corridors: [corridor],
    },
  };
  expect(Season.safeParse(s).success).toBe(true);
  expect(
    Season.safeParse({ ...s, bunting: { ...s.bunting, corridors: [corridor, corridor] } }).success,
  ).toBe(false);
});
