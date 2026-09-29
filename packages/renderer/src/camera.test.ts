import type { CameraState } from '@atlas/shared';
import { describe, expect, it } from 'vitest';
import {
  clampCamera,
  easeInOut,
  fitZoom,
  FLY_MAX_MS,
  FLY_MIN_MS,
  FLY_REDUCED_MS,
  flyPath,
  isTilted,
  MAX_PITCH,
  MAX_ZOOM,
  multiply,
  orbitBy,
  panBy,
  panByView,
  project,
  TILE_SIZE,
  unproject,
  viewportFor,
  wrapBearing,
  zoomAround,
  zoomAroundClamped,
  type CameraLimits,
} from './camera';

const camera: CameraState = { lat: 13.62, lng: 123.19, zoom: 15, pitch: 0, bearing: 0 };
const limits: CameraLimits = { bounds: [122, 11, 125, 15], minZoom: 7, maxZoom: 19 };

/** The ground point under a screen offset (from the view center). */
const groundAt = (c: CameraState, [ax, ay]: [number, number]) => {
  const [x, y] = project(c.lng, c.lat, c.zoom);
  return unproject(x + ax, y + ay, c.zoom);
};

describe('project / unproject', () => {
  it('uses 512-px tiles with y pointing south', () => {
    expect(project(-180, 0, 0)[0]).toBeCloseTo(0);
    expect(project(0, 0, 0)).toEqual([TILE_SIZE / 2, TILE_SIZE / 2]);
    expect(project(0, 0, 1)).toEqual([TILE_SIZE, TILE_SIZE]);
    const [, north] = project(0, 60, 3);
    const [, south] = project(0, -60, 3);
    expect(north).toBeLessThan(south);
  });

  it('round-trips', () => {
    const [x, y] = project(camera.lng, camera.lat, 18);
    const [lng, lat] = unproject(x, y, 18);
    expect(lng).toBeCloseTo(camera.lng, 9);
    expect(lat).toBeCloseTo(camera.lat, 9);
  });
});

describe('deep zoom', () => {
  it('keeps world cell indices within 32-bit ints at the maximum zoom', () => {
    // The select shader works in world cells (ivec2); the grid origin is world px / cell px.
    // Device px and cell size both scale with the pixel ratio, so it cancels out.
    const [x, y] = project(179.99, -85, MAX_ZOOM);
    const cellWidth = 10;
    expect(x / cellWidth).toBeLessThan(2 ** 31);
    expect(y / cellWidth).toBeLessThan(2 ** 31);
  });

  it('round-trips positions at the maximum zoom to within a centimeter', () => {
    const [x, y] = project(camera.lng, camera.lat, MAX_ZOOM);
    const [lng, lat] = unproject(x + 0.5, y + 0.5, MAX_ZOOM);
    // Half a pixel at z21 is under 2 cm.
    expect(Math.abs(lng - camera.lng) * 111_000).toBeLessThan(0.02);
    expect(Math.abs(lat - camera.lat) * 111_000).toBeLessThan(0.02);
  });
});

describe('panBy', () => {
  it('moves the content with the pointer (the center the other way)', () => {
    const moved = panBy(camera, 100, 0);
    expect(moved.lng).toBeLessThan(camera.lng);
    expect(moved.lat).toBeCloseTo(camera.lat, 9);
    const [x0] = project(camera.lng, camera.lat, camera.zoom);
    const [x1] = project(moved.lng, moved.lat, camera.zoom);
    expect(x0 - x1).toBeCloseTo(100, 6);
  });

  it('is undone by the opposite pan', () => {
    const back = panBy(panBy(camera, 37, -52), -37, 52);
    expect(back.lng).toBeCloseTo(camera.lng, 9);
    expect(back.lat).toBeCloseTo(camera.lat, 9);
  });
});

describe('zoomAround', () => {
  it('keeps the ground point under the anchor fixed', () => {
    const anchor: [number, number] = [-300, 120];
    const before = groundAt(camera, anchor);
    for (const zoom of [13.2, 15.5, 18]) {
      const after = groundAt(zoomAround(camera, zoom, anchor), anchor);
      expect(after[0]).toBeCloseTo(before[0], 9);
      expect(after[1]).toBeCloseTo(before[1], 9);
    }
  });

  it('zooms around the center when the anchor is the center', () => {
    const zoomed = zoomAround(camera, 17, [0, 0]);
    expect(zoomed).toMatchObject({ zoom: 17 });
    expect(zoomed.lng).toBeCloseTo(camera.lng, 9);
    expect(zoomed.lat).toBeCloseTo(camera.lat, 9);
  });
});

describe('clampCamera', () => {
  it('clamps zoom to the limits', () => {
    expect(clampCamera({ ...camera, zoom: 3 }, limits).zoom).toBe(7);
    expect(clampCamera({ ...camera, zoom: 22 }, limits).zoom).toBe(19);
    expect(clampCamera(camera, limits)).toEqual(camera);
  });

  it('keeps the center inside the bounds', () => {
    const out = clampCamera({ ...camera, lng: 130, lat: 5 }, limits);
    expect(out).toMatchObject({ lng: 125, lat: 11 });
  });

  it('clamps anchored zooms before moving', () => {
    const out = zoomAroundClamped(camera, 25, [200, 0], limits);
    expect(out.zoom).toBe(19);
    const anchored = groundAt(out, [200, 0]);
    const before = groundAt(camera, [200, 0]);
    expect(anchored[0]).toBeCloseTo(before[0], 9);
  });
});

describe('clampCamera with a view size', () => {
  const size = { width: 800, height: 600 };
  const edges = (c: CameraState) => {
    const [x, y] = project(c.lng, c.lat, c.zoom);
    const [west, north] = unproject(x - size.width / 2, y - size.height / 2, c.zoom);
    const [east, south] = unproject(x + size.width / 2, y + size.height / 2, c.zoom);
    return { west, south, east, north };
  };

  it('keeps the whole view over the bounds', () => {
    const corner = clampCamera({ ...camera, lng: 122.001, lat: 14.999, zoom: 10 }, limits, size);
    const e = edges(corner);
    expect(e.west).toBeGreaterThanOrEqual(122 - 1e-9);
    expect(e.north).toBeLessThanOrEqual(15 + 1e-9);
  });

  it('centers on the bounds when the view is larger than them', () => {
    const wide = clampCamera({ ...camera, zoom: 7 }, limits, { width: 4000, height: 4000 });
    const [cx] = project(123.5, 13, 7);
    expect(project(wide.lng, wide.lat, 7)[0]).toBeCloseTo(cx, 6);
  });

  it('leaves a view well inside the bounds alone', () => {
    expect(clampCamera(camera, limits, size)).toEqual(camera);
  });
});

describe('fitZoom', () => {
  it('is the zoom at which the bounds just cover the view', () => {
    const size = { width: 1000, height: 1000 };
    const z = fitZoom(limits.bounds, size);
    const [x0, y0] = project(122, 15, z);
    const [x1, y1] = project(125, 11, z);
    // The bounds are taller than wide, so their width is what fills the square view.
    expect(Math.min(x1 - x0, y1 - y0)).toBeCloseTo(1000, 3);
    expect(y1 - y0).toBeGreaterThan(1000);
    // A view twice as wide needs twice the width covered: one zoom level closer.
    expect(fitZoom(limits.bounds, { width: 2000, height: 1000 })).toBeCloseTo(z + 1, 6);
  });
});

describe('flyPath', () => {
  const size = { width: 1200, height: 800 };
  const from: CameraState = { lat: 13.62, lng: 123.19, zoom: 17, pitch: 0, bearing: 10 };
  const far: CameraState = { lat: 12.5, lng: 124.0, zoom: 16, pitch: 30, bearing: -170 };

  it('starts and ends at the two cameras', () => {
    const path = flyPath(from, far, size);
    expect(path.at(0)).toEqual(from);
    expect(path.at(1)).toEqual(far);
    const end = path.at(0.999999);
    expect(end.lng).toBeCloseTo(far.lng, 3);
    expect(end.zoom).toBeCloseTo(far.zoom, 2);
  });

  it('zooms out to travel and moves steadily toward the target', () => {
    const path = flyPath(from, far, size);
    expect(path.at(0.5).zoom).toBeLessThan(Math.min(from.zoom, far.zoom) - 2);
    let last = Infinity;
    for (let t = 0; t <= 1; t += 0.05) {
      const c = path.at(t);
      const d = Math.hypot(c.lng - far.lng, c.lat - far.lat);
      expect(d).toBeLessThanOrEqual(last + 1e-9);
      last = d;
    }
  });

  it('turns the short way round', () => {
    // 10° → -170°: through ±180, not through 0.
    const mid = flyPath(from, far, size).at(0.5).bearing;
    expect(Math.abs(mid)).toBeGreaterThan(90);
  });

  it('clamps the duration, and keeps it short with reduced motion', () => {
    const near = { ...from, lng: from.lng + 1e-5 };
    expect(flyPath(from, near, size).duration).toBe(FLY_MIN_MS);
    const world: CameraState = { ...from, lng: -120, lat: 40, zoom: 19 };
    expect(flyPath(from, world, size).duration).toBe(FLY_MAX_MS);
    expect(flyPath(from, far, size, { reducedMotion: true }).duration).toBeLessThanOrEqual(
      FLY_REDUCED_MS,
    );
  });

  it('takes an explicit duration, which reduced motion still caps', () => {
    expect(flyPath(from, far, size, { duration: 9000 }).duration).toBe(9000);
    const near = { ...from, lng: from.lng + 1e-5 };
    expect(flyPath(from, near, size, { duration: 200 }).duration).toBe(200);
    expect(
      flyPath(from, far, size, { duration: 9000, reducedMotion: true }).duration,
    ).toBeLessThanOrEqual(FLY_REDUCED_MS);
  });

  it('eases in and out', () => {
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(0.5)).toBeCloseTo(0.5);
    expect(easeInOut(1)).toBe(1);
    expect(easeInOut(0.1)).toBeLessThan(0.1);
  });
});

describe('orbit (pitch and bearing)', () => {
  it('wraps bearings into (-180, 180] and clamps pitch to 0–60°', () => {
    expect([0, 180, 181, -180, 360, -190].map(wrapBearing)).toEqual([0, 180, -179, 180, 0, 170]);
    const out = clampCamera({ ...camera, pitch: 80, bearing: 270 }, limits);
    expect(out).toMatchObject({ pitch: MAX_PITCH, bearing: -90 });
    expect(orbitBy(camera, 30, -10)).toMatchObject({ bearing: 30, pitch: 0 });
  });

  it('knows when the view is tilted or rotated', () => {
    expect(isTilted(camera)).toBe(false);
    expect(isTilted({ ...camera, pitch: 20 })).toBe(true);
    expect(isTilted({ ...camera, bearing: -45 })).toBe(true);
  });

  it('pans flat views exactly as panBy, and tilted views by the ground under the center', () => {
    const size = { width: 800, height: 600 };
    expect(panByView(camera, 40, -25, size)).toEqual(panBy(camera, 40, -25));
    // Rotated 90°: dragging right moves the view along a north–south line instead.
    const rotated = { ...camera, bearing: 90 };
    const moved = panByView(rotated, 100, 0, size);
    expect(Math.abs(moved.lat - camera.lat)).toBeGreaterThan(Math.abs(moved.lng - camera.lng));
    expect(viewportFor(rotated, size).project([moved.lng, moved.lat])[0]).toBeCloseTo(300, 0);
  });

  it('multiplies column-major matrices', () => {
    // prettier-ignore
    const translate = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1];
    // prettier-ignore
    const scale = [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 0, 0, 0, 1];
    // Scale then translate: a point (1, 1, 1) lands at (7, 9, 11).
    const m = multiply(translate, scale);
    const apply = (p: number[]) =>
      [0, 1, 2].map((r) => m[r]! * p[0]! + m[4 + r]! * p[1]! + m[8 + r]! * p[2]! + m[12 + r]!);
    expect(apply([1, 1, 1])).toEqual([7, 9, 11]);
  });
});
