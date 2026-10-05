import { FILLET } from './config';

export type Pose = { x: number; y: number; hx: number; hy: number };
export type Curve = {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  length: number;
  radius: number;
};

/** A quadratic between the offset incoming/outgoing tangents, in tile units. */
export function fillet(
  x: number,
  y: number,
  ux: number,
  uy: number,
  wx: number,
  wy: number,
  lenIn: number,
  lenOut: number,
  offsetIn: number,
  offsetOut: number,
  pm: number,
  maximumM: number = FILLET.maxM,
): Curve | undefined {
  const dot = Math.max(-1, Math.min(1, ux * wx + uy * wy));
  const theta = Math.acos(dot),
    degrees = (theta * 180) / Math.PI;
  const length = Math.min(maximumM * pm, lenIn / 2, lenOut / 2);
  if (
    degrees < FILLET.minAngle ||
    degrees > FILLET.maxAngle ||
    length <
      Math.max(Math.abs(offsetIn), Math.abs(offsetOut)) * Math.tan(theta / 2) + FILLET.padM * pm
  )
    return;
  const ax = x - uy * offsetIn,
    ay = y + ux * offsetIn;
  const bx = x - wy * offsetOut,
    by = y + wx * offsetOut;
  const cross = ux * wy - uy * wx;
  const t = ((bx - ax) * wy - (by - ay) * wx) / cross;
  const x0 = ax - ux * length,
    y0 = ay - uy * length;
  const x1 = ax + ux * t,
    y1 = ay + uy * t;
  const x2 = bx + wx * length,
    y2 = by + wy * length;
  const radius =
    Math.min(Math.hypot(x1 - x0, y1 - y0), Math.hypot(x2 - x1, y2 - y1)) / Math.tan(theta / 2);
  return { x0, y0, x1, y1, x2, y2, length, radius };
}

export function curvePose(c: Curve, signedDistance: number, out: Pose): Pose {
  const t = Math.max(0, Math.min(1, (signedDistance + c.length) / (2 * c.length)));
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
