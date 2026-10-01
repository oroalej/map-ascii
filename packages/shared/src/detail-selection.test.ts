import { describe, expect, it } from 'vitest';
import { isDetailSelection, parseDetailSelection } from './detail-selection';
import { DetailSelectionSchema } from './schemas';

describe('canonical detail selection', () => {
  const info = {
    id: 'osm:way/12',
    class: 'building_religious',
    name: 'A church',
    landmarkId: 'landmark/church',
    height: 15,
  };
  it('shares pipeline and bounded worker validation', () => {
    expect(DetailSelectionSchema.parse(info)).toEqual(info);
    expect(parseDetailSelection(JSON.stringify(info))).toEqual(info);
    for (const invalid of [
      null,
      [],
      { ...info, id: 'detail:test' },
      { ...info, class: 'unknown' },
      { ...info, height: Infinity },
      { ...info, name: 'x'.repeat(513) },
      { ...info, parentId: 'osm:way/13' },
      { ...info, landmarkId: 'not-landmark' },
    ]) {
      expect(isDetailSelection(invalid)).toBe(false);
      expect(DetailSelectionSchema.safeParse(invalid).success).toBe(false);
    }
  });
  it('safely ignores absent, malformed and oversized archive metadata', () => {
    for (const value of [
      undefined,
      info,
      '{',
      'x'.repeat(4097),
      JSON.stringify({ ...info, height: -1 }),
    ])
      expect(parseDetailSelection(value)).toBeUndefined();
  });
});
