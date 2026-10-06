import { expect, it } from 'vitest';
import { decodeCrossingController, SignalLayout, SignalStops } from '@atlas/shared';
import type { AtlasFeature } from '../03-normalize';
import { mergeTraffic } from './traffic';
import { delta } from './road-geometry';

const coord = (x: number, y: number): [number, number] => [x / 111320, y / 111320];
const road = (id: string, points: number[][], oneway?: -1 | 1): AtlasFeature => ({
  type: 'Feature',
  geometry: { type: 'LineString', coordinates: points.map(([x, y]) => coord(x!, y!)) },
  properties: { id, class: 'road_mid', width: 10, oneway },
  tippecanoe: { layer: 'roads', minzoom: 15, maxzoom: 16 },
});
const cross = (id: string, x: number, y: number): AtlasFeature => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: coord(x, y) },
  properties: { id, class: 'furniture', variant: 'crossing' },
  tippecanoe: { layer: 'poi', minzoom: 15, maxzoom: 16 },
});
const controller = (id: string, x: number, y: number): AtlasFeature => ({
  ...cross(id, x, y),
  properties: { id, class: 'furniture', variant: 'signals' },
});
const position = (f: AtlasFeature) => {
  if (f.geometry.type !== 'Point') throw new Error('point required');
  return f.geometry.coordinates;
};

it('links only the owned arm, retains exact coordinates and sets its stop behind the mapped band', () => {
  const out = mergeTraffic([
    road('ew', [
      [-100, 0],
      [0, 0],
      [100, 0],
    ]),
    road('ns', [
      [0, -100],
      [0, 0],
      [0, 100],
    ]),
    road('parallel', [
      [-100, 5],
      [100, 5],
    ]),
    cross('mapped', 16, 0),
    cross('parallel-cross', 8, 5),
    cross('remote', -25, 0),
  ]);
  const signal = out.find((f) => f.properties.variant === 'signals')!,
    layout = SignalLayout.parse(JSON.parse(signal.properties.signal_layout!));
  const mapped = out.find((f) => f.properties.id === 'mapped')!,
    record = decodeCrossingController(mapped.properties)!;
  expect(record.at).toEqual(position(signal));
  expect(record.seed).toBe(signal.properties.signal_seed);
  expect(
    decodeCrossingController(out.find((f) => f.properties.id === 'parallel-cross')!.properties),
  ).toBeUndefined();
  expect(
    decodeCrossingController(out.find((f) => f.properties.id === 'remote')!.properties),
  ).toBeUndefined();
  expect(out.filter((f) => f.properties.crossing_signal)).toHaveLength(4);
  const arm = layout.arms.find((a) => a.road_id === 'ew' && a.direction === -1)!;
  expect(Math.hypot(...delta(arm.junction, arm.stop!))).toBeGreaterThanOrEqual(19);
  expect(record.walk).toBe(arm.group === 'a' ? 'b' : 'a');
  const opposite = out.find((f) => f.properties.crossing_signal && position(f)[0]! < 0)!;
  expect(position(opposite)[0]! * 111320).toBeCloseTo(-8);
});

it('places crossings and local stop tangents beyond short initial bends in both directions', () => {
  const out = mergeTraffic([
    road('bent', [
      [-2, -100],
      [-2, 0],
      [0, 0],
      [2, 0],
      [2, 100],
    ]),
    road('other', [
      [0, -100],
      [0, 0],
      [0, 100],
    ]),
  ]);
  const signal = out.find((f) => f.properties.variant === 'signals')!;
  const arms = SignalLayout.parse(JSON.parse(signal.properties.signal_layout!)).arms.filter(
    (a) => a.road_id === 'bent',
  );
  expect(arms).toHaveLength(2);
  for (const a of arms) {
    expect(a.stop_bearing).toBe(a.direction === -1 ? 180 : 0);
    expect(a.bearing).toBe(a.direction === -1 ? 270 : 90);
    expect(Math.abs(a.stop![1] * 111320)).toBeCloseTo(9);
    const paint = out.find(
      (f) =>
        f.properties.variant === 'stop_line' &&
        f.properties.stop_bearing === a.stop_bearing &&
        Math.sign(position(f)[1]!) === Math.sign(a.stop![1]),
    )!;
    expect(position(paint)).toEqual(a.stop);
  }
  const bands = out.filter(
    (f) => f.properties.crossing_signal && Math.abs(position(f)[0]! * 111320) === 2,
  );
  expect(bands).toHaveLength(2);
  expect(bands.every((f) => f.properties.crossing_bearing === 0)).toBe(true);
});

it('resolves competing claims by distance with one owner and a fallback on the losing arm', () => {
  const out = mergeTraffic(
    [
      road('ew', [
        [-100, 0],
        [0, 0],
        [30, 0],
        [100, 0],
      ]),
      road('ns1', [
        [0, -100],
        [0, 0],
        [0, 100],
      ]),
      road('ns2', [
        [30, -100],
        [30, 0],
        [30, 100],
      ]),
      cross('shared', 14, 0),
    ],
    {
      derive: false,
      add: [
        { id: 'first', position: coord(0, 0), source: 'test' },
        { id: 'second', position: coord(30, 0), source: 'test' },
      ],
    },
  );
  expect(out.find((f) => f.properties.id === 'shared')!.properties.crossing_signal).toBe(
    'pack:signal:first',
  );
  expect(out.filter((f) => f.properties.crossing_signal === 'pack:signal:second')).toHaveLength(4);
});

it('encodes every mid-block inbound stop as a, for both road axes and one-way rules', () => {
  for (const vertical of [false, true])
    for (const oneway of [undefined, -1, 1] as const) {
      const points = vertical
        ? [
            [0, -100],
            [0, 0],
            [0, 100],
          ]
        : [
            [-100, 0],
            [0, 0],
            [100, 0],
          ];
      const out = mergeTraffic(
        [road('mid', points, oneway), controller('mid-controller', 0, 0), cross('mid-cross', 0, 0)],
        { derive: false },
      );
      const s = out.find((f) => f.properties.variant === 'signals')!,
        stops = SignalStops.parse(JSON.parse(s.properties.signal_stops!));
      expect(stops).toHaveLength(oneway ? 1 : 2);
      expect(stops.every((a) => a.group === 'a' && a.stop_bearing !== undefined)).toBe(true);
      expect(
        decodeCrossingController(out.find((f) => f.properties.id === 'mid-cross')!.properties),
      ).toMatchObject({ midBlock: true, walk: 'a' });
      expect(out.filter((f) => f.properties.variant === 'stop_line').map(position)).toEqual(
        stops.map((a) => a.stop),
      );
    }
});
