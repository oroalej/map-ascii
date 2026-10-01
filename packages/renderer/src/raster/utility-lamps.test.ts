import { expect, it } from 'vitest';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { utilityLampCatalog } from '../../../data/scripts/lib/utility-tiles';
import {
  archive,
  encodeTile,
  road,
  tile,
  type TestLayer,
} from '../../../data/scripts/lib/utility-tiles.fixture';
import { buildTileGeometry, createIdRegistry } from './geometry';
import { tileFixtures } from '../life/fixtures';

it('matches renderer retained support keys and positions, preserving layer order and extent scaling', async () => {
  const scaled: Record<string, TestLayer> = {
    roads: {
      extent: 8192,
      features: [
        {
          ...road(1),
          points: [
            [200, 2000],
            [7000, 2000],
          ],
        },
        {
          ...road(2, 'road_mid', { kind: 'highway=tertiary' }),
          points: [
            [200, 6000],
            [7000, 6000],
          ],
        },
        road(3, 'road_minor'),
        road(4, 'road_major', { region: true }),
        { ...road(5), type: 1, points: [[100, 100]] },
      ],
    },
  };
  const reader = archive([{ tile, layers: scaled }]);
  const catalog = await utilityLampCatalog(reader);
  const parsed = new VectorTile(new PbfReader(encodeTile(scaled)));
  const geometry = buildTileGeometry(parsed.layers, createIdRegistry(), tile, 16);
  const fixtures = tileFixtures(tile, geometry.life).filter((f) => f.kind === 'streetlight');
  expect(catalog.length).toBeGreaterThan(0);
  expect(new Set(catalog.map((l) => l.road))).toEqual(new Set(['osm:way/1', 'osm:way/2']));
  expect(catalog.map((l) => ({ key: l.key, at: l.at }))).toEqual(
    fixtures.map((f) => ({ key: f.supportKey, at: f.base })),
  );
});
