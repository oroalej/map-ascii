import { expect, it } from 'vitest';
import { runtimeCityLife, runtimeSeason, type SeasonConfig } from '@atlas/shared';
import { simulationSeasons } from './seasonal-simulation';

it('delivers an emoji-only composed pool without inventing physical installations', () => {
  const runtime = runtimeCityLife({
    source: 'Fixture',
    seasons: [
      {
        id: 'preview',
        title: { en: 'Preview' },
        includes: ['base'],
        window: { from: { month: 12, day: 31 }, to: { month: 1, day: 1 } },
        emoji: [{ mood: 'party', subjects: ['person'], weight: 2 }],
        sources: [],
      },
      {
        id: 'base',
        title: { en: 'Base' },
        window: { from: { month: 12, day: 1 }, to: { month: 1, day: 6 } },
        emoji: [{ mood: 'love', subjects: ['dog'], weight: 1 }],
        sources: [],
      },
    ],
  });
  expect(simulationSeasons(runtime.seasons)).toEqual([
    {
      id: 'preview',
      includes: ['base'],
      emoji: [
        { mood: 'party', subjects: ['person'], weight: 2 },
        { mood: 'love', subjects: ['dog'], weight: 1 },
      ],
    },
    { id: 'base', emoji: [{ mood: 'love', subjects: ['dog'], weight: 1 }] },
  ]);
});

it('sends only stall admission and physical installation identities, omitting layout and prose', () => {
  const season: SeasonConfig = {
    id: 'winter',
    title: { en: 'Winter' },
    window: { from: { month: 12, day: 1 }, to: { month: 1, day: 6 } },
    sources: [{ title: 'Calendar', url: 'https://example.com/' }],
    stalls: { label: 'Carts', near: ['worship'], radius_m: 300, per_tile: 12 },
    installations: [
      {
        id: 'fair',
        kind: 'carnival',
        anchor: 'osm:way/1',
        label: 'Carnival',
        grounds: 'lot',
        components: [
          { id: 'carousel', style: 'carousel', at: [0, 0], size_m: [18, 18], angle_deg: 0 },
        ],
        sources: [],
      },
      {
        id: 'tree',
        kind: 'christmas-tree',
        anchor: 'osm:way/1',
        label: 'Tree',
        radius_m: 5,
        sources: [{ title: 'Display', url: 'https://example.com/' }],
      },
      {
        id: 'lights',
        kind: 'light-string',
        anchor: 'osm:way/1',
        label: 'Lights',
        layout: 'perimeter',
        spacing_m: 5,
        sources: [{ title: 'Display', url: 'https://example.com/' }],
      },
    ],
  };
  const table = structuredClone(simulationSeasons([season]));
  expect(table).toEqual([
    {
      id: 'winter',
      stalls: { near: ['worship'], radius_m: 300, per_tile: 12 },
      installations: [
        { id: 'fair', anchor: 'osm:way/1', kind: 'carnival' },
        { id: 'tree', anchor: 'osm:way/1', kind: 'christmas-tree' },
      ],
    },
  ]);
  expect(simulationSeasons([runtimeSeason(season)])).toEqual(table);
  const runtime = runtimeCityLife({
    source: 'Synthetic calendar',
    seasons: [
      {
        id: 'new-year',
        title: { en: 'New Year' },
        window: season.window,
        includes: ['winter'],
        fireworks: { label: 'Fireworks', variants: ['peony'] },
        sources: season.sources,
      },
      season,
    ],
  });
  expect(simulationSeasons(runtime.seasons)[0]).toEqual({
    ...table[0],
    id: 'new-year',
    includes: ['winter'],
  });
  expect(
    simulationSeasons([
      { ...season, stalls: undefined, installations: [season.installations![2]!] },
    ]),
  ).toEqual([]);
});
