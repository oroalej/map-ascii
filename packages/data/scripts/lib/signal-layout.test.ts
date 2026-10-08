import { describe, expect, it } from 'vitest';
import { SignalLayout } from '@atlas/shared/schemas';
import type { AtlasFeature } from '../03-normalize';
import { mergeTraffic } from './traffic';

const road = (id: string, coordinates: number[][], oneway?: -1 | 1): AtlasFeature => ({
  type: 'Feature',
  geometry: { type: 'LineString', coordinates },
  properties: { id, class: 'road_mid', width: 10, oneway },
  tippecanoe: { layer: 'roads', minzoom: 10, maxzoom: 16 },
});
const center: [number, number] = [123, 13];
const east: [number, number] = [123.0001, 13];
const fixture = () => [
  road('west', [[122.999, 13], center]),
  road('east', [center, east, [123.001, 13]]),
  road('south', [[123, 12.999], center]),
  road('north', [east, [123.0001, 13.001]]),
];
const add = (linked_junctions?: [number, number][]) => ({
  derive: false,
  add: [{ id: 'offset', position: center, linked_junctions, source: 'Survey' }],
});
const signal = (out: AtlasFeature[]) => out.find((f) => f.properties.variant === 'signals')!;
const layout = (out: AtlasFeature[]) =>
  SignalLayout.parse(JSON.parse(signal(out).properties.signal_layout!));

describe('resolved signal approaches', () => {
  it('resolves overrides before inbound eligibility and keeps phase axes unchanged', () => {
    const roads = [
      road('osm:way/1', [[122.999, 13], center, [123.001, 13]]),
      road('osm:way/2', [[123, 12.999], center, [123, 13.001]]),
    ];
    const before = mergeTraffic(roads, add());
    const after = mergeTraffic(roads, add(), {
      directions: [
        { osm_id: 'osm:way/1', oneway: 1, source: 'Owner' },
        { osm_id: 'osm:way/2', oneway: -1, source: 'Owner' },
      ],
    });
    expect(
      layout(after)
        .arms.filter((a) => a.inbound)
        .map((a) => a.bearing)
        .sort((a, b) => a - b),
    ).toEqual([90, 180]);
    expect(after.filter((f) => f.properties.variant === 'stop_line')).toHaveLength(2);
    expect(
      layout(after)
        .arms.filter((a) => !a.inbound)
        .every((a) => !a.stop),
    ).toBe(true);
    expect(signal(after).properties.signal_a).toBe(signal(before).properties.signal_a);
    expect(signal(after).properties.signal_b).toBe(signal(before).properties.signal_b);
  });
  it('exposes four exterior approaches for linked T junctions without internal stop lines', () => {
    const out = mergeTraffic(fixture(), add([east]));
    const data = layout(out);
    expect(data.members).toEqual([center, east]);
    expect(data.arms).toHaveLength(4);
    expect(data.arms.map((a) => a.road_id).sort()).toEqual(['east', 'north', 'south', 'west']);
    expect(data.arms.find((a) => a.road_id === 'north')!.group).toBe(
      data.arms.find((a) => a.road_id === 'south')!.group,
    );
    expect(out.filter((f) => f.properties.variant === 'stop_line')).toHaveLength(4);
    let shortCrossingArms = 0;
    const unlinked = mergeTraffic(fixture(), add(), undefined, (stats) => {
      shortCrossingArms = stats.shortCrossingArms;
    });
    // Without the explicit link, the internal connector ends at another junction in 10.8 m.
    // It cannot contain the new 11 m setback; the complete linked layout above can.
    expect(unlinked.filter((f) => f.properties.variant === 'stop_line')).toHaveLength(2);
    expect(shortCrossingArms).toBe(1);
  });
  it('rejects missing, duplicate, disconnected, and multiply owned members', () => {
    expect(() => mergeTraffic(fixture(), add([[124, 14]]))).toThrow('shared road vertex');
    expect(() => mergeTraffic(fixture(), add([center]))).toThrow('Duplicate');
    const elsewhere: [number, number] = [124, 14];
    expect(() =>
      mergeTraffic(
        [
          ...fixture(),
          road('x', [[123.999, 14], elsewhere, [124.001, 14]]),
          road('y', [[124, 13.999], elsewhere, [124, 14.001]]),
        ],
        add([elsewhere]),
      ),
    ).toThrow('Disconnected');
    expect(() =>
      mergeTraffic(fixture(), {
        derive: false,
        add: [...add([east]).add, { id: 'overlap', position: east, source: 'Survey' }],
      }),
    ).toThrow('Duplicate');
  });
});
