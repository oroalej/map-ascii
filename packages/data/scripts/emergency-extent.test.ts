import { expect, it } from 'vitest';
import type { EmergencyConfig } from '@atlas/shared';
import type { AtlasFeature } from './03-normalize';
import { emergencyNetwork } from './08-emergency';
import { buildEmergencyGraph } from './lib/emergency-graph';
import { bboxPolygon, createTerritory, geometryOutsideVoid, inTerritory } from './lib/territory';

const scale = 1 / 111320;
const point = (x: number, y: number) => [x * scale, y * scale];
const road = (id: string, vertices: number[][]): AtlasFeature => ({
  type: 'Feature',
  geometry: { type: 'LineString', coordinates: vertices.map(([x, y]) => point(x!, y!)) },
  properties: { id, class: 'road_mid' },
  tippecanoe: { layer: 'roads', minzoom: 6, maxzoom: 16 },
});
const hospital = (id: string, x: number, y: number): AtlasFeature => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: point(x, y) },
  properties: { id, class: 'building_hospital' },
  tippecanoe: { layer: 'buildings', minzoom: 13, maxzoom: 16 },
});
const config: EmergencyConfig = {
  ambulance: { max: 1, interval_s: [10, 20], dwell_s: [2, 3] },
  source: 'synthetic',
};
const features = [
  road('visible-road', [
    [0, 0],
    [100, 0],
    [100, 100],
    [0, 100],
    [0, 0],
  ]),
  hospital('visible-hospital', 50, 10),
  road('void-road', [
    [300, 300],
    [400, 300],
    [450, 350],
    [400, 400],
    [300, 400],
    [250, 350],
    [300, 300],
  ]),
  hospital('void-hospital', 350, 310),
];
const bounds: [number, number, number, number] = [0, 0, 500 * scale, 500 * scale];
const boundary = bboxPolygon([0, 0, 200 * scale, 200 * scale]);

it('keeps emergency routes on retained geography even when the void has the larger component', () => {
  const territory = createTerritory(bounds, boundary, [0, 0, 100 * scale, 100 * scale]);
  const source = structuredClone(features);
  expect(buildEmergencyGraph(features, config).targets.some((t) => t.id === 'void-hospital')).toBe(
    true,
  );
  const network = emergencyNetwork(features, config, territory);
  expect(network.targets.map((t) => t.id)).toEqual(['visible-hospital']);
  expect(network.nodes.every(([lng, lat]) => inTerritory(lng, lat, territory))).toBe(true);
  expect(network.targets.every((t) => t.road === 'visible-road')).toBe(true);
  expect(
    network.edges.every((e) =>
      geometryOutsideVoid({ type: 'LineString', coordinates: e.shape }, territory),
    ),
  ).toBe(true);
  expect(features).toEqual(source);
});

it('preserves the existing emergency graph for flagless packs', () => {
  expect(emergencyNetwork(features, config, createTerritory(bounds, boundary))).toEqual(
    buildEmergencyGraph(features, config),
  );
});
