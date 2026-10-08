import { expect, it, vi } from 'vitest';
import type { SeasonalRecord } from '@atlas/shared';
import * as shared from '@atlas/shared';
import { buildTileGeometry, createIdRegistry, transferables, type TileLayerLike } from './geometry';
import { seasonalRecords, physicalSeasonalRecords } from '../life/geometry';
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
it('sends only physical trees to the Life worker and keeps exact envelopes independent of clipping', () => {
  const common = {
    version: 1,
    id: 'tree',
    season: 'winter',
    installation: 'tree',
    anchor: 'osm:way/1',
    seed: 1,
  };
  const tree = { ...common, kind: 'christmas-tree', at: [123.185, 13.62], radius_m: 5 };
  const crown = { ...tree, id: 'crown', kind: 'decorated-canopy' };
  const string = {
    ...common,
    id: 'cord',
    kind: 'light-string',
    from: [123.185, 13.62],
    to: [123.186, 13.62],
  };
  const payloads = [tree, crown, string, { ...tree, version: 2 }];
  const layer: TileLayerLike = {
    ...seasonal,
    length: payloads.length,
    feature: (i) => ({
      ...seasonal.feature(0),
      properties: { seasonal: JSON.stringify(payloads[i]) },
    }),
  };
  const result = buildTileGeometry({ roads, seasons: layer }, createIdRegistry(), tile, 16);
  expect(seasonalRecords(result.seasonal)).toEqual([tree, crown, string]);
  expect(physicalSeasonalRecords(result.life)).toEqual([tree]);
  expect(result.fills).toEqual(buildTileGeometry({ roads }, createIdRegistry(), tile, 16).fills);
});
it('keeps world spans outside ordinary geometry, picking and the simulation worker', () => {
  const registry = createIdRegistry(),
    index = vi.spyOn(registry, 'index');
  const base = buildTileGeometry({ roads }, createIdRegistry(), tile, 16);
  const result = buildTileGeometry({ roads, seasons: seasonal }, registry, tile, 16);
  expect(seasonalRecords(result.seasonal)).toEqual([record]);
  expect({
    ...result,
    seasonal: undefined,
    life: { ...result.life, seasonalPayload: undefined },
  }).toEqual({ ...base, seasonal: undefined, life: { ...base.life, seasonalPayload: undefined } });
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
  expect(seasonalRecords(result.seasonal)).toEqual([record]);
  expect({
    ...result,
    seasonal: undefined,
    life: { ...result.life, seasonalPayload: undefined },
  }).toEqual({ ...base, seasonal: undefined, life: { ...base.life, seasonalPayload: undefined } });
  expect(
    seasonalRecords(
      buildTileGeometry({ roads, seasons: { ...layer, length: 3 } }, createIdRegistry(), tile, 16)
        .seasonal,
    ),
  ).toEqual([]);
});
it('transfers raw bytes without validating inactive records and caches validation on demand', () => {
  const parse = vi.spyOn(shared, 'parseSeasonalTileRecord');
  const result = buildTileGeometry({ seasons: seasonal }, createIdRegistry(), tile, 16);
  expect(parse).not.toHaveBeenCalled();
  expect(result.seasonal).toBeInstanceOf(Uint8Array);
  expect(result.life.seasonalPayload).toBe(result.seasonal);
  const buffer = (result.seasonal as Uint8Array).buffer;
  expect(transferables(result).filter((entry) => entry === buffer)).toHaveLength(1);
  const decoded = seasonalRecords(result.seasonal);
  expect(decoded).toEqual([record]);
  expect(parse).toHaveBeenCalledOnce();
  expect(seasonalRecords(result.seasonal)).toBe(decoded);
  expect(parse).toHaveBeenCalledOnce();
  parse.mockRestore();
});
