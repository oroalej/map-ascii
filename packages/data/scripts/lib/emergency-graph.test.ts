import { describe, expect, it } from 'vitest';
import { decodeEmergency, encodeEmergency, type EmergencyConfig } from '@atlas/shared';
import type { AtlasFeature } from '../03-normalize';
import { buildEmergencyGraph } from './emergency-graph';

const scale = 1 / 111320;
const point = (x: number, y: number) => [x * scale, y * scale];
const road = (id: string, vertices: number[][], flow?: -1 | 1): AtlasFeature => ({
  type: 'Feature',
  geometry: { type: 'LineString', coordinates: vertices.map(([x, y]) => point(x!, y!)) },
  properties: { id, class: 'road_mid', ...(flow && { oneway: flow }) },
  tippecanoe: { layer: 'roads', minzoom: 6, maxzoom: 16 },
});
const building = (id: string, x: number, y: number, kind = 'hospital'): AtlasFeature => ({
  type: 'Feature',
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [x - 1, y - 1],
        [x + 1, y - 1],
        [x + 1, y + 1],
        [x - 1, y + 1],
        [x - 1, y - 1],
      ].map(([a, b]) => point(a!, b!)),
    ],
  },
  properties: {
    id,
    class: kind === 'hospital' ? 'building_hospital' : 'building',
    ...(kind !== 'hospital' && kind !== 'building' && { kind: `amenity=${kind}` }),
  },
  tippecanoe: { layer: 'buildings', minzoom: 13, maxzoom: 16 },
});
const config: EmergencyConfig = {
  ambulance: { max: 1, interval_s: [10, 20], dwell_s: [2, 3] },
  police: { max: 1, interval_s: [10, 20], call_every_s: [2, 3], call_s: [2, 3] },
  fire: { max: 1, interval_s: [10, 20], dwell_s: [2, 3] },
  exclude: ['osm:way/9'],
  source: 'synthetic',
};
const features = [
  road(
    'osm:way/1',
    [
      [0, 0],
      [100, 0],
      [150, 50],
      [200, 50],
    ],
    1,
  ),
  road('osm:way/2', [
    [200, 50],
    [200, 200],
  ]),
  road(
    'osm:way/3',
    [
      [200, 200],
      [0, 200],
      [0, 0],
    ],
    1,
  ),
  road('osm:way/4', [
    [1000, 1000],
    [1100, 1000],
  ]),
  building('osm:way/5', 125, 30),
  building('osm:way/6', 195, 120, 'police'),
  building('osm:way/7', 30, 195, 'fire_station'),
  building('osm:way/8', 70, 10, 'building'),
  building('osm:way/9', 180, 90, 'police'),
];
describe('emergency graph bake', () => {
  it('contracts source chains, preserves one-way transitions and keeps the main directed SCC', () => {
    const result = buildEmergencyGraph(features, config);
    expect(result.nodes).toHaveLength(3);
    expect(result.edges).toHaveLength(3);
    expect(result.edges.filter((e) => e.oneway !== 0)).toHaveLength(2);
    expect(result.nodes.every(([x]) => x < 500 * scale)).toBe(true);
    const curved = result.edges.find((e) => e.shape.length === 4)!;
    expect(curved.length).toBeCloseTo(100 + Math.hypot(50, 50) + 50, 3);
    expect(curved.bearing).toEqual([0, 0]);
  });
  it('snaps against the curved segments, stores cumulative progress and signed target sides, and excludes guardhouses', () => {
    const result = buildEmergencyGraph(features, config);
    const hospital = result.targets.find((t) => t.kind === 'hospital')!;
    expect(hospital.at[0] / scale).toBeCloseTo(127.5, 3);
    expect(hospital.at[1] / scale).toBeCloseTo(27.5, 3);
    expect(hospital.t).toBeCloseTo((100 + Math.hypot(27.5, 27.5)) / (150 + Math.hypot(50, 50)), 3);
    expect(hospital.side).toBe(1);
    expect(hospital.road).toBe('osm:way/1');
    expect(result.targets.some((t) => t.id === 'osm:way/9')).toBe(false);
    const decoded = decodeEmergency(encodeEmergency(result));
    expect(decoded.edges.map((e) => e.oneway)).toEqual(result.edges.map((e) => e.oneway));
    expect(decoded.targets.map((t) => [t.id, t.kind, t.side, t.road])).toEqual(
      result.targets.map((t) => [t.id, t.kind, t.side, t.road]),
    );
  });
  it('fails loudly for missing configured stations and accepts a standalone cycle', () => {
    expect(() =>
      buildEmergencyGraph(
        features.filter((f) => f.properties.id !== 'osm:way/7'),
        config,
      ),
    ).toThrow('fire target');
    const circle = road('ring', [
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100],
      [0, 0],
    ]);
    const result = buildEmergencyGraph([circle, building('hospital', 50, 10)], {
      ambulance: config.ambulance,
      source: 'synthetic',
    });
    expect(result.nodes).toHaveLength(2);
    expect(result.edges).toHaveLength(2);
  });
});
