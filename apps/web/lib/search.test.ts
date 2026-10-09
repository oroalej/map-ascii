import { searchOptions, type SearchEntry } from '@atlas/shared';
import MiniSearch from 'minisearch';
import { describe, expect, it } from 'vitest';
import { groupResults, search, TYPE_ORDER } from './search';
import { isSearchIndexFile } from './guards';

const entry = (
  id: string,
  name: string,
  type: Exclude<SearchEntry['type'], 'dish'>,
): SearchEntry => ({
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
  it('loads serialized geographic food and non-geographic dishes with the browser options and guards', () => {
    const foodEntries: SearchEntry[] = [
      { ...entry('landmark/cafe', 'Cafe', 'food'), altNames: ['Noodle soup'] },
      { id: 'dish/soup', name: 'Noodle soup', type: 'dish', altNames: [] },
    ];
    const built = new MiniSearch<SearchEntry>(searchOptions);
    built.addAll(foodEntries);
    const file = JSON.parse(
      JSON.stringify({ version: 1, entries: foodEntries, index: built.toJSON() }),
    ) as { entries: SearchEntry[]; index: ReturnType<MiniSearch['toJSON']> };
    expect(isSearchIndexFile({ ...file, version: 1 })).toBe(true);
    const loaded = {
      entries: new Map(file.entries.map((entry) => [entry.id, entry])),
      index: MiniSearch.loadJS<SearchEntry>(file.index, searchOptions),
    };
    expect(search(loaded, 'Noodle soup').map((group) => group.type)).toEqual(['food', 'dish']);
    expect(
      isSearchIndexFile({
        version: 1,
        index: file.index,
        entries: [{ ...foodEntries[1], lat: 0, lng: 0 }],
      }),
    ).toBe(false);
    expect(
      isSearchIndexFile({
        version: 1,
        index: file.index,
        entries: [{ id: 'dish/soup', name: 'Soup', type: 'food', altNames: [] }],
      }),
    ).toBe(false);
  });
  const index = new MiniSearch<SearchEntry>(searchOptions);
  index.addAll(entries);
  const city = { entries: byId, index };

  it('finds prefixes, folds diacritics, and ignores blank queries', () => {
    expect(search(city, 'cathed')[0]!.entries[0]!.name).toBe('Naga Metropolitan Cathedral');
    expect(search(city, 'penafrancia')[0]!.entries[0]!.id).toBe('osm:node/3');
    expect(search(city, '   ')).toEqual([]);
  });
});
