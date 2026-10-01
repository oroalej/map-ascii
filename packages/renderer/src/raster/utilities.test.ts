import { expect, it, vi } from 'vitest';
import { type UtilityRecord } from '@atlas/shared';
import { buildTileGeometry, createIdRegistry, type TileLayerLike } from './geometry';

const record: UtilityRecord = {
  version: 1,
  kind: 'pole',
  pole: {
    id: 'p',
    road: 'r',
    component: 'r/0',
    at: [123.185012345, 13.62],
    heading: [1, 0],
    normal: [0, 1],
    transformer: false,
  },
};
const utility: TileLayerLike = {
  extent: 4096,
  length: 1,
  feature: () => ({
    type: 1,
    properties: { utility: JSON.stringify(record) },
    loadGeometry: () => {
      throw new Error('Clipped MVT coordinates must not replace precise endpoints');
    },
  }),
};
it('decodes max-zoom records without altering Life geometry or registering selectable features', () => {
  const registry = createIdRegistry();
  const index = vi.spyOn(registry, 'index');
  const tile = { z: 16, x: 55193, y: 30264 };
  const base = buildTileGeometry({}, createIdRegistry(), tile, 16);
  const withUtilities = buildTileGeometry({ utilities: utility }, registry, tile, 16);
  expect(withUtilities.utilities).toEqual([record]);
  expect({ ...withUtilities, utilities: undefined }).toEqual({ ...base, utilities: undefined });
  expect(index).not.toHaveBeenCalled();
  expect(
    buildTileGeometry({ utilities: utility }, registry, { ...tile, z: 15 }, 16).utilities,
  ).toBeUndefined();
});

it('skips bad and future records individually without losing ordinary geometry or valid utilities', () => {
  const values = [
    '{',
    JSON.stringify({ ...record, version: 2 }),
    null,
    JSON.stringify(record),
    JSON.stringify({ ...record, pole: { ...record.pole, normal: [0, 2] } }),
  ];
  const mixed: TileLayerLike = {
    ...utility,
    length: values.length,
    feature: (i) => ({
      ...utility.feature(0),
      // Intentionally malformed input lies outside the declared MVT scalar shape.
      properties: { utility: values[i] as unknown as string },
    }),
  };
  const roads: TileLayerLike = {
    extent: 4096,
    length: 1,
    feature: () => ({
      type: 2,
      properties: { id: 'road', class: 'road_major', width: 8 },
      loadGeometry: () => [
        [
          { x: 100, y: 100 },
          { x: 3000, y: 100 },
        ],
      ],
    }),
  };
  const tile = { z: 16, x: 55193, y: 30264 };
  const base = buildTileGeometry({ roads }, createIdRegistry(), tile, 16);
  const actual = buildTileGeometry({ roads, utilities: mixed }, createIdRegistry(), tile, 16);
  expect(actual.utilities).toEqual([record]);
  expect({ ...actual, utilities: undefined }).toEqual({ ...base, utilities: undefined });
  const badOnly = { ...mixed, length: 3 };
  expect(buildTileGeometry({ roads, utilities: badOnly }, createIdRegistry(), tile, 16)).toEqual(
    base,
  );
});
