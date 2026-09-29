/**
 * Map camera math. Zoom follows the 512-px tile convention of `@math.gl/web-mercator` (and
 * MapLibre): at zoom z the world is `512 · 2^z` pixels wide. Screen offsets are CSS pixels.
 */
import type { BBox, CameraState } from '@atlas/shared';
import { lngLatToWorld, WebMercatorViewport, worldToLngLat } from '@math.gl/web-mercator';

export const TILE_SIZE = 512;

/** Zoom range (SPEC.md §2): the Region level out to the Place level's closest view. */
export const MIN_ZOOM = 7;
export const MAX_ZOOM = 21;
const MAX_LAT = 85.051129;

/** Orbit limits (SPEC.md §3): pitch 0–60°, bearing in (-180, 180]. */
export const MAX_PITCH = 60;

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

/** Bearing wrapped into (-180, 180]. */
export const wrapBearing = (bearing: number) => {
  const b = ((((bearing + 180) % 360) + 360) % 360) - 180;
  return b === -180 ? 180 : b;
};

/** Clamp zoom to the limits, the center to the bounds, and the pitch to 0–60°. */
export function clampCamera(camera: CameraState, limits: CameraLimits): CameraState {
  const [west, south, east, north] = limits.bounds;
  return {
    ...camera,
    zoom: clamp(camera.zoom, limits.minZoom, limits.maxZoom),
    lng: clamp(camera.lng, west, east),
    lat: clamp(camera.lat, south, north),
    pitch: clamp(camera.pitch, 0, MAX_PITCH),
    bearing: wrapBearing(camera.bearing),
  };
}

/** Whether the camera is tilted or rotated (the perspective path) rather than flat north-up. */
export const isTilted = (camera: CameraState) =>
  Math.abs(camera.pitch) > 0.01 || Math.abs(camera.bearing) > 0.01;

/** The `@math.gl/web-mercator` viewport for a camera and a CSS-pixel view size. */
export const viewportFor = (camera: CameraState, size: Size) =>
  new WebMercatorViewport({
    width: Math.max(1, size.width),
    height: Math.max(1, size.height),
    longitude: camera.lng,
    latitude: camera.lat,
    zoom: camera.zoom,
    pitch: camera.pitch,
    bearing: camera.bearing,
  });

/**
 * Pan by (dx, dy) screen pixels in any camera: the ground point under the screen center moves
 * with the pointer. Flat north-up cameras use the exact mercator math of `panBy`.
 */
export function panByView(camera: CameraState, dx: number, dy: number, size: Size): CameraState {
  if (!isTilted(camera)) return panBy(camera, dx, dy);
  const view = viewportFor(camera, size);
  const [lng, lat] = view.unproject([size.width / 2 - dx, size.height / 2 - dy]);
  return { ...camera, lng: lng!, lat: lat! };
}

/** Rotate and tilt, as a right-drag does: degrees of bearing and pitch. */
export const orbitBy = (camera: CameraState, dBearing: number, dPitch: number): CameraState => ({
  ...camera,
  bearing: wrapBearing(camera.bearing + dBearing),
  pitch: clamp(camera.pitch + dPitch, 0, MAX_PITCH),
});

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

/** Column-major 4×4 matrix product `a · b` (in float64). */
export function multiply(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  const out = new Array<number>(16).fill(0);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row]! * b[col * 4 + k]!;
      out[col * 4 + row] = sum;
    }
  }
  return out;
}
