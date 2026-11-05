import { expect } from 'vitest';
import type { Mover, TileLife } from '../simulate';

/** Steepest heading a road vehicle may hold, as sideways metres per metre travelled. */
const MAX_SLOPE = Math.tan(Math.PI / 12);
/** Nose and motion may differ by this much; it matches the road-avoid test's tolerance. */
const NOSE_TOLERANCE = (3 * Math.PI) / 180;
/** Below this frame travel, m, a direction is only numerical noise. */
const MEASURABLE_M = 0.02;

export type SteeringStep = {
  /** Travel along the road, m, signed by the mover's direction. */
  forward: number;
  /** Travel across the road, m. */
  sideways: number;
};

/**
 * Run one simulation step and check the body moved as a vehicle does: sideways only while
 * travelling, no steeper than its steering allows, and in the direction its nose points.
 * Only meaningful on a straight line, where the road axis is the mover's cursor heading.
 */
export function expectSteered(life: TileLife, m: Mover, step: () => void): SteeringStep {
  const pm = life.perMeter;
  const axis = { hx: m.hx, hy: m.hy };
  const from = { ...life.pose(m) };
  step();
  const to = life.pose(m);
  const dx = (to.x - from.x) / pm,
    dy = (to.y - from.y) / pm;
  const forward = dx * axis.hx + dy * axis.hy,
    sideways = -dx * axis.hy + dy * axis.hx;
  expect(Math.abs(sideways), 'sideways travel per metre of road').toBeLessThanOrEqual(
    MAX_SLOPE * Math.abs(forward) * 1.001 + 1e-6,
  );
  const travel = Math.hypot(dx, dy);
  if (travel > MEASURABLE_M) {
    const hx = from.hx + to.hx,
      hy = from.hy + to.hy;
    const norm = Math.hypot(hx, hy);
    // A reversing body moves opposite to its nose, along the same axis.
    const cos = Math.abs((dx * hx + dy * hy) / (travel * norm));
    expect(Math.acos(Math.min(1, cos)), 'angle between nose and motion').toBeLessThanOrEqual(
      NOSE_TOLERANCE,
    );
  }
  return { forward, sideways };
}
