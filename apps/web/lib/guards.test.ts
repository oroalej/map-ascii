import { CityMeta, SearchIndexFile, SubdivisionAreas } from '@atlas/shared';
import { describe, expect, it } from 'vitest';
import { isCityMeta, isSearchIndexFile, isSubdivisionAreas } from './guards';

const meta = {
  slug: 'fixture',
  name: { en: 'Fixture City', fil: 'Lungsod' },
  subdivisionLabel: { en: 'district' },
  languages: ['fil'],
  bounds: [1, 2, 3, 4],
  regionBounds: [0, 1, 4, 5],
  defaultCamera: { lat: 3, lng: 2, zoom: 14 },
  yearRange: [1900, 2026],
  attribution: ['A credit'],
};

const areas = [
  { name: 'North', approximate: false, geometry: { type: 'Polygon', coordinates: [] } },
];

const index = {
  version: 1,
  entries: [
    {
      id: 'osm:way/1',
      name: 'Plaza',
      altNames: [],
      type: 'landmark',
      lat: 3,
      lng: 2,
      zoomHint: 17,
    },
  ],
  index: { documentCount: 1 },
};

/** Each guard must accept what its schema accepts, and reject these broken copies. */
describe('browser shape guards agree with the schemas', () => {
  it('city meta', () => {
    expect(CityMeta.safeParse(meta).success).toBe(true);
    expect(isCityMeta(meta)).toBe(true);
    const layouts = { 'detail/fixture': 'a'.repeat(64) };
    expect(CityMeta.safeParse({ ...meta, detail_layouts: layouts }).success).toBe(true);
    expect(isCityMeta({ ...meta, detail_layouts: layouts })).toBe(true);
    for (const broken of [
      { ...meta, slug: '' },
      { ...meta, name: { fil: 'no English' } },
      { ...meta, regionBounds: [0, 1, 4] },
      { ...meta, defaultCamera: { ...meta.defaultCamera, zoom: 30 } },
      { ...meta, yearRange: '1900-2026' },
      { ...meta, detail_layouts: null },
      { ...meta, detail_layouts: [] },
      { ...meta, detail_layouts: { fixture: 'a'.repeat(64) } },
      { ...meta, detail_layouts: { 'detail/fixture': 'not-a-hash' } },
      null,
    ]) {
      expect(CityMeta.safeParse(broken).success).toBe(false);
      expect(isCityMeta(broken)).toBe(false);
    }
  });

  it('subdivision areas', () => {
    expect(SubdivisionAreas.safeParse(areas).success).toBe(true);
    expect(isSubdivisionAreas(areas)).toBe(true);
    for (const broken of [{}, [{ ...areas[0], approximate: 'no' }], [{ name: 'x' }]]) {
      expect(SubdivisionAreas.safeParse(broken).success).toBe(false);
      expect(isSubdivisionAreas(broken)).toBe(false);
    }
  });

  it('search index', () => {
    expect(SearchIndexFile.safeParse(index).success).toBe(true);
    expect(isSearchIndexFile(index)).toBe(true);
    for (const broken of [
      { ...index, version: 2 },
      { ...index, entries: [{ ...index.entries[0], lat: '3' }] },
      { ...index, entries: 'none' },
    ]) {
      expect(SearchIndexFile.safeParse(broken).success).toBe(false);
      expect(isSearchIndexFile(broken)).toBe(false);
    }
  });
});
