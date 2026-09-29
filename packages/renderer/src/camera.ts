/**
 * Map camera math. Zoom follows the 512-px tile convention of `@math.gl/web-mercator` (and
 * MapLibre): at zoom z the world is `512 · 2^z` pixels wide. Screen offsets are CSS pixels.
 */
import type { BBox, CameraState } from '@atlas/shared';
import { lngLatToWorld, worldToLngLat } from '@math.gl/web-mercator';

export const TILE_SIZE = 512;
const MAX_LAT = 85.051129;

export type Size = { width: number; height: number };

export type CameraLimits = {
  /** [west, south, east, north]; the camera center stays inside. */
  bounds: BBox;
  minZoom: number;
  maxZoom: number;
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** World pixel position at `zoom`, with the origin at the north-west corner and y down. */
export function project(lng: number, lat: number, zoom: number): [number, number] {
  const [x, y] = lngLatToWorld([lng, clamp(lat, -MAX_LAT, MAX_LAT)]);
  const scale = 2 ** zoom;
  return [x * scale, (TILE_SIZE - y) * scale];
}

/** Inverse of `project`: [lng, lat]. */
export function unproject(x: number, y: number, zoom: number): [number, number] {
  const scale = 2 ** zoom;
  const [lng, lat] = worldToLngLat([x / scale, TILE_SIZE - y / scale]);
  return [lng, lat];
}

/** Move the map content by (dx, dy) screen pixels, as a drag does. */
export function panBy(camera: CameraState, dx: number, dy: number): CameraState {
  const [x, y] = project(camera.lng, camera.lat, camera.zoom);
  const [lng, lat] = unproject(x - dx, y - dy, camera.zoom);
  return { ...camera, lng, lat };
}

/**
 * Change zoom while keeping the ground point at `anchor` fixed on screen. `anchor` is the
 * offset from the viewport center in screen pixels (e.g. the cursor).
 */
export function zoomAround(
  camera: CameraState,
  zoom: number,
  anchor: readonly [number, number],
): CameraState {
  const [x, y] = project(camera.lng, camera.lat, camera.zoom);
  const scale = 2 ** (zoom - camera.zoom);
  const [ax, ay] = anchor;
  const [lng, lat] = unproject((x + ax) * scale - ax, (y + ay) * scale - ay, zoom);
  return { ...camera, lng, lat, zoom };
}

/** Clamp zoom to the limits and the center to the bounds. */
export function clampCamera(camera: CameraState, limits: CameraLimits): CameraState {
  const [west, south, east, north] = limits.bounds;
  return {
    ...camera,
    zoom: clamp(camera.zoom, limits.minZoom, limits.maxZoom),
    lng: clamp(camera.lng, west, east),
    lat: clamp(camera.lat, south, north),
  };
}

/** Zoom-anchored variant that also clamps, for input handlers. */
export function zoomAroundClamped(
  camera: CameraState,
  zoom: number,
  anchor: readonly [number, number],
  limits: CameraLimits,
): CameraState {
  const target = clamp(zoom, limits.minZoom, limits.maxZoom);
  return clampCamera(zoomAround(camera, target, anchor), limits);
}
