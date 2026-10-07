import { describe, expect, it } from 'vitest';
import {
  decodeEmergency,
  encodeEmergency,
  isEmergencyData,
  type EmergencyNetwork,
} from './emergency-network';
import { CityEmergency } from './schemas';

const network: EmergencyNetwork = {
  nodes: [
    [0, 0],
    [0.002, 0],
  ],
  edges: [
    {
      from: 0,
      to: 1,
      length: 250,
      bearing: [0, 0],
      oneway: 1,
      shape: [
        [0, 0],
        [0.001, 0.0005],
        [0.002, 0],
      ],
    },
  ],
  targets: [
    {
      id: 'hospital',
      kind: 'hospital',
      at: [0.0015, 0.00025],
      edge: 0,
      t: 0.75,
      side: -1,
      road: 'osm:way/1',
      tangent: [1, 0],
    },
  ],
  source: 'synthetic',
};
describe('emergency wire format', () => {
  it('round trips curves, directed edges and interior roadside targets without Zod at runtime', () => {
    const packed = encodeEmergency(network);
    expect(CityEmergency.parse(packed)).toEqual(packed);
    expect(decodeEmergency(packed)).toEqual(network);
  });
  it('rejects versions, truncated integers, bad coordinates and every target reference', () => {
    const packed = encodeEmergency(network);
    for (const bad of [
      { ...packed, version: 2 },
      { ...packed, nodes: 'gA==' },
      { ...packed, edges: '!' },
      { ...packed, origin: [Infinity, 0] },
      { ...packed, geometry: '' },
      ...[1, 4, 5, 6, 8].map((field) => {
        const targets = structuredClone(packed.targets);
        targets[0]![field] = 100001;
        return { ...packed, targets };
      }),
      { ...packed, targets: [packed.targets[0], packed.targets[0]] },
      { ...packed, targets: [[3, ...packed.targets[0]!.slice(1)]] },
    ])
      expect(isEmergencyData(bad)).toBe(false);
    expect(isEmergencyData(null)).toBe(false);
    expect(isEmergencyData({})).toBe(false);
  });
});
