import { LANE, kinematicsOf } from './config';

/**
 * How road vehicles move across a road: the heading changes with distance driven, and sideways
 * motion is what that heading produces. A stopped vehicle has nothing to steer with, so a lane
 * change holds its pose until it rolls again. All lengths are metres along the road, and a slope
 * is sideways metres per metre of road (the tangent of the heading against the road).
 */
export type SteerLimits = {
  /** Largest change of slope per metre of road. */
  curvature: number;
  /** Steepest slope to hold. */
  maxSlope: number;
};

/** The steepest heading a vehicle may hold; `roadEnvelope` in simulate.ts assumes this bound. */
export const MAX_STEER_SLOPE = Math.tan(Math.PI / 12);

const SPEED_FLOOR = 1e-3;

/** Limits at `speed` m/s: gentle at speed, down to the vehicle's turning circle at a crawl. */
export function steerLimits(vehicle: string | undefined, speed: number): SteerLimits {
  const { turnRadius, sway = 1 } = kinematicsOf(vehicle);
  const v = Math.max(SPEED_FLOOR, Math.abs(speed));
  return {
    curvature: Math.min((LANE.comfort * sway) / (v * v), 1 / turnRadius),
    maxSlope: Math.min(MAX_STEER_SLOPE, LANE.lateral / v),
  };
}

/**
 * The slope to end this step on, `dx` metres on, still able to straighten exactly at the target.
 * Landing on s² = 2κr leaves a constant-curvature arc that ends with both at zero; this solves
 * for that slope given that the step itself covers `dx` at the mean of the two slopes.
 */
function nextSlope(slope: number, remaining: number, dx: number, limits: SteerLimits): number {
  const { curvature: k, maxSlope } = limits;
  const change = k * dx;
  const reach = change * change + 4 * (2 * k * remaining - change * slope);
  const brakeable = reach > 0 ? (Math.sqrt(reach) - change) / 2 : -Infinity;
  const wanted = Math.min(brakeable, maxSlope);
  return Math.max(slope - change, Math.min(slope + change, wanted));
}

/**
 * Steer `dx` metres along the road toward `remaining` metres of sideways offset. Returns the new
 * slope and the sideways metres that travel produced. `dx` of 0 changes nothing.
 */
export function steerStep(
  slope: number,
  remaining: number,
  dx: number,
  limits: SteerLimits,
): { slope: number; sideways: number } {
  if (dx <= 0) return { slope, sideways: 0 };
  // Solve with the remaining offset ahead of the vehicle, on the positive side.
  const sign = remaining === 0 ? Math.sign(slope) || 1 : Math.sign(remaining);
  const s = slope * sign,
    r = remaining * sign;
  const next = nextSlope(s, r, dx, limits);
  if (next <= 0 && s >= 0) {
    // The arc finishes inside this step: arrive and straighten together.
    const arrives = Math.min(r, (dx * Math.max(s, 0)) / 2);
    if (r <= (dx * s) / 2 + 1e-12) return { slope: 0, sideways: remaining };
    return { slope: 0, sideways: arrives * sign };
  }
  return { slope: next * sign, sideways: ((dx * (s + next)) / 2) * sign };
}

/** Straighten over `dx` metres, moving only as far as the remaining heading carries it. */
export function steerStraight(
  slope: number,
  dx: number,
  limits: SteerLimits,
): { slope: number; sideways: number } {
  if (dx <= 0 || slope === 0) return { slope, sideways: 0 };
  const change = limits.curvature * dx,
    size = Math.abs(slope);
  if (change >= size) {
    return { slope: 0, sideways: (Math.sign(slope) * size * size) / (2 * limits.curvature) };
  }
  const next = size - change;
  return {
    slope: Math.sign(slope) * next,
    sideways: (Math.sign(slope) * dx * (size + next)) / 2,
  };
}

/** Metres of road to move `delta` metres sideways and end straight, starting from `slope`. */
export function steerLength(delta: number, slope: number, limits: SteerLimits): number {
  if (delta === 0 && slope === 0) return 0;
  const { curvature: k, maxSlope } = limits;
  const sign = delta === 0 ? Math.sign(slope) : Math.sign(delta);
  const s = slope * sign,
    r = delta * sign;
  // Straightening from a slope already covers s²/2κ; a heading the wrong way adds its own detour.
  const stopping = (s * s) / (2 * k);
  if (s < 0) return -s / k + steerLength(r + stopping, 0, limits);
  if (stopping >= r) return s / k + steerLength(stopping - r, 0, limits);
  // Peak of the triangle profile, or a held slope if that peak would be too steep.
  const peak = Math.sqrt(k * r + (s * s) / 2);
  if (peak <= maxSlope) return (2 * peak - s) / k;
  const start = Math.min(s, maxSlope);
  const ramps = (maxSlope - start) / k + maxSlope / k;
  const covered = (maxSlope * maxSlope - start * start) / (2 * k) + (maxSlope * maxSlope) / (2 * k);
  return ramps + (r - covered) / maxSlope;
}
