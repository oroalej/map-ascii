import { expect, it, vi } from 'vitest';
import type { SeasonalRecord } from '@atlas/shared';
import { buildTileGeometry, createIdRegistry, type TileLayerLike } from './geometry';
const record: SeasonalRecord = {
  version: 1,
  kind: 'bunting',
  id: 'a',
  season: 'feast',
  corridor: 'route',
  road: 'osm:way/1',
  from: [123.185012345, 13.62],
  to: [123.185112345, 13.62],
  segment: [
    [123.185, 13.619],
    [123.185, 13.621],
  ],
  seed: 7,
};
const tile = { z: 16, x: 55193, y: 30264 };
const seasonal: TileLayerLike = {
  extent: 4096,
  length: 1,
  feature: () => ({
    type: 2,
    properties: { seasonal: JSON.stringify(record) },
    loadGeometry: () => {
      throw new Error('Clipped geometry must not replace exact world spans');
    },
  }),
};
const roads: TileLayerLike = {
  extent: 4096,
  length: 1,
  feature: () => ({
    type: 2,
    properties: { id: 'osm:way/1', class: 'road_major', width: 8 },
    loadGeometry: () => [
      [
        { x: 100, y: 100 },
        { x: 3000, y: 100 },
      ],
    ],
  }),
};
it('keeps world spans outside ordinary geometry, picking and the simulation worker', () => {
  const registry = createIdRegistry(),
    index = vi.spyOn(registry, 'index');
  const base = buildTileGeometry({ roads }, createIdRegistry(), tile, 16);
  const result = buildTileGeometry({ roads, seasons: seasonal }, registry, tile, 16);
  expect(result.seasonal).toEqual([record]);
  expect({ ...result, seasonal: undefined }).toEqual({ ...base, seasonal: undefined });
  expect(index).toHaveBeenCalledTimes(1);
  expect(
    buildTileGeometry({ seasons: seasonal }, registry, { ...tile, z: 15 }, 16).seasonal,
  ).toBeUndefined();
});
it('ignores malformed and future decoration records without losing the map or valid rows', () => {
  const values = [
    '{',
    JSON.stringify({ ...record, version: 2 }),
    JSON.stringify({ ...record, seed: -1 }),
    JSON.stringify(record),
  ];
  const layer: TileLayerLike = {
    ...seasonal,
    length: values.length,
    feature: (i) => ({ ...seasonal.feature(0), properties: { seasonal: values[i]! } }),
  };
  const base = buildTileGeometry({ roads }, createIdRegistry(), tile, 16);
  const result = buildTileGeometry({ roads, seasons: layer }, createIdRegistry(), tile, 16);
  expect(result.seasonal).toEqual([record]);
  expect({ ...result, seasonal: undefined }).toEqual({ ...base, seasonal: undefined });
  expect(
    buildTileGeometry({ roads, seasons: { ...layer, length: 3 } }, createIdRegistry(), tile, 16),
  ).toEqual(base);
});
