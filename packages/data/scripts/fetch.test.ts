import type { City } from '@atlas/shared';
import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mergeResponses,
  detailParts,
  fetchDetail,
  regionBounds,
  neighborhoodQuery,
  groundsQuery,
  poolsQuery,
  railQuery,
  regionQueries,
  splitBbox,
  trafficQuery,
} from './01-fetch';

it('fetches recreation grounds and their member geometry in a separate bounded query', () => {
  const query = groundsQuery('1,2,3,4');
  expect(query).toContain('[bbox:1,2,3,4]');
  expect(query).toContain('nwr["landuse"="recreation_ground"]');
  expect(query).toContain('out body; >; out skel qt;');
  expect(query).not.toContain('shop');
});

it('fetches pool footprints independently without requiring natural-water tags', () => {
  const query = poolsQuery('1,2,3,4');
  expect(query).toContain('[bbox:1,2,3,4]');
  expect(query).toContain('nwr["leisure"="swimming_pool"]');
  expect(query).toContain('out body; >; out skel qt;');
  expect(query).not.toContain('["natural"');
});

it('fetches commerce and neighborhood vegetation without commercial land-use zones', () => {
  const q = neighborhoodQuery('1,2,3,4');
  for (const tag of [
    'nwr["shop"]',
    'nwr["craft"]',
    'food_court',
    'dentist',
    'scrub|heath',
    'orchard|plant_nursery|cemetery',
    'nwr["amenity"="grave_yard"]',
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

describe('boundary-inclusive detail fetch', () => {
  const expanded: City = { ...city, region: { bbox: [120, 10, 124, 14], include_boundary: true } };
  const bounds = [120, 10, 126, 16] as const;
  it('unions the configured bbox with the boundary only when requested', async () => {
    expect(await regionBounds(expanded, '', { offline: true }, [122, 12, 126, 16])).toEqual(bounds);
    expect(await regionBounds(city, '', { offline: true }, [122, 12, 126, 16])).toEqual([
      120, 10, 124, 14,
    ]);
  });
  it('uses stable quarter filenames and complete bbox coverage', () => {
    expect(detailParts(expanded, [...bounds]).map((p) => p.file)).toEqual(
      [1, 2, 3, 4].map((i) => `detail-part-${i}.osm.json`),
    );
    expect(
      detailParts(expanded, [...bounds]).map((p) => p.query.match(/\[bbox:([^\]]+)\]/)![1]),
    ).toEqual([
      '10.000000,120.000000,13.000000,123.000000',
      '10.000000,123.000000,13.000000,126.000000',
      '13.000000,120.000000,16.000000,123.000000',
      '13.000000,123.000000,16.000000,126.000000',
    ]);
  });
  it('retains legacy offline reuse and rejects incomplete expanded coverage without networking', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atlas-detail-'));
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    try {
      await writeFile(
        join(dir, 'detail.osm.json'),
        JSON.stringify({ elements: [{ type: 'way', id: 1 }] }),
      );
      expect((await fetchDetail(city, [...bounds], dir, { offline: true })).elements).toHaveLength(
        1,
      );
      await expect(fetchDetail(expanded, [...bounds], dir, { offline: true })).rejects.toThrow(
        'detail-part-1',
      );
      const parts = detailParts(expanded, [...bounds]);
      for (const part of parts.slice(0, 3)) {
        await writeFile(
          join(dir, part.file),
          JSON.stringify({ elements: [{ type: 'way', id: 1 }] }),
        );
        await writeFile(join(dir, `${part.file}.query`), part.query);
      }
      await expect(fetchDetail(expanded, [...bounds], dir, { offline: true })).rejects.toThrow(
        'detail-part-4',
      );
      await writeFile(
        join(dir, parts[3]!.file),
        JSON.stringify({ elements: [{ type: 'way', id: 2 }] }),
      );
      await writeFile(join(dir, `${parts[3]!.file}.query`), parts[3]!.query);
      expect(
        (await fetchDetail(expanded, [...bounds], dir, { offline: true })).elements.map(
          (e) => e.id,
        ),
      ).toEqual([1, 2]);
      expect(await readFile(join(dir, 'detail.osm.json.query'), 'utf8')).toContain(
        '[bbox:10.000000,120.000000,16.000000,126.000000]',
      );
      // Aggregate coverage is sufficient on the next offline run.
      expect(
        (await fetchDetail(expanded, [...bounds], dir, { offline: true })).elements,
      ).toHaveLength(2);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('reuses matching successful parts during an online retry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atlas-detail-retry-'));
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ elements: [{ type: 'way', id: 2 }] })));
    vi.stubGlobal('fetch', fetch);
    try {
      for (const part of detailParts(expanded, [...bounds]).slice(0, 3)) {
        await writeFile(
          join(dir, part.file),
          JSON.stringify({ elements: [{ type: 'way', id: 1 }] }),
        );
        await writeFile(join(dir, `${part.file}.query`), part.query);
      }
      expect(
        (await fetchDetail(expanded, [...bounds], dir, { offline: false })).elements,
      ).toHaveLength(2);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it.each([false, true])(
    'handles covering aggregate reuse online with refresh=%s',
    async (refresh) => {
      const dir = await mkdtemp(join(tmpdir(), 'atlas-detail-aggregate-'));
      const fetch = vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ elements: [{ type: 'way', id: 2 }] }))),
      );
      vi.stubGlobal('fetch', fetch);
      try {
        await writeFile(
          join(dir, 'detail.osm.json'),
          JSON.stringify({ elements: [{ type: 'way', id: 1 }] }),
        );
        await writeFile(
          join(dir, 'detail.osm.json.query'),
          detailParts(expanded, [119, 9, 135, 25])[0]!.query,
        );
        const result = await fetchDetail(expanded, [...bounds], dir, { offline: false, refresh });
        expect(result.elements.map((e) => e.id)).toEqual([refresh ? 2 : 1]);
        expect(fetch).toHaveBeenCalledTimes(refresh ? 4 : 0);
      } finally {
        vi.unstubAllGlobals();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});

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
