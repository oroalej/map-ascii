import { describe, expect, it } from 'vitest';
import type { SearchEntry } from '@atlas/shared';
import { entryBbox, inRegion } from './06-search-index';

describe('entryBbox', () => {
  it('keeps a bbox with area, rounded', () => {
    expect(entryBbox([123.1, 13.6, 123.2000004, 13.7])).toEqual({
      bbox: [123.1, 13.6, 123.2, 13.7],
    });
  });

  it('drops a bbox without area: a point, or a way along a parallel or meridian', () => {
    expect(entryBbox([123.1, 13.6, 123.1, 13.6])).toEqual({});
    expect(entryBbox([123.1, 13.6, 123.2, 13.6])).toEqual({});
    expect(entryBbox([123.1, 13.6, 123.1000001, 13.7])).toEqual({});
  });
});

describe('inRegion', () => {
  it('drops entries whose point is outside the region', () => {
    const entry = (name: string, lng: number, lat: number) => ({ name, lng, lat }) as SearchEntry;
    const entries = [entry('downtown', 123.19, 13.62), entry('pacol', 123.232, 13.651)];
    expect(inRegion(entries, [123.17, 13.602, 123.213, 13.64]).map((e) => e.name)).toEqual([
      'downtown',
    ]);
  });
});
