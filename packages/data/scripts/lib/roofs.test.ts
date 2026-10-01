import { expect, it } from 'vitest';
import { roofPlan } from './roofs';
import { isRoofPlan, type RoofPoint } from '@atlas/shared';

const l: RoofPoint[] = [
  [0, 0],
  [10, 0],
  [10, 4],
  [4, 4],
  [4, 10],
  [0, 10],
  [0, 0],
];
it('splits equal-arm L, T and cross footprints into bounded rectangular leaves', () => {
  for (const ring of [
    l,
    [
      [0, 0],
      [12, 0],
      [12, 4],
      [8, 4],
      [8, 12],
      [4, 12],
      [4, 4],
      [0, 4],
      [0, 0],
    ],
    [
      [4, 0],
      [8, 0],
      [8, 4],
      [12, 4],
      [12, 8],
      [8, 8],
      [8, 12],
      [4, 12],
      [4, 8],
      [0, 8],
      [0, 4],
      [4, 4],
      [4, 0],
    ],
  ] as RoofPoint[][]) {
    const plan = roofPlan(ring)!;
    expect(isRoofPlan(plan)).toBe(true);
    const leaves = plan.nodes.filter((n) => n.type === 'roof');
    expect(leaves.length).toBeGreaterThanOrEqual(2);
    expect(leaves.length).toBeLessThanOrEqual(4);
    const area =
      Math.abs(ring.slice(1).reduce((a, p, i) => a + ring[i]![0] * p[1] - ring[i]![1] * p[0], 0)) /
      2;
    expect(leaves.reduce((a, n) => a + n.halfLengthM * n.halfWidthM * 4, 0)).toBeCloseTo(area, 1);
  }
  expect(roofPlan(l)!.nodes.filter((n) => n.type === 'roof')).toHaveLength(2);
});
it('is stable under winding, cyclic vertex order, and a twenty-degree rotation', () => {
  const base = roofPlan(l)!;
  expect(roofPlan([...l].reverse())).toEqual(base);
  const open = l.slice(0, -1),
    shifted = [...open.slice(2), ...open.slice(0, 2)];
  expect(roofPlan([...shifted, shifted[0]!])).toEqual(base);
  const theta = (20 * Math.PI) / 180;
  const rotated = l.map(([x, y]): RoofPoint => [
    x * Math.cos(theta) - y * Math.sin(theta),
    x * Math.sin(theta) + y * Math.cos(theta),
  ]);
  expect(
    roofPlan(rotated)!
      .nodes.filter((n) => n.type === 'roof')
      .map((n) => [n.halfLengthM, n.halfWidthM])
      .sort(),
  ).toEqual(
    base.nodes
      .filter((n) => n.type === 'roof')
      .map((n) => [n.halfLengthM, n.halfWidthM])
      .sort(),
  );
});
it('rejects rectangles, near-rectangles, narrow wings and degenerate input', () => {
  for (const ring of [
    [],
    [
      [0, 0],
      [0, 0],
    ],
    [
      [0, 0],
      [10, 0],
      [10, 5],
      [0, 5],
      [0, 0],
    ],
    [
      [0, 0],
      [10, 0],
      [10, 5],
      [0.1, 5],
      [0, 4.9],
      [0, 0],
    ],
    l.map(([x, y]) => [x / 3, y / 3]),
  ] as RoofPoint[][])
    expect(roofPlan(ring)).toBeUndefined();
});
