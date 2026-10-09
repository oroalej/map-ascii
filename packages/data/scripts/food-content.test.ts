import type { ContentBundle } from '@atlas/content';
import type { Dish, Landmark, SubdivisionArea } from '@atlas/shared';
import { searchOptions } from '@atlas/shared';
import { expect, it } from 'vitest';
import MiniSearch from 'minisearch';
import { mergeContent, checkTours } from './04-merge-content';
import { buildSearchIndex, inRegion, searchEntries } from './06-search-index';
import { createTerritory, bboxPolygon } from './lib/territory';
import type { AtlasFeature } from './03-normalize';

const sources = [{ title: 'Fixture research', url: 'https://example.org/food' }];
const facts = [0, 1, 2].map((index) => ({ text: { en: `Food fact ${index}` }, source: 0 }));
const landmark: Landmark = {
  id: 'landmark/noodle-shop',
  name: { en: 'Noodle Shop' },
  type: 'food',
  certainty: 'unknown',
  geometry: { type: 'Point', coordinates: [0.01, 0.01] },
  facts,
  known_for: ['dish/soup'],
  sources,
};
const dish: Dish = {
  id: 'dish/soup',
  name: { en: 'Noodle soup', fil: 'Sabaw' },
  origin: 'unknown',
  description: { en: 'Fixture soup' },
  facts,
  sources,
};
const content: ContentBundle = {
  landmarks: [landmark],
  dishes: [dish],
  events: [],
  tours: [],
  'name-history': [],
  art: [],
  plans: [],
  landcover: [],
  details: [],
  cemeteries: [],
  processions: [],
};
const territory = createTerritory([-1, -1, 1, 1], bboxPolygon([0, 0, 0.1, 0.1]), [0, 0, 0.1, 0.1]);
const areas: SubdivisionArea[] = [
  {
    name: 'Ward',
    approximate: true,
    geometry: { type: 'Polygon', coordinates: bboxPolygon([0, 0, 0.1, 0.1]).coordinates },
  },
];
const market: AtlasFeature = {
  type: 'Feature',
  geometry: bboxPolygon([0, 0, 0.1, 0.1]),
  properties: { id: 'osm:way/1', name: 'Market', class: 'building_market' },
  tippecanoe: { layer: 'buildings', minzoom: 13, maxzoom: 16 },
};
it('keeps the shared market identity while giving a tenant its own selectable Point', () => {
  const merged = mergeContent(structuredClone([market]), content, {
    territory,
    subdivisions: areas,
  });
  expect(merged[0]!.properties).toMatchObject({ id: market.properties.id, name: 'Market' });
  expect(merged[1]).toMatchObject({
    tippecanoe: { layer: 'poi', minzoom: 16 },
    properties: {
      id: landmark.id,
      landmark_id: landmark.id,
      variant: 'shop_food',
      class: 'furniture',
      subdivision: 'Ward',
      subdivision_approx: true,
      label_lng: 0.01,
      label_lat: 0.01,
    },
  });
  expect(merged[1]!.properties.start_year).toBeUndefined();
  const tour = {
    id: 'tour/food',
    title: { en: 'Food' },
    status: 'verified' as const,
    steps: [
      {
        camera: { lng: 0.01, lat: 0.01, zoom: 17 },
        duration_ms: 1000,
        narration: { en: 'Soup' },
        select: landmark.id,
        sources,
      },
    ],
  };
  expect(checkTours(merged, [tour])).toEqual([]);
  expect(checkTours([market], [tour])).toEqual([expect.stringContaining(landmark.id)]);
});
it('rejects duplicate OSM joins, invalid coordinates, and Points outside actual territory', () => {
  const joined = { ...landmark, osm_id: market.properties.id };
  expect(() =>
    mergeContent([market], {
      ...content,
      landmarks: [joined, { ...joined, id: 'landmark/other' }],
    }),
  ).toThrow('Duplicate landmark osm_id');
  expect(() =>
    mergeContent(
      [],
      {
        ...content,
        landmarks: [{ ...landmark, geometry: { type: 'Point', coordinates: [181, 0] } }],
      },
      { territory, subdivisions: [] },
    ),
  ).toThrow();
  expect(() =>
    mergeContent(
      [],
      {
        ...content,
        landmarks: [{ ...landmark, geometry: { type: 'Point', coordinates: [0.5, 0.5] } }],
      },
      { territory, subdivisions: [] },
    ),
  ).toThrow('outside the territory');
});
it('indexes geographic food and non-geographic dishes, including localized dish queries for places', () => {
  const merged = mergeContent([structuredClone(market)], content, {
    territory,
    subdivisions: areas,
  });
  const entries = searchEntries(merged, [], content, territory);
  expect(entries.find((entry) => entry.id === landmark.id)).toMatchObject({
    type: 'food',
    altNames: ['Noodle soup', 'Sabaw'],
    lng: 0.01,
  });
  expect(entries.find((entry) => entry.id === dish.id)).toEqual({
    id: dish.id,
    name: dish.name.en,
    type: 'dish',
    altNames: ['Sabaw'],
  });
  expect(inRegion(entries, [-0.001, -0.001, 0.001, 0.001]).map((entry) => entry.id)).toEqual([
    dish.id,
  ]);
  const file = buildSearchIndex(entries);
  const loaded = MiniSearch.loadJS(file.index as ReturnType<MiniSearch['toJSON']>, searchOptions);
  for (const query of ['Noodle soup', 'Sabaw'])
    expect(loaded.search(query).map((hit) => String(hit.id))).toEqual(
      expect.arrayContaining([dish.id, landmark.id]),
    );
});
