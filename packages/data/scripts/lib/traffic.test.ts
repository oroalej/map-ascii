import { describe, expect, it } from 'vitest';
import type { AtlasFeature } from '../03-normalize';
import { mergeTraffic, roadJunctions } from './traffic';
import { classify, variantOf } from './classify';
const road = (id: string, coords: number[][]): AtlasFeature => ({
  type: 'Feature',
  geometry: { type: 'LineString', coordinates: coords },
  properties: { id, class: 'road_mid', width: 10 },
  tippecanoe: { layer: 'roads', minzoom: 6, maxzoom: 16 },
});
const cross = () => [
  road('a', [
    [-0.001, 0],
    [0, 0],
    [0.001, 0],
  ]),
  road('b', [
    [0, -0.001],
    [0, 0],
    [0, 0.001],
  ]),
];
const signals = (features: AtlasFeature[]) => features.filter((f) => f.properties.life_signal);
describe('traffic resolution', () => {
  it('derives a signal and four crossings only at a shared four-arm junction', () => {
    const result = mergeTraffic(cross());
    expect(signals(result)).toHaveLength(1);
    expect(result.filter((f) => f.properties.crossing_bearing !== undefined)).toHaveLength(4);
    expect(
      signals(
        mergeTraffic([
          cross()[0]!,
          road('t', [
            [0, 0],
            [0, 0.001],
          ]),
        ]),
      ),
    ).toHaveLength(0);
    expect(
      roadJunctions([
        road('bridge-a', [
          [-0.001, 0],
          [0.001, 0],
        ]),
        road('bridge-b', [
          [0, -0.001],
          [0, 0.001],
        ]),
      ]),
    ).toHaveLength(0);
  });
  it('snaps mapped signals, suppresses nearby derived ones, and respects overrides', () => {
    const mapped: AtlasFeature = {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [0.00005, 0] },
      properties: { id: 'osm:node/5', class: 'furniture', variant: 'signals' },
      tippecanoe: { layer: 'poi', minzoom: 15, maxzoom: 16 },
    };
    const result = mergeTraffic([...cross(), mapped]);
    expect(signals(result)).toHaveLength(1);
    expect(signals(result)[0]!.properties.life_signal).toBe('mapped');
    expect(
      signals(
        mergeTraffic([...cross(), mapped], {
          remove: [{ id: 'remove', osm_id: 5, source: 'Survey' }],
        }),
      ),
    ).toHaveLength(0);
    expect(signals(mergeTraffic(cross(), { derive: false }))).toHaveLength(0);
  });
  it('merges a dual carriageway cluster and preserves a crossing way while adding its anchor', () => {
    const close = cross().map((f) => ({
      ...f,
      properties: { ...f.properties, id: f.properties.id + '2' },
      geometry: {
        type: 'LineString' as const,
        coordinates: (f.geometry as { coordinates: number[][] }).coordinates.map((p) => [
          p[0]! + 0.0002,
          p[1]!,
        ]),
      },
    }));
    expect(signals(mergeTraffic([...cross(), ...close]))).toHaveLength(1);
    const way = road('walk', [
      [0, -0.00005],
      [0, 0],
      [0, 0.00005],
    ]);
    way.properties = { id: 'walk', class: 'path', variant: 'crossing' };
    const out = mergeTraffic([cross()[0]!, way]);
    expect(out).toContain(way);
    expect(out.find((f) => f.properties.id === 'walk:crossing')!.properties.crossing_bearing).toBe(
      90,
    );
  });
  it('classifies marked nodes and keeps crossing ways in the path class', () => {
    expect(classify({ highway: 'traffic_signals' }, 'point', 10)).toBe('furniture');
    expect(classify({ highway: 'crossing', crossing: 'unmarked' }, 'point', 10)).toBeNull();
    expect(variantOf({ highway: 'footway', footway: 'crossing' }, 'path')).toBe('crossing');
  });
});
