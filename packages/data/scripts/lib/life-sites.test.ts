import { describe, expect, it } from 'vitest';
import { CityLife, LifeSite } from '@atlas/shared/schemas';
import { siteOfTags, mergeLifeSites } from './life-sites';
import { classify, variantOf } from './classify';
import { lifeQuery } from '../01-fetch';
import type { AtlasFeature } from '../03-normalize';
describe('interaction site data', () => {
  it('fetches stops, terminals and covered shelters independently', () => {
    expect(lifeQuery('1,2,3,4')).toContain('[bbox:1,2,3,4]');
    for (const tag of ['bus_stop', 'bus_station', 'shelter', 'entrance', 'covered'])
      expect(lifeQuery('1,2,3,4')).toContain(tag);
  });
  it('recognizes modes without treating ferries, trains or ordinary taxi ranks as buses', () => {
    expect(siteOfTags({ highway: 'bus_stop', name: 'Jeepney Stop' })?.modes).toBe(3);
    expect(siteOfTags({ amenity: 'taxi', name: 'Tricycle Terminal' })?.modes).toBe(4);
    expect(siteOfTags({ amenity: 'taxi' })).toBeUndefined();
    expect(siteOfTags({ public_transport: 'platform', ferry: 'yes' })).toBeUndefined();
    expect(siteOfTags({ public_transport: 'platform', railway: 'platform' })).toBeUndefined();
  });
  it('classifies small sites using furniture variants and preserves existing furniture', () => {
    const tags = { highway: 'bus_stop', shelter: 'yes' };
    expect(classify(tags, 'point', 10)).toBe('furniture');
    expect(variantOf(tags, 'furniture')).toBe('stop');
    expect(variantOf({ amenity: 'bench' }, 'furniture')).toBe('bench');
    expect(siteOfTags({ entrance: 'yes', covered: 'yes' })?.kind).toBe('shelter');
  });
  it('joins sourced modes and writes stable anchors, without mutating geometry', () => {
    const f: AtlasFeature = {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [120, 14] },
      properties: { id: 'osm:node/1', class: 'furniture' },
      tippecanoe: { layer: 'poi', minzoom: 13, maxzoom: 16 },
    };
    const result = mergeLifeSites(
      [f],
      [
        LifeSite.parse({
          id: 'stand',
          osm_id: 'osm:node/1',
          kind: 'terminal',
          modes: ['tricycle'],
          source: 'Survey',
        }),
      ],
    );
    expect(result).toHaveLength(1);
    expect(f.properties.life_modes).toBe(4);
    expect(f.properties.life_lng).toBe(120);
    expect(f.properties.variant).toBe('terminal');
    expect(f.geometry.type).toBe('Point');
  });
  it('adds missing sourced sites and fails on missing OSM references', () => {
    const sites = [
      LifeSite.parse({ id: 'shelter', kind: 'shelter', position: [120, 14], source: 'Survey' }),
    ];
    expect(mergeLifeSites([], sites)[0]!.properties.life_covered).toBe(true);
    expect(() =>
      mergeLifeSites(
        [],
        [
          LifeSite.parse({
            id: 'missing',
            osm_id: 'osm:node/1',
            kind: 'stop',
            modes: ['bus'],
            source: 'Survey',
          }),
        ],
      ),
    ).toThrow('missing from OSM');
  });
  it('keeps station grounds and platforms as their own classes, not furniture areas', () => {
    const station = { amenity: 'bus_station', landuse: 'commercial', name: 'Central Station' };
    expect(classify(station, 'area', 10)).not.toBe('furniture');
    expect(classify({ public_transport: 'platform' }, 'line', 10)).not.toBe('furniture');
    expect(classify(station, 'point', 10)).toBe('furniture');
  });
  it('keeps OSM values a pack annotation leaves out', () => {
    const f: AtlasFeature = {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [120, 14] },
      properties: { id: 'osm:node/1', class: 'furniture', life_covered: true, life_modes: 1 },
      tippecanoe: { layer: 'poi', minzoom: 16, maxzoom: 16 },
    };
    mergeLifeSites(
      [f],
      [LifeSite.parse({ id: 'stop', osm_id: 'osm:node/1', kind: 'shelter', source: 'Survey' })],
    );
    expect(f.properties).toMatchObject({ life_covered: true, life_modes: 1, variant: 'shelter' });
    expect(f.tippecanoe.minzoom).toBe(13);
  });
  it('rejects sites the renderer could not show', () => {
    const feature = (properties: Partial<AtlasFeature['properties']>): AtlasFeature => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [120, 14] },
      properties: { id: 'osm:node/1', class: 'furniture', ...properties },
      tippecanoe: { layer: 'poi', minzoom: 13, maxzoom: 16 },
    });
    const ref = LifeSite.parse({
      id: 'stop',
      osm_id: 'osm:node/1',
      kind: 'stop',
      modes: ['bus'],
      source: 'Survey',
    });
    expect(() => mergeLifeSites([feature({ region: true })], [ref])).toThrow('detailed area');
    expect(() => mergeLifeSites([feature({ class: 'road_major' })], [ref])).toThrow('not a site');
    const swapped = LifeSite.parse({
      id: 'swapped',
      kind: 'shelter',
      position: [123.9, 13.6],
      source: 'Survey',
    });
    expect(() => mergeLifeSites([], [swapped], [123, 13, 123.5, 14])).toThrow('outside the region');
  });
  it('rejects contradictory or duplicated pack entries', () => {
    const shelter = { kind: 'shelter', position: [120, 14], source: 'Survey' } as const;
    expect(LifeSite.safeParse({ ...shelter, id: 'a', covered: false }).success).toBe(false);
    expect(LifeSite.safeParse({ ...shelter, id: 'Not A Slug' }).success).toBe(false);
    const ref = { kind: 'stop', osm_id: 'osm:node/1', modes: ['bus'], source: 'Survey' } as const;
    expect(
      CityLife.safeParse({
        sites: [
          { ...ref, id: 'a' },
          { ...ref, id: 'b' },
        ],
      }).success,
    ).toBe(false);
  });
});
