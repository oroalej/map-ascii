import { expect, it } from 'vitest';
import type { SeasonConfig } from '@atlas/shared';
import { simulationSeasons } from './seasonal-simulation';

it('sends only stall admission and physical installation identities, omitting layout and prose', () => {
  const season: SeasonConfig = {
    id: 'winter',
    title: { en: 'Winter' },
    status: 'draft',
    note: 'Reference only',
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
  expect(
    simulationSeasons([
      { ...season, stalls: undefined, installations: [season.installations![2]!] },
    ]),
  ).toEqual([]);
});
