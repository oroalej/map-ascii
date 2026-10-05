import { FILLET } from './config';

export type Pose = { x: number; y: number; hx: number; hy: number };
export type Curve = {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** How far along the route the curve runs before and after its vertex, in tile units. */
  before: number;
  after: number;
  radius: number;
};

/** How far before and after its vertex a fillet runs, in tile units. */
export const filletLength = (lenIn: number, lenOut: number, pm: number): number =>
  Math.min(FILLET.maxM * pm, lenIn / 2, lenOut / 2);

/**
 * A quadratic between the offset incoming/outgoing tangents, in tile units, running `before`
 * along the route before its vertex and `after` beyond it (`filletLength` for a symmetric one).
 * Undefined when the offset tangents meet outside the fillet's own span, which would loop the
 * path backwards.
 */
export function fillet(
  x: number,
  y: number,
  ux: number,
  uy: number,
  wx: number,
  wy: number,
  before: number,
  after: number,
  offsetIn: number,
  offsetOut: number,
  pm: number,
): Curve | undefined {
  const dot = Math.max(-1, Math.min(1, ux * wx + uy * wy));
  const theta = Math.acos(dot),
    degrees = (theta * 180) / Math.PI;
  if (
    degrees < FILLET.minAngle ||
    degrees > FILLET.maxAngle ||
    Math.min(before, after) < FILLET.padM * pm
  )
    return;
  const ax = x - uy * offsetIn,
    ay = y + ux * offsetIn;
  const bx = x - wy * offsetOut,
    by = y + wx * offsetOut;
  const cross = ux * wy - uy * wx;
  const t = ((bx - ax) * wy - (by - ay) * wx) / cross;
  // The control point must lie past the curve's start on the way in and before its end on the
  // way out; otherwise the quadratic overshoots and the heading swings round.
  const beyond = (ax + ux * t - bx) * wx + (ay + uy * t - by) * wy;
  if (t <= -before || beyond >= after) return;
  const x0 = ax - ux * before,
    y0 = ay - uy * before;
  const x1 = ax + ux * t,
    y1 = ay + uy * t;
  const x2 = bx + wx * after,
    y2 = by + wy * after;
  const radius =
    Math.min(Math.hypot(x1 - x0, y1 - y0), Math.hypot(x2 - x1, y2 - y1)) / Math.tan(theta / 2);
  return { x0, y0, x1, y1, x2, y2, before, after, radius };
}

export function curvePose(c: Curve, signedDistance: number, out: Pose): Pose {
  const t = Math.max(0, Math.min(1, (signedDistance + c.before) / (c.before + c.after)));
  const a = 1 - t;
  out.x = a * a * c.x0 + 2 * a * t * c.x1 + t * t * c.x2;
  out.y = a * a * c.y0 + 2 * a * t * c.y1 + t * t * c.y2;
  const dx = a * (c.x1 - c.x0) + t * (c.x2 - c.x1);
  const dy = a * (c.y1 - c.y0) + t * (c.y2 - c.y1);
  const length = Math.hypot(dx, dy);
  out.hx = dx / length;
  out.hy = dy / length;
  return out;
}
