import { describe, expect, it, vi } from 'vitest';
import { FIREWORK_VARIANTS } from '@atlas/shared';
import { MAX_ZOOM, project } from './camera';
import { placeGrid, type View } from './grid';
import {
  FIREWORKS,
  clearRequestedFireworks,
  createFireworkDisplay,
  fireworkCameraHeight,
  fireworkShellCount,
  fireworkShells,
  fireworkTapEligible,
  requestFirework,
} from './fireworks-layout';
import type { FireworkSiteSampler } from './fireworks-sites';

const view: View = {
  camera: { lng: 123.185, lat: 13.625, zoom: MAX_ZOOM },
  dpr: 1,
  width: 1000,
  height: 800,
  cellDev: { w: 5, h: 9 },
  labelDev: { w: 10, h: 18 },
  detailZoom: 19,
};
const grid = (v = view) => placeGrid(v, v.cellDev, 202, 92).grid;
const request = (id = 1, zoom = MAX_ZOOM, time = 10) => ({
  id,
  at: [view.camera.lng, view.camera.lat] as const,
  zoom,
  time,
});
const sites: FireworkSiteSampler = (bounds, rng) => ({
  x: bounds.left + rng() * (bounds.right - bounds.left),
  y: bounds.top + rng() * (bounds.bottom - bounds.top),
  id: Math.floor(rng() * 1e9),
});

describe('requested firework shells', () => {
  it('launches without sites at maximum zoom, below the eye, without ambient RNG or reservations', () => {
    const display = createFireworkDisplay(123);
    display.rng = vi.fn(display.rng);
    const out = new Float32Array(FIREWORKS.shells * 4);
    expect(fireworkShellCount(MAX_ZOOM)).toBe(0);
    expect(requestFirework(display, request())).toBe(true);
    const launch = [...display.requested!.values()][0]!;
    expect(launch.height).toBeLessThan(fireworkCameraHeight(MAX_ZOOM));
    expect(launch.start).toBe(10);
    expect(fireworkShells(view, grid(), out, display, 10, false)).toBe(1);
    expect(display.rng).not.toHaveBeenCalled();
    expect(display.occupied.size).toBe(0);
    expect(display.launches.every((value) => value === undefined)).toBe(true);
    expect(display.admitted[0]).toBe(45);
    expect(display.flights[0]).toBe(0);
    expect(out.slice(4).every((value) => value === 0)).toBe(true);
  });

  it('borrows four regular slots, protects them from thinning, and preserves the high slot and allocation', () => {
    const display = createFireworkDisplay(123);
    const distant = { ...view, camera: { ...view.camera, zoom: 16 } };
    const out = new Float32Array(FIREWORKS.shells * 4);
    expect(fireworkShells(distant, grid(distant), out, display, 10, false, sites)).toBe(50);
    const ambient = display.launches.slice();
    for (let id = 1; id <= 4; id++) expect(requestFirework(display, request(id))).toBe(true);
    expect(requestFirework(display, request(5))).toBe(false);
    const close = { ...view, camera: { ...view.camera, zoom: 20.75, lng: 123.195 } };
    expect(fireworkShellCount(close.camera.zoom)).toBe(1);
    expect(fireworkShells(close, grid(close), out, display, 10, false, sites)).toBe(4);
    expect([...display.admitted.slice(0, 4)].sort()).toEqual([45, 46, 47, 48]);
    expect(display.launches).toEqual(ambient);
    expect(display.requested!.has(49)).toBe(false);
    expect(display.launches[49]).toBe(ambient[49]);
    expect(out.length).toBe(200);
    clearRequestedFireworks(display);
    expect(fireworkShells(distant, grid(distant), out, display, 10, false, sites)).toBe(50);
    expect(display.launches).toEqual(ambient);
  });

  it('keeps requested geographic anchors and phases through pan and zoom', () => {
    const display = createFireworkDisplay(123);
    requestFirework(display, request());
    const launch = display.requested!.get(45)!;
    expect([launch.x, launch.y]).toEqual(project(...request().at, FIREWORKS.referenceZoom));
    const out = new Float32Array(200);
    for (const zoom of [21, 20.5, 19]) {
      const panned = { ...view, camera: { ...view.camera, lng: 123.184, zoom } };
      const g = grid(panned);
      expect(fireworkShells(panned, g, out, display, 10.5, false)).toBe(1);
      expect(display.requested!.get(45)).toBe(launch);
      expect(out[0]).toBeCloseTo(launch.x * 2 ** (zoom - 19) - g.originCol * 5 - g.shiftX, 3);
      expect(out[1]).toBeCloseTo(launch.y * 2 ** (zoom - 19) - g.originRow * 9 - g.shiftY, 3);
      expect(display.flights[0]).toBe(0.5);
    }
  });

  it('expires after smoke, clears on reduced motion and clock reset, and restores ambient density', () => {
    const display = createFireworkDisplay(123),
      out = new Float32Array(200);
    requestFirework(display, request());
    const until = display.requested!.get(45)!.next;
    expect(fireworkShells(view, grid(), out, display, until - 0.01, false)).toBe(1);
    expect(fireworkShells(view, grid(), out, display, until, false)).toBe(0);
    expect(display.requested).toBeUndefined();
    requestFirework(display, request(2, 21, 20));
    expect(fireworkShells(view, grid(), out, display, 20, true)).toBe(0);
    expect(display.requested).toBeUndefined();
    requestFirework(display, request(3, 21, 30));
    fireworkShells(view, grid(), out, display, 30, false);
    expect(fireworkShells(view, grid(), out, display, 1, false)).toBe(0);
    expect(display.requested).toBeUndefined();
  });

  it('leaves seeded tap-free launch packing and RNG sequences identical', () => {
    const a = createFireworkDisplay(123),
      b = createFireworkDisplay(123);
    const one = new Float32Array(200),
      two = new Float32Array(200);
    for (const time of [0, 1, 10, 30]) {
      const ordinary = { ...view, camera: { ...view.camera, zoom: 19 } };
      const count = fireworkShells(ordinary, grid(ordinary), one, a, time, false, sites);
      expect(fireworkShells(ordinary, grid(ordinary), two, b, time, false, sites)).toBe(count);
      expect(two).toEqual(one);
      expect(b.launches).toEqual(a.launches);
      expect(b.flights).toEqual(a.flights);
      expect(a.requested).toBeUndefined();
      expect(a.rng()).toBe(b.rng());
    }
    fireworkShells(view, grid(), one, a, 31, false);
    fireworkShells(view, grid(), two, b, 31, false);
    expect(a.rng()).toBe(b.rng());
  });

  it('admits the tap branch only at night in a configured fireworks season', () => {
    const config = { label: 'Display', variants: [...FIREWORK_VARIANTS] };
    expect(fireworkTapEligible(config, -1)).toBe(true);
    expect(fireworkTapEligible(config, 0)).toBe(false);
    expect(fireworkTapEligible(config, 30)).toBe(false);
    expect(fireworkTapEligible(undefined, -20)).toBe(false);
    expect(fireworkTapEligible({ label: 'Empty', variants: [] }, -20)).toBe(false);
  });
});
