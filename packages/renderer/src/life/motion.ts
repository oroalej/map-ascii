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

export type MotionLimit = { target: number; cap: number };
