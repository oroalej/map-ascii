/** Flights (SPEC.md §3 "Fly-to"): the camera animating along a zoom-and-pan path. */
import type { CameraState } from '@atlas/shared';
import {
  clampCamera,
  easeInOut,
  flyPath,
  type CameraLimits,
  type FlyPath,
  type Size,
} from './camera';

export type Flight = { path: FlyPath; start: number };

export function startFlight(
  from: CameraState,
  target: Partial<CameraState>,
  limits: CameraLimits,
  size: Size,
  opts: { reducedMotion: boolean; duration?: number; now: number },
): Flight {
  const to = clampCamera({ ...from, ...target }, limits, size);
  const path = flyPath(from, to, size, {
    reducedMotion: opts.reducedMotion,
    duration: opts.duration,
  });
  return { path, start: opts.now };
}

/** The flight's camera at `now`, and whether it has arrived. */
export function stepFlight(
  flight: Flight,
  now: number,
  limits: CameraLimits,
  size: Size,
): { camera: CameraState; done: boolean } {
  const t = Math.min(1, (now - flight.start) / Math.max(1, flight.path.duration));
  // Only the zoom is clamped mid-flight; the arc may pass over the edge of the region.
  const camera = clampCamera(flight.path.at(easeInOut(t)), limits);
  if (t < 1) return { camera, done: false };
  return { camera: clampCamera(camera, limits, size), done: true };
}
