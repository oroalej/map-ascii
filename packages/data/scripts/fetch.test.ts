import type { City } from '@atlas/shared';
import { describe, expect, it } from 'vitest';
import { mergeResponses, regionQueries, splitBbox } from './01-fetch';

const city = {
  slug: 'fixture',
  name: { en: 'Fixture City' },
  country: 'XX',
  boundary: { name: 'Fixture City', admin_level: 6 },
  detail_buffer_km: 1,
  region: { bbox: [120, 10, 124, 14] },
  subdivision: { admin_level: 10, label: { en: 'ward' } },
  languages: [],
  smoke_landmark: 'Fixture Plaza',
} as City;

describe('splitBbox', () => {
  it('splits into n × n parts that tile the bbox', () => {
    const parts = splitBbox([120, 10, 124, 14], 2);
    expect(parts).toEqual([
      [120, 10, 122, 12],
      [122, 10, 124, 12],
      [120, 12, 122, 14],
      [122, 12, 124, 14],
    ]);
  });
});

describe('regionQueries', () => {
  it('asks for each heavy layer on its own, in each quarter, then places and provinces', () => {
    const queries = regionQueries(city, [120, 10, 124, 14]);
    expect(queries).toHaveLength(4 * 4 + 2);
    expect(queries.filter((q) => q.includes('"coastline"'))).toHaveLength(4);
    expect(queries[0]).toContain('[bbox:10.000000,120.000000,12.000000,122.000000]');
    expect(queries.at(-2)).toContain('node["place"~"^(city|town)$"]');
    expect(queries.at(-1)).toContain('["admin_level"="4"]');
    for (const q of queries) expect(q).toMatch(/^\[out:json\]\[timeout:300\]/);
  });
});

describe('mergeResponses', () => {
  it('keeps each element once, preferring the copy with the most data', () => {
    const merged = mergeResponses([
      {
        elements: [
          { type: 'node', id: 1 },
          { type: 'way', id: 2 },
        ],
      },
      {
        elements: [
          { type: 'node', id: 1, tags: { place: 'town', name: 'Fixture' } },
          { type: 'way', id: 2 },
          { type: 'node', id: 3 },
        ],
      },
    ]);
    expect(merged.elements).toHaveLength(3);
    expect(merged.elements.find((e) => e.id === 1)?.tags?.name).toBe('Fixture');
  });
});
