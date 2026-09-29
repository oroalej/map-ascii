import type { CameraState } from '@atlas/shared';
import { describe, expect, it } from 'vitest';
import {
  clampCamera,
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
