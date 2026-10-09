import { describe, expect, it } from 'vitest';
import type { SearchEntry } from '@atlas/shared';
import type { ContentBundle } from '@atlas/content';
import type { AtlasFeature } from './03-normalize';
import { entryBbox, inRegion, searchEntries } from './06-search-index';

it('uses explicit stable label anchors for searchable areas instead of an exterior centroid', () => {
  const feature: AtlasFeature = {
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [123, 13],
          [123.01, 13],
          [123.01, 13.001],
          [123.001, 13.001],
          [123.001, 13.01],
          [123, 13.01],
          [123, 13],
        ],
      ],
    },
    properties: {
      id: 'osm:way/1',
      class: 'grass',
      landmark: true,
      name: 'Fixture cemetery',
      label_lng: 123.0005,
      label_lat: 13.005,
      osm_name: 'Memorial Park',
    },
    tippecanoe: { layer: 'landuse', minzoom: 13, maxzoom: 16 },
  };
  const content = {
    landmarks: [],
    events: [],
    'name-history': [],
    tours: [],
    art: [],
    plans: [],
    landcover: [],
    details: [],
    cemeteries: [],
    dishes: [],
    processions: [],
  } satisfies ContentBundle;
  expect(searchEntries([feature], [], content)[0]).toMatchObject({
    lng: 123.0005,
    lat: 13.005,
    altNames: ['Memorial Park'],
  });
});

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
