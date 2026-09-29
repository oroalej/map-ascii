import type { CameraState } from '@atlas/shared';
import { describe, expect, it } from 'vitest';
import {
  clampCamera,
  panBy,
  project,
  TILE_SIZE,
  unproject,
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
