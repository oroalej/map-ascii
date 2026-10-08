import { expect, it } from 'vitest';
import type { ContentBundle } from '@atlas/content';
import type { LandmarkType } from '@atlas/shared';
import { mergeContent } from './04-merge-content';
import type { AtlasFeature } from './03-normalize';

it('adds heritage membership only to heritage landmarks on their existing feature', () => {
  const types: LandmarkType[] = ['heritage', 'church', 'school', 'other'];
  const features: AtlasFeature[] = types.map((type, i) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [i, 0] },
    properties: { id: `osm:node/${i}`, class: 'building' },
    tippecanoe: { layer: 'buildings', minzoom: 12, maxzoom: 16 },
  }));
  const content = {
    landmarks: types.map((type, i) => ({
      id: `landmark/${type}`,
      osm_id: `osm:node/${i}`,
      name: { en: type },
      type,
      certainty: 'unknown',
      sources: [{ title: 'Fixture' }],
    })),
  } as ContentBundle;
  const before = structuredClone(features);
  expect(mergeContent(features, content)).toBe(features);
  expect(features).toHaveLength(types.length);
  features.forEach((feature, i) => {
    expect(feature.geometry).toEqual(before[i]!.geometry);
    expect(feature.properties).toMatchObject({
      id: before[i]!.properties.id,
      class: 'building',
      landmark: true,
      landmark_id: `landmark/${types[i]}`,
    });
    if (i === 0) expect(feature.properties.heritage).toBe(true);
    else expect(feature.properties).not.toHaveProperty('heritage');
  });
  content.landmarks[0]!.type = 'other';
  mergeContent(features, content);
  expect(features[0]!.properties).not.toHaveProperty('heritage');
});

it('swaps a replaced OSM building for curated landmark outlines, in place', () => {
  const ring = (x: number) => [
    [
      [x, 0],
      [x + 1, 0],
      [x + 1, 1],
      [x, 0],
    ],
  ];
  const building = (id: string, x: number): AtlasFeature => ({
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: ring(x) },
    properties: { id, class: 'building', kind: 'building=yes', height: 6, subdivision: 'Centro' },
    tippecanoe: { layer: 'buildings', minzoom: 12, maxzoom: 16 },
  });
  const features = [building('osm:way/1', 0), building('osm:way/2', 5)];
  const outline = (slug: string, x: number) => ({
    id: `landmark/${slug}`,
    geometry: { type: 'Polygon' as const, coordinates: ring(x) },
    replaces: 'osm:way/2',
    name: { en: slug },
    type: 'heritage' as const,
    certainty: 'unknown' as const,
    sources: [{ title: 'Fixture' }],
  });
  const content = { landmarks: [outline('jail', 5), outline('post', 6)] } as ContentBundle;
  expect(mergeContent(features, content)).toBe(features);
  expect(features.map((f) => f.properties.id)).toEqual([
    'osm:way/1',
    'landmark/jail',
    'landmark/post',
  ]);
  const jail = features[1]!;
  expect(jail.geometry).toEqual(content.landmarks[0]!.geometry);
  expect(jail.tippecanoe).toEqual(features[0]!.tippecanoe);
  expect(jail.properties).toMatchObject({
    class: 'building',
    kind: 'building=yes',
    height: 6,
    subdivision: 'Centro',
    landmark: true,
    landmark_id: 'landmark/jail',
    heritage: true,
    name: 'jail',
  });
  expect(jail.properties.label_lng).toBeTypeOf('number');

  const missing = { landmarks: [outline('jail', 5)] } as ContentBundle;
  expect(() => mergeContent([building('osm:way/1', 0)], missing)).toThrow(/not a building polygon/);
  const hosted = {
    landmarks: [
      outline('jail', 5),
      { ...outline('host', 0), geometry: undefined, replaces: undefined, osm_id: 'osm:way/2' },
    ],
  } as ContentBundle;
  expect(() => mergeContent([building('osm:way/2', 5)], hosted)).toThrow(/also hosts a landmark/);
  const loose = { landmarks: [{ ...outline('lost', 5), replaces: undefined }] } as ContentBundle;
  expect(() => mergeContent([building('osm:way/2', 5)], loose)).toThrow(/not supported yet/);
});

it('marks only curated landmarks with facts and heritage sites as notable', () => {
  const fact = { text: { en: 'A fact.' }, source: 0 };
  const records = [
    { type: 'church', facts: [fact, fact, fact] },
    { type: 'heritage' },
    { type: 'school' },
  ] as const;
  const features: AtlasFeature[] = records.map((_, i) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [i, 0] },
    properties: { id: `osm:node/${i}`, class: 'building' },
    tippecanoe: { layer: 'buildings', minzoom: 12, maxzoom: 16 },
  }));
  const content = {
    landmarks: records.map((record, i) => ({
      ...record,
      id: `landmark/${i}`,
      osm_id: `osm:node/${i}`,
      name: { en: `${i}` },
      certainty: 'unknown',
      sources: [{ title: 'Fixture' }],
    })),
  } as unknown as ContentBundle;
  mergeContent(features, content);
  expect(features.map((f) => f.properties.notable)).toEqual([true, true, undefined]);
  expect(features[2]!.properties).toMatchObject({ landmark: true, landmark_id: 'landmark/2' });
});

it('adds heritage membership to a listed church while keeping its type', () => {
  const features: AtlasFeature[] = [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [0, 0] },
      properties: { id: 'osm:way/1', class: 'building_religious' },
      tippecanoe: { layer: 'buildings', minzoom: 12, maxzoom: 16 },
    },
  ];
  const content = {
    landmarks: [
      {
        id: 'landmark/cathedral',
        osm_id: 'osm:way/1',
        name: { en: 'Cathedral' },
        type: 'church',
        heritage: true,
        certainty: 'unknown',
        sources: [{ title: 'Fixture' }],
      },
    ],
  } as ContentBundle;
  mergeContent(features, content);
  expect(features[0]!.properties).toMatchObject({ heritage: true, notable: true, landmark: true });
});
