import {
  encodeEmergency,
  localMetricProjection,
  type EmergencyConfig,
  type EmergencyNetwork,
  type EmergencyTarget,
} from '@atlas/shared';

export const emergencyConfig: EmergencyConfig = {
  ambulance: { max: 1, interval_s: [1, 1], dwell_s: [1, 1] },
  police: { max: 2, interval_s: [1, 1], call_every_s: [2, 2], call_s: [1, 1] },
  fire: { max: 1, interval_s: [1, 1], dwell_s: [1, 1] },
  source: 'Synthetic illustrative fixture',
};
export function emergencyFixture(origin: readonly [number, number] = [0, 0]) {
  const projection = localMetricProjection(origin);
  const point = (x: number, y = 0) => projection.from([x, -y]);
  const nodes = [point(0), point(100), point(200), point(100, 100)];
  const target = (
    id: string,
    kind: EmergencyTarget['kind'],
    edge: number,
    t: number,
    x: number,
    y = 0,
  ): EmergencyTarget => ({
    id,
    kind,
    edge,
    t,
    at: point(x, y),
    side: 1,
    road: `road/${edge}`,
    tangent: edge === 2 ? [0, -1] : [1, 0],
  });
  const network: EmergencyNetwork = {
    nodes,
    edges: [
      { from: 0, to: 1, length: 100, bearing: [0, 0], oneway: 0, shape: [nodes[0]!, nodes[1]!] },
      { from: 1, to: 2, length: 100, bearing: [0, 0], oneway: 1, shape: [nodes[1]!, nodes[2]!] },
      {
        from: 1,
        to: 3,
        length: 100,
        bearing: [Math.PI / 2, Math.PI / 2],
        oneway: 0,
        shape: [nodes[1]!, nodes[3]!],
      },
      {
        from: 2,
        to: 0,
        length: 200,
        bearing: [Math.PI, Math.PI],
        oneway: 1,
        shape: [nodes[2]!, nodes[0]!],
      },
    ],
    targets: [
      target('hospital/a', 'hospital', 1, 0.2, 120),
      target('hospital/b', 'hospital', 2, 0.8, 100, 80),
      target('police', 'police', 0, 0.2, 20),
      target('fire', 'fire', 0, 0.3, 30),
      target('building', 'building', 2, 0.5, 100, 50),
    ],
    source: 'Synthetic fixture',
  };
  return { point, network, data: encodeEmergency(network) };
}
