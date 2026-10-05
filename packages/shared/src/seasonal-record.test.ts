import { expect, it } from 'vitest';
import { BuntingCorridorSchema, SeasonalRecordSchema } from './seasonal-schema';
import { isSeasonalRecord, parseSeasonalRecord, type SeasonalRecord } from './seasonal-record';
import { Season } from './schemas';
import { seasonalAccessRing } from './seasonal-access';
import { localMetricProjection } from './flat-geometry';
it('validates seasonal access widths and preserves complete metric envelopes', () => {
  const record = {
    version: 1,
    kind: 'access-path',
    id: 'path',
    season: 'winter',
    installation: 'path',
    anchor: 'osm:way/1',
    seed: 2,
    style: 'driveway',
    width_m: 4,
    from: [123, 13],
    to: [123.0002, 13],
  };
  const parsed = SeasonalRecordSchema.parse(record);
  expect(parseSeasonalRecord(JSON.stringify(record))).toEqual(parsed);
  if (parsed.kind !== 'access-path') throw new Error('expected access');
  const projection = localMetricProjection(parsed.from);
  const ring = seasonalAccessRing(parsed).map(projection.to);
  expect(Math.max(...ring.map((p) => p[1])) - Math.min(...ring.map((p) => p[1]))).toBeCloseTo(4);
  expect(ring[0]).toEqual(ring.at(-1));
  const parking = { ...record, style: 'parking', width_m: 6 };
  const parsedParking = SeasonalRecordSchema.parse(parking);
  expect(isSeasonalRecord(parking)).toBe(true);
  if (parsedParking.kind !== 'access-path') throw new Error('expected parking access');
  expect(seasonalAccessRing(parsedParking)).toHaveLength(5);
  const tooNarrow = { ...parking, width_m: 5.49 };
  expect(isSeasonalRecord(tooNarrow)).toBe(false);
  expect(SeasonalRecordSchema.safeParse(tooNarrow).success).toBe(false);
  for (const change of [
    { width_m: 0.99 },
    { width_m: 12.01 },
    { width_m: NaN },
    { style: 'road' },
    { to: record.from },
    { mount: 'canopy' },
    { palette: 'warm' },
    { version: 2 },
  ]) {
    const invalid = { ...record, ...change };
    expect(isSeasonalRecord(invalid)).toBe(false);
    expect(SeasonalRecordSchema.safeParse(invalid).success).toBe(false);
  }
});
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
  for (const palette of ['warm', 'christmas']) {
    const dense = { ...canopy, bulb_spacing_m: 0.4, palette };
    expect(parseSeasonalRecord(JSON.stringify(dense))).toEqual(SeasonalRecordSchema.parse(dense));
  }
  for (const change of [
    { bulb_spacing_m: 0.29 },
    { bulb_spacing_m: 3.01 },
    { bulb_spacing_m: NaN },
    { bulb_spacing_m: null },
    { palette: 'unknown' },
  ]) {
    const invalid = { ...canopy, ...change };
    expect(isSeasonalRecord(invalid)).toBe(false);
    expect(SeasonalRecordSchema.safeParse(invalid).success).toBe(false);
  }
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
