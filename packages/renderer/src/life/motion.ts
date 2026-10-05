import type { Kinematics } from './config';

/** Target acceleration is bounded; safety caps can require emergency braking. */
export function nextSpeed(
  v: number,
  target: number,
  cap: number,
  k: Kinematics,
  pm: number,
  dt: number,
): number {
  const next =
    target >= v
      ? Math.min(target, v + k.accel * pm * dt)
      : Math.max(target, v - k.maxBrake * pm * dt);
  return Math.max(0, Math.min(next, cap));
}

/** Speed from which comfortable braking reaches `lead` within `gap`, in tile units. */
export const approach = (gap: number, lead: number, brake: number): number =>
  // Sub-nanounit cursor residue is a reached stop, not a request to accelerate forever.
  Math.sqrt(lead * lead + 2 * brake * (gap > 1e-9 ? gap : 0));

/** Stopping reach including clearance and optional integration/selection allowance.
 * All distances, speed and braking must use the same metric or tile frame. */
export const stoppingReach = (
  velocity: number,
  brake: number,
  clearance: number,
  allowance = 0,
): number => (velocity * velocity) / (2 * brake) + clearance + allowance;

/** Approach a stop while retaining its lead speed and caller-specific integration allowance. */
export const stopBefore = (
  distance: number,
  lead: number,
  brake: number,
  clearance = 0,
  allowance = 0,
): number => approach(Math.max(0, distance - clearance - allowance), lead, brake);

export type MotionLimit = { target: number; cap: number };
