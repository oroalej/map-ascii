import { expect, it } from 'vitest';
import type { Landmark } from '@atlas/shared';
import { clickableLandmark } from './landmark';

const fact = { text: { en: 'A fact.' }, source: 0 };
const base: Omit<Landmark, 'id'> = {
  name: { en: 'Place' },
  type: 'heritage',
  certainty: 'unknown',
  sources: [{ title: 'Source' }],
  facts: [fact, fact, fact],
};

it('finds clickable landmarks by OSM id, or by landmark id for curated outlines', () => {
  const osm: Landmark = { ...base, id: 'landmark/osm', osm_id: 'osm:way/1' };
  const curated: Landmark = {
    ...base,
    id: 'landmark/curated',
    geometry: { type: 'Polygon', coordinates: [] },
    replaces: 'osm:way/2',
  };
  const { facts: _facts, ...factless } = base;
  const plain: Landmark = { ...factless, id: 'landmark/plain', osm_id: 'osm:way/3' };
  const landmarks = [osm, curated, plain];
  expect(clickableLandmark('osm:way/1', landmarks)).toBe(osm);
  expect(clickableLandmark('landmark/curated', landmarks)).toBe(curated);
  expect(clickableLandmark('osm:way/2', landmarks)).toBeUndefined();
  expect(clickableLandmark('osm:way/3', landmarks)).toBeUndefined();
});
