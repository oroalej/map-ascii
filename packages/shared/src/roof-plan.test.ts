import { expect, it } from 'vitest';
import { isRoofPlan, parseRoofPlan, roofFrame, type RoofPlan } from './roof-plan';
import { RoofPlanSchema } from './roof-plan-schema';

const plan: RoofPlan = {
  version: 1,
  origin: [123, 13],
  nodes: [
    { type: 'split', at: [0, 0], angleDeg: 90, negative: 1, positive: 2 },
    { type: 'roof', center: [-5, 0], angleDeg: 0, halfLengthM: 5, halfWidthM: 3 },
    { type: 'roof', center: [5, 0], angleDeg: 90, halfLengthM: 5, halfWidthM: 3 },
  ],
};
it('round trips the same bounded tree through schema and worker validation', () => {
  expect(RoofPlanSchema.parse(plan)).toEqual(plan);
  expect(parseRoofPlan(JSON.stringify(plan))).toEqual(plan);
});
it('rejects malformed, cyclic, shared, unreachable, nonfinite and oversized trees', () => {
  for (const value of [
    null,
    {},
    { ...plan, version: 2 },
    { ...plan, origin: [0, 90] },
    { ...plan, nodes: [{ ...plan.nodes[0], negative: 0 }, ...plan.nodes.slice(1)] },
    { ...plan, nodes: [{ ...plan.nodes[0], positive: 1 }, ...plan.nodes.slice(1)] },
    { ...plan, nodes: [...plan.nodes, plan.nodes[1]] },
    { ...plan, nodes: [plan.nodes[0], { ...plan.nodes[1], halfLengthM: Infinity }, plan.nodes[2]] },
    { ...plan, nodes: Array(9).fill(plan.nodes[1]) },
  ]) {
    expect(isRoofPlan(value)).toBe(false);
    expect(RoofPlanSchema.safeParse(value).success).toBe(false);
  }
  expect(parseRoofPlan('{')).toBeUndefined();
  expect(parseRoofPlan(' '.repeat(4097))).toBeUndefined();
});
it('uses one invertible meter frame independently of tile latitude', () => {
  const frame = roofFrame([123, 13]);
  const p = [123.001, 13.002];
  const local = frame.toLocal(p);
  expect(local[0]).toBeGreaterThan(0);
  expect(local[1]).toBeLessThan(0);
  const back = frame.toLngLat(local);
  expect(back[0]).toBeCloseTo(p[0]!, 9);
  expect(back[1]).toBeCloseTo(p[1]!, 9);
  expect(frame.metersPerTileUnit(15)).toBeCloseTo(frame.metersPerTileUnit(16) * 2, 9);
});
