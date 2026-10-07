import { describe, expect, it } from 'vitest';
import type { EmergencyNetwork, EmergencyPoint, EmergencyTarget } from '@atlas/shared';
import { dispatchNetwork } from './emergency-dispatch-network';

const nodes: EmergencyPoint[] = [
  [0, 0],
  [0.001, 0],
  [0.002, 0],
  [0.002, 0.001],
  [0, 0.001],
  [-0.001, 0],
  [-0.001, 0.001],
];
const edge = (from: number, to: number, length: number, oneway: -1 | 0 | 1 = 0) => ({
  from,
  to,
  length,
  oneway,
  bearing: [0, 0] as EmergencyPoint,
  shape: [nodes[from]!, nodes[to]!],
});
const target = (
  id: string,
  kind: EmergencyTarget['kind'],
  edge: number,
  t: number,
): EmergencyTarget => ({
  id,
  kind,
  edge,
  t,
  at: [0, 0],
  side: 1,
  road: `road-${edge}`,
  tangent: [1, 0],
});
const source = (): EmergencyNetwork => ({
  nodes: structuredClone(nodes),
  edges: [
    edge(0, 1, 100),
    edge(1, 2, 100, 1),
    edge(2, 3, 100, 1),
    edge(3, 4, 200, 1),
    edge(4, 0, 100, 1),
    edge(0, 5, 100),
    edge(5, 6, 100),
    edge(0, 1, 1000),
  ],
  targets: [
    target('hospital', 'hospital', 0, 0.75),
    target('fire', 'fire', 2, 0.5),
    target('building', 'building', 3, 0.25),
    target('unused', 'building', 6, 0.5),
  ],
  source: 'synthetic directed source roads',
});

describe('budgeted dispatch geography', () => {
  it('keeps the existing codec origin connected even when it lies on an otherwise unused spur', () => {
    const full = source(),
      order = [6, 0, 1, 2, 3, 4, 5];
    const map = new Map(order.map((v, i) => [v, i]));
    full.nodes = order.map((i) => full.nodes[i]!);
    full.edges = full.edges.map((e) => ({ ...e, from: map.get(e.from)!, to: map.get(e.to)! }));
    const result = dispatchNetwork(full, full.targets.slice(0, 3));
    expect(result.nodes[0]).toEqual(nodes[6]);
    expect(result.edges).toEqual(full.edges.slice(0, 7));
    expect(result.edges.some((e) => e.from === 0 || e.to === 0)).toBe(true);
  });
  it('preserves directed dispatch routes, terminal progress and source geometry while removing unused spurs', () => {
    const full = source(),
      before = structuredClone(full);
    const selected = full.targets.slice(0, 3);
    const result = dispatchNetwork(full, selected);
    expect(result.nodes).toEqual(nodes.slice(0, 5));
    expect(result.edges).toEqual(full.edges.slice(0, 5));
    expect(result.targets).toEqual(selected);
    expect(result.source).toBe(full.source);
    expect(full).toEqual(before);
  });
  it('uses weighted interior terminals instead of adding a needless circuit on a shared two-way edge', () => {
    const full = source();
    full.targets = [target('hospital', 'hospital', 0, 0.75), target('fire', 'fire', 0, 0.5)];
    const result = dispatchNetwork(full, full.targets);
    expect(result.edges).toEqual([full.edges[0]]);
    expect(result.nodes).toEqual(nodes.slice(0, 2));
    expect(result.targets.map((t) => [t.edge, t.t])).toEqual([
      [0, 0.75],
      [0, 0.5],
    ]);
  });
  it('retains a one-way return circuit for ambulances starting beyond a hospital terminal', () => {
    const full = source();
    full.edges[0]!.oneway = 1;
    full.targets = [full.targets[0]!];
    const result = dispatchNetwork(full, full.targets);
    expect(result.edges).toEqual(full.edges.slice(0, 5));
    expect(result.nodes).toEqual(nodes.slice(0, 5));
    expect(result.edges.map((e) => e.oneway)).toEqual([1, 1, 1, 1, 1]);
  });
});
