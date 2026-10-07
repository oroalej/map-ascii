import { encodeEmergency } from '@atlas/shared';
export const emergencyFixture = encodeEmergency({
  nodes: [
    [0, 0],
    [0.001, 0],
  ],
  edges: [
    {
      from: 0,
      to: 1,
      length: 111,
      bearing: [0, 0],
      oneway: 0,
      shape: [
        [0, 0],
        [0.001, 0],
      ],
    },
  ],
  targets: [
    {
      id: 'hospital',
      kind: 'hospital',
      at: [0.0005, 0],
      edge: 0,
      t: 0.5,
      side: 1,
      road: 'osm:way/1',
      tangent: [1, 0],
    },
  ],
  source: 'Synthetic fixture',
});
