import { expect, it } from 'vitest';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import {
  canonicalSignalSeed,
  crossingControllerProperties,
  type SignalController,
} from '@atlas/shared';
import { encodeTile, type TestFeature } from '../../../data/scripts/lib/utility-tiles.fixture';
import {
  buildTileGeometry,
  createIdRegistry,
  lngLatToTile,
  tileToLngLat,
  metersPerUnit,
  EXTENT,
  MERCATOR_METERS,
} from './geometry';
import { lifeTransferables } from '../life/geometry';
import { TileLife } from '../life/simulate';
import { tileFixtures } from '../life/fixtures';
import { placeSeed } from '../life/lights';
import { classId, Flags } from '../classes';

it('keeps the renderer legacy hash aligned with pinned canonical controller seeds', () => {
  for (const [lng, lat, seed] of [
    [123.1859231, 13.6248803, 1892173763],
    [0, 0, 4166576904],
    [-179, 80, 3591633896],
  ] as const) {
    const p = lngLatToTile({ z: 16, x: 0, y: 0 }, lng, lat),
      scale = MERCATOR_METERS / 2 ** 16 / EXTENT;
    expect(placeSeed(Math.round(p.x) * scale, Math.round(p.y) * scale)).toBe(seed);
    expect(canonicalSignalSeed(lng, lat, 16)).toBe(seed);
  }
});

const tile = { z: 16, x: 55194, y: 30264 };
const at = tileToLngLat(tile, { x: 2000, y: 2000 });
const pm = 1 / metersPerUnit(tile);
const crossingAt = tileToLngLat(tile, { x: 2000 - 8 * pm, y: 2000 });
const controller = (seed: number): SignalController => ({
  id: 'signal',
  at,
  seed,
  radius: 6,
  a: 90,
  b: 0,
  mapped: true,
  layout: {
    members: [at],
    arms: [
      {
        road_id: 'osm:way/1',
        junction: at,
        toward: tileToLngLat(tile, { x: 100, y: 2000 }),
        direction: 1,
        inbound: true,
        outbound: true,
        group: 'a',
        bearing: 90,
        width: 10,
        stop: tileToLngLat(tile, { x: 2000 - 11 * pm, y: 2000 + 2.5 * pm }),
        stop_width: 5,
        stop_bearing: 90,
      },
    ],
  },
});
const point = (
  id: number,
  properties: TestFeature['properties'],
  position: [number, number],
  address = tile,
): TestFeature => {
  const p = lngLatToTile(address, ...position);
  return { id, type: 1, properties, points: [[Math.round(p.x), Math.round(p.y)]] };
};
function decode(
  seed: number,
  signalPresent = true,
  address = tile,
  extra: Record<string, string | number | boolean> = {},
) {
  const signal = controller(seed);
  const crossing = point(
    1,
    {
      id: 'cross',
      class: 'furniture',
      variant: 'crossing',
      crossing_width: 10,
      crossing_bearing: 90,
      ...crossingControllerProperties({ id: signal.id, at, seed, midBlock: false, walk: 'b' }),
      crossing_signal_control: JSON.stringify(signal),
      ...extra,
    },
    crossingAt,
    address,
  );
  const features = [crossing];
  if (signalPresent)
    features.push(
      point(
        2,
        {
          id: 'signal',
          class: 'furniture',
          variant: 'signals',
          signal_seed: seed,
          signal_radius: 6,
          signal_a: 90,
          signal_b: 0,
          life_signal: 'mapped',
          signal_layout: JSON.stringify(signal.layout),
        },
        at,
        address,
      ),
    );
  features.push(
    point(
      3,
      {
        id: 'legacy',
        class: 'furniture',
        variant: 'signals',
        signal_radius: 4,
        signal_a: 90,
        signal_b: 0,
      },
      tileToLngLat(tile, { x: 3000, y: 3000 }),
      address,
    ),
  );
  const parsed = new VectorTile(new PbfReader(encodeTile({ poi: { features } })));
  return buildTileGeometry(parsed.layers, createIdRegistry(), address, 16).life;
}

it('decodes exact scalar controller data with mixed old/new seeds through a real MVT and transfer', () => {
  for (const seed of [0, 0xffffffff]) {
    const geo = decode(seed);
    expect(geo.signals).toHaveLength(12);
    expect(geo.signalSeeds).toEqual([seed, undefined]);
    expect(geo.controlledCrossings![0]!.controller).toEqual({
      id: 'signal',
      at,
      seed,
      midBlock: false,
      walk: 'b',
    });
    const life = new TileLife(tile, geo, 1);
    expect(life.signals.signals[0]!.seed).toBe(seed);
    expect(
      tileFixtures(tile, geo)
        .filter((f) => f.kind === 'signal')
        .filter((f) => f.seed === seed),
    ).toHaveLength(1);
    const x = geo.signals![6]!,
      y = geo.signals![7]!,
      scale = MERCATOR_METERS / (EXTENT * 2 ** tile.z);
    expect(life.signals.signals[1]!.seed).toBe(
      placeSeed((tile.x * EXTENT + x) * scale, (tile.y * EXTENT + y) * scale),
    );
    expect(
      tileFixtures(tile, geo)
        .filter((f) => f.kind === 'signal')
        .slice(1)
        .every((f) => f.seed === life.signals.signals[1]!.seed),
    ).toBe(true);
    const transferred = structuredClone(geo, { transfer: lifeTransferables(geo) });
    expect(transferred.signalSeeds).toEqual([seed, undefined]);
    expect(new TileLife(tile, transferred, 1).signals.signals[0]!.seed).toBe(seed);
  }
});

it('resolves phases and complete vehicle stop metadata without the controller feature across source zooms and buffers', () => {
  const seed = 0xfedcba98;
  for (const address of [
    tile,
    { ...tile, x: tile.x + 1 },
    { z: 15, x: Math.floor(tile.x / 2), y: Math.floor(tile.y / 2) },
  ]) {
    const geo = decode(seed, false, address);
    expect(geo.signalLayouts![0]).toEqual(controller(seed).layout);
    expect(geo.controlledCrossings![0]!.controller.at).toEqual(at);
    expect(new TileLife(address, geo, 1).signals.signals[0]!.seed).toBe(seed);
  }
});

it('rejects partial, malformed and inconsistent controlled scalar records on real MVT decode', () => {
  const cases: Record<string, string | number | boolean>[] = [
    { crossing_signal_at: 'broken' },
    { crossing_signal_seed: -1 },
    { crossing_walk: 'c' },
    { crossing_signal_control: '{}' },
    { crossing_signal_control: JSON.stringify({ ...controller(1), seed: 2 }) },
  ];
  for (const extra of cases) expect(() => decode(1, false, tile, extra)).toThrow();
  const orphaned: TestFeature['properties'][] = [
    { crossing_signal: 'signal' },
    { crossing_signal_control: JSON.stringify(controller(1)) },
  ];
  for (const properties of orphaned) {
    const feature = point(
      1,
      { id: 'cross', class: 'furniture', variant: 'crossing', ...properties },
      crossingAt,
    );
    const parsed = new VectorTile(new PbfReader(encodeTile({ poi: { features: [feature] } })));
    expect(() => buildTileGeometry(parsed.layers, createIdRegistry(), tile, 16)).toThrow();
  }
});

it('paints owned corridor pads only in detailed source tiles while retaining coarse gates', () => {
  for (const z of [14, 15, 16]) {
    const address = { z, x: tile.x >>> (16 - z), y: tile.y >>> (16 - z) };
    const project = (x: number, y: number): [number, number] => {
      const p = lngLatToTile(address, ...tileToLngLat(tile, { x, y }));
      return [Math.round(p.x), Math.round(p.y)];
    };
    const road: TestFeature = {
      id: 1,
      type: 2,
      properties: { id: 'road', class: 'road_mid', width: 10 },
      points: [project(2000 - 20 * pm, 2000), project(2000 + 20 * pm, 2000)],
    };
    const cross = point(
      2,
      {
        id: 'cross',
        class: 'furniture',
        variant: 'crossing',
        crossing_width: 10,
        crossing_bearing: 90,
        ...crossingControllerProperties({ id: 'signal', at, seed: 7, midBlock: false, walk: 'a' }),
      },
      at,
      address,
    );
    const parsed = new VectorTile(
      new PbfReader(encodeTile({ roads: { features: [road] }, poi: { features: [cross] } })),
    );
    const registry = createIdRegistry();
    const geometry = buildTileGeometry(parsed.layers, registry, address, 16, false);
    expect(geometry.life.controlledCrossings![0]!.sides!.flatMap((s) => s.pads)).toHaveLength(2);
    const pads = Array.from(geometry.fills.ids.keys()).filter(
      (i) => geometry.fills.meta[i * 4 + 2]! & Flags.sidewalk,
    );
    if (z < 15) expect(pads).toHaveLength(0);
    else {
      expect(pads).toHaveLength(8);
      for (const i of pads) {
        expect(geometry.fills.meta[i * 4]).toBe(classId('path'));
        expect(geometry.fills.meta[i * 4 + 2]).toBe(Flags.corridor | Flags.sidewalk);
        expect(geometry.fills.ids[i]).toBe(registry.index('cross'));
      }
    }
  }
});
