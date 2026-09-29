import { searchOptions, type SearchEntry } from '@atlas/shared';
import MiniSearch from 'minisearch';
import { describe, expect, it } from 'vitest';
import { groupResults, search, TYPE_ORDER } from './search';

const entry = (id: string, name: string, type: SearchEntry['type']): SearchEntry => ({
  id,
  name,
  altNames: [],
  type,
  lat: 13.6,
  lng: 123.2,
  zoomHint: 17,
});

const entries = [
  entry('osm:way/1', 'Naga Metropolitan Cathedral', 'landmark'),
  entry('street/cathedral-street', 'Cathedral Street', 'street'),
  entry('osm:way/2', 'Cathedral Grounds', 'worship'),
  entry('osm:node/3', 'Peñafrancia', 'subdivision'),
];
const byId = new Map(entries.map((e) => [e.id, e]));

describe('groupResults', () => {
  it('groups by type in the fixed order, keeping the hit order within a group', () => {
    const groups = groupResults(['osm:way/2', 'street/cathedral-street', 'osm:way/1'], byId);
    expect(groups.map((g) => g.type)).toEqual(['landmark', 'street', 'worship']);
    expect(TYPE_ORDER.indexOf('landmark')).toBe(0);
  });

  it('caps each group and skips unknown ids', () => {
    const many = new Map(
      Array.from({ length: 8 }, (_, i) => [`s${i}`, entry(`s${i}`, `Street ${i}`, 'street')]),
    );
    const groups = groupResults(['nope', ...many.keys()], many, 3);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.entries.map((e) => e.id)).toEqual(['s0', 's1', 's2']);
  });
});

describe('search', () => {
  const index = new MiniSearch<SearchEntry>(searchOptions);
  index.addAll(entries);
  const city = { entries: byId, index };

  it('finds prefixes, folds diacritics, and ignores blank queries', () => {
    expect(search(city, 'cathed')[0]!.entries[0]!.name).toBe('Naga Metropolitan Cathedral');
    expect(search(city, 'penafrancia')[0]!.entries[0]!.id).toBe('osm:node/3');
    expect(search(city, '   ')).toEqual([]);
  });
});
