import type { City } from '@atlas/shared';
import { describe, expect, it } from 'vitest';
import {
  mergeResponses,
  neighborhoodQuery,
  railQuery,
  regionQueries,
  splitBbox,
  trafficQuery,
} from './01-fetch';

it('fetches commerce and neighborhood vegetation without commercial land-use zones', () => {
  const q = neighborhoodQuery('1,2,3,4');
  for (const tag of [
    'nwr["shop"]',
    'nwr["craft"]',
    'food_court',
    'dentist',
    'scrub|heath',
    'orchard|plant_nursery|cemetery',
    '[bbox:1,2,3,4]',
  ])
    expect(q).toContain(tag);
  expect(q).not.toContain('residential');
  expect(q).not.toContain('commercial');
  const bare = { type: 'node' as const, id: 10, lat: 1, lon: 2 };
  const tagged = { ...bare, tags: { shop: 'florist' } };
  for (const elements of [
    [bare, tagged],
    [tagged, bare],
  ])
    expect(mergeResponses(elements.map((e) => ({ elements: [e] }))).elements).toEqual([tagged]);
});

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
    expect(queries).toHaveLength(4 * 4 + 2 + 4);
    expect(queries.filter((q) => q.includes('"coastline"'))).toHaveLength(4);
    // Railways come last, so the parts before keep their numbers and saved downloads.
    expect(queries.slice(-4).every((q) => q.includes('way["railway"'))).toBe(true);
    expect(queries.slice(0, -4).some((q) => q.includes('railway'))).toBe(false);
    expect(queries[0]).toContain('[bbox:10.000000,120.000000,12.000000,122.000000]');
    expect(queries.at(-6)).toContain('node["place"~"^(city|town)$"]');
    expect(queries.at(-5)).toContain('["admin_level"="4"]');
    for (const q of queries) expect(q).toMatch(/^\[out:json\]\[timeout:300\]/);
  });
});

describe('railQuery', () => {
  it('asks only for track and stations, over the given bbox', () => {
    const query = railQuery('13.5,123.1,13.7,123.3');
    expect(query).toContain('[bbox:13.5,123.1,13.7,123.3]');
    expect(query).toContain('way["railway"~"^(rail|narrow_gauge|light_rail)$"]');
    expect(query).toContain('nwr["railway"~"^(station|halt)$"]');
    expect(query).not.toContain('highway');
  });
});

describe('mergeResponses', () => {
  it('keeps tagged traffic nodes in either download order', () => {
    const bare = { type: 'node' as const, id: 3, lat: 13, lon: 123 };
    const tagged = { ...bare, tags: { highway: 'traffic_signals' } };
    for (const pair of [
      [bare, tagged],
      [tagged, bare],
    ])
      expect(mergeResponses(pair.map((node) => ({ elements: [node] }))).elements).toEqual([tagged]);
    expect(trafficQuery('1,2,3,4')).toContain('node["crossing:markings"]');
    expect(trafficQuery('1,2,3,4')).toContain('node["highway"="stop"]');
  });
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
