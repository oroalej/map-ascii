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

/**
 * Clamp zoom to the limits and the view to the bounds. Given the view `size`, the bounds stay
 * under the whole screen where they can (the edges of the view stay inside; a view larger than
 * the bounds centers on them), so the visitor can't drift off into empty space. Without a size,
 * only the center is kept inside.
 */
export function clampCamera(camera: CameraState, limits: CameraLimits, size?: Size): CameraState {
  const [west, south, east, north] = limits.bounds;
  const clamped = {
    ...camera,
    zoom: clamp(camera.zoom, limits.minZoom, limits.maxZoom),
    lng: clamp(camera.lng, west, east),
    lat: clamp(camera.lat, south, north),
  };
  if (!size) return clamped;
  const { zoom } = clamped;
  const [x0, y0] = project(west, north, zoom);
  const [x1, y1] = project(east, south, zoom);
  const [x, y] = project(camera.lng, camera.lat, zoom);
  const within = (v: number, lo: number, hi: number, half: number) =>
    hi - lo <= 2 * half ? (lo + hi) / 2 : clamp(v, lo + half, hi - half);
  const cx = within(x, x0, x1, size.width / 2);
  const cy = within(y, y0, y1, size.height / 2);
  // Unchanged: keep the exact coordinates (a round trip through pixels would perturb them).
  if (cx === x && cy === y) return { ...clamped, lng: camera.lng, lat: camera.lat };
  const [lng, lat] = unproject(cx, cy, zoom);
  return { ...clamped, lng, lat };
}

/**
 * The zoom at which the bounds just cover the view (SPEC.md §3: zooming out stops there, so the
 * region fills the screen at the widest and nothing outside it shows).
 */
export function fitZoom([west, south, east, north]: BBox, size: Size): number {
  const [x0, y0] = project(west, north, 0);
  const [x1, y1] = project(east, south, 0);
  const zx = Math.log2(Math.max(1, size.width) / Math.max(1e-9, x1 - x0));
  const zy = Math.log2(Math.max(1, size.height) / Math.max(1e-9, y1 - y0));
  return Math.max(zx, zy);
}

/** Fly-to duration limits in ms (SPEC.md §3), and the cap with reduced motion. */
export const FLY_MIN_MS = 800;
export const FLY_MAX_MS = 3000;
export const FLY_REDUCED_MS = 300;

/** Curvature of the fly-to arc: how far it zooms out to travel (van Wijk & Nuij's ρ). */
const RHO = 1.42;
/** Path length (in the arc's own units) flown per second before clamping. */
const FLY_SPEED = 1.2;

export type FlyPath = {
  /** Milliseconds, already clamped. */
  duration: number;
  /** The camera at progress `t` (0–1, eased by the caller). */
  at: (t: number) => CameraState;
};

/**
 * An eased flight between two cameras (SPEC.md §3 "Fly-to"): zoom out, travel, zoom in, along
 * van Wijk & Nuij's optimal path ("Smooth and efficient zooming and panning", 2003), the same
 * one MapLibre's `flyTo` uses. The screen speed feels constant, whatever the zooms.
 */
export function flyPath(
  from: CameraState,
  to: CameraState,
  size: Size,
  opts: { reducedMotion?: boolean; duration?: number } = {},
): FlyPath {
  const z0 = from.zoom;
  const scale = 2 ** (to.zoom - z0);
  const [ax, ay] = project(from.lng, from.lat, z0);
  const [bx, by] = project(to.lng, to.lat, z0);
  const w0 = Math.max(size.width, size.height, 1);
  const w1 = w0 / scale;
  const u1 = Math.hypot(bx - ax, by - ay);
  const rho2 = RHO * RHO;

  let length: number;
  let width: (s: number) => number;
  let along: (s: number) => number;
  if (u1 < 1e-6) {
    // No travel: a pure zoom.
    const k = w1 < w0 ? -1 : 1;
    length = Math.abs(Math.log(w1 / w0)) / RHO;
    width = (s) => Math.exp(k * RHO * s);
    along = () => 0;
  } else {
    const b = (i: 0 | 1) =>
      (w1 * w1 - w0 * w0 + (i ? -1 : 1) * rho2 * rho2 * u1 * u1) / (2 * (i ? w1 : w0) * rho2 * u1);
    const r = (i: 0 | 1) => Math.log(Math.sqrt(b(i) * b(i) + 1) - b(i));
    const r0 = r(0);
    length = (r(1) - r0) / RHO;
    width = (s) => Math.cosh(r0) / Math.cosh(r0 + RHO * s);
    along = (s) => (w0 * ((Math.cosh(r0) * Math.tanh(r0 + RHO * s) - Math.sinh(r0)) / rho2)) / u1;
  }
  const ideal = Number.isFinite(length) ? (length / FLY_SPEED) * 1000 : 0;
  // An explicit duration (e.g. a tour's slow establishing flight) replaces the clamped one;
  // reduced motion still keeps every flight short.
  const wanted = opts.duration ?? clamp(ideal, FLY_MIN_MS, FLY_MAX_MS);
  const duration = opts.reducedMotion
    ? Math.min(FLY_REDUCED_MS, clamp(ideal, 0, FLY_MAX_MS))
    : Math.max(0, wanted);

  return {
    duration,
    at(t) {
      if (t <= 0) return { ...from };
      if (t >= 1) return { ...to };
      const s = t * (Number.isFinite(length) ? length : 0);
      const k = Math.min(1, Math.max(0, along(s)));
      const zoom = z0 + Math.log2(1 / width(s));
      const [lng, lat] = unproject(ax + (bx - ax) * k, ay + (by - ay) * k, z0);
      return {
        lng,
        lat,
        zoom: Number.isFinite(zoom) ? zoom : to.zoom,
      };
    },
  };
}

/** Ease-in-out for flights (cubic). */
export const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/**
 * The `@math.gl/web-mercator` viewport for a camera and a CSS-pixel view size. The map is
 * always flat and north-up (SPEC.md §3).
 */
export const viewportFor = (camera: CameraState, size: Size) =>
  new WebMercatorViewport({
    width: Math.max(1, size.width),
    height: Math.max(1, size.height),
    longitude: camera.lng,
    latitude: camera.lat,
    zoom: camera.zoom,
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

