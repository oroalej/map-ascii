import { expect, it } from 'vitest';
import { decodeEmergency, encodeEmergency, type EmergencyConfig } from '@atlas/shared';
import type { Polygon } from 'geojson';
import type { AtlasFeature } from './03-normalize';
import { emergencyNetwork } from './08-emergency';
import { buildEmergencyGraph } from './lib/emergency-graph';
import { encodeEmergencyInTerritory } from './lib/emergency-territory';
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
  const t = createTerritory(bounds, boundary);
  expect(emergencyNetwork(features, config, t)).toEqual(buildEmergencyGraph(features, config));
  expect(encodeEmergencyInTerritory(buildEmergencyGraph(features, config), t)).toEqual(
    encodeEmergency(buildEmergencyGraph(features, config)),
  );
});

it('preserves a concave admitted bend through simplification and encoding', () => {
  const boundary: Polygon = {
    type: 'Polygon',
    coordinates: [
      [
        [0, -10],
        [45, -10],
        [50, 0.25],
        [55, -10],
        [100, -10],
        [100, 10],
        [0, 10],
        [0, -10],
      ].map(([x, y]) => point(x!, y!)),
    ],
  };
  const t = createTerritory([0, -10 * scale, 100 * scale, 10 * scale], boundary, [
    0,
    -10 * scale,
    10 * scale,
    -9 * scale,
  ]);
  const street = road('bend', [
    [0, 0],
    [50, 0.3],
    [100, 0],
  ]);
  const input = [street, hospital('hospital', 10, 1)];
  expect(geometryOutsideVoid(street.geometry, t)).toBe(true);
  expect(
    buildEmergencyGraph(input, config).edges.some(
      (e) => !geometryOutsideVoid({ type: 'LineString', coordinates: e.shape }, t),
    ),
  ).toBe(true);
  const network = emergencyNetwork(input, config, t);
  expect(network.edges.some((e) => e.shape.length === 3)).toBe(true);
  const decoded = decodeEmergency(encodeEmergencyInTerritory(network, t));
  expect(
    decoded.edges.every((e) =>
      geometryOutsideVoid({ type: 'LineString', coordinates: e.shape }, t),
    ),
  ).toBe(true);
  expect(decoded.nodes.every((p) => inTerritory(...p, t))).toBe(true);
  expect(decoded.targets.map((t) => t.id)).toEqual(network.targets.map((t) => t.id));
});

it('keeps cut roads and straddling stations admitted after codec rounding', () => {
  const boundary: Polygon = {
    type: 'Polygon',
    coordinates: [
      [
        [0, 0],
        [0.001, 0.0005],
        [0, 0.001],
        [0, 0],
      ],
    ],
  };
  const t = createTerritory([0, 0, 0.001, 0.001], boundary, [0, 0, 0.0001, 0.0001]);
  const input: AtlasFeature[] = [
    {
      ...road('cut', []),
      geometry: {
        type: 'LineString',
        coordinates: [
          [0.00045, 0.0004],
          [0.00045, 0.0002],
        ],
      },
    },
    {
      ...road('inner', []),
      geometry: {
        type: 'LineString',
        coordinates: [
          [0.00045, 0.0004],
          [0.00035, 0.000251],
        ],
      },
    },
    {
      ...hospital('hospital', 0, 0),
      geometry: { type: 'Point', coordinates: [0.00045, 0.000399] },
    },
    {
      type: 'Feature',
      geometry: bboxPolygon([0.00039, 0.00018, 0.00051, 0.00031]),
      properties: { id: 'police', class: 'parking', kind: 'amenity=police' },
      tippecanoe: { layer: 'labels', minzoom: 13, maxzoom: 16 },
    },
  ];
  const before = structuredClone(input);
  const network = emergencyNetwork(input, config, t);
  expect(network.targets.some((t) => t.id === 'police')).toBe(true);
  expect(
    network.edges.every((e) =>
      geometryOutsideVoid({ type: 'LineString', coordinates: e.shape }, t),
    ),
  ).toBe(true);
  expect(decodeEmergency(encodeEmergency(network)).nodes.some((p) => !inTerritory(...p, t))).toBe(
    true,
  );
  const decoded = decodeEmergency(encodeEmergencyInTerritory(network, t));
  expect(decoded.nodes.every((p) => inTerritory(...p, t))).toBe(true);
  expect(
    decoded.edges.every((e) =>
      geometryOutsideVoid({ type: 'LineString', coordinates: e.shape }, t),
    ),
  ).toBe(true);
  expect(decoded.targets.every((target) => inTerritory(...target.at, t))).toBe(true);
  expect(decoded.edges.map(({ from, to, oneway }) => [from, to, oneway])).toEqual(
    network.edges.map(({ from, to, oneway }) => [from, to, oneway]),
  );
  expect(input).toEqual(before);
  const unused: AtlasFeature = { ...input[3]!, properties: { id: 'unused', class: 'park' } };
  expect(emergencyNetwork([...input, unused], config, t)).toEqual(network);
  expect(() =>
    encodeEmergencyInTerritory(
      { ...network, targets: [{ ...network.targets[0]!, at: [0.0009, 0.0001] }] },
      t,
    ),
  ).toThrow('target');
});
