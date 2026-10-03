import { describe, expect, it } from 'vitest';
import { FIREWORK_VARIANTS, resolveSeason, epochDay, type SeasonConfig } from '@atlas/shared';
import city from '../../content/cities/naga/city.json';
import {
  FIREWORKS,
  FIREWORK_INSTANCE_COUNT,
  createFireworkDisplay,
  fireworkInstances,
  fireworkRadius,
  fireworkRise,
  fireworkScale,
  fireworkShellCount,
  fireworkShells,
  fireworkVariantCodes,
} from './fireworks-layout';
import { placeGrid, type View } from './grid';
import { mapGlyphs, themes } from './theme';

const view: View = {
  camera: { lng: 123.185, lat: 13.625, zoom: 19 },
  dpr: 1,
  width: 1000,
  height: 800,
  cellDev: { w: 5, h: 9 },
  labelDev: { w: 10, h: 18 },
  detailZoom: 19,
};
const shells = () => new Float32Array(FIREWORKS.shells * 4);
const grid = (v = view) => placeGrid(v, v.cellDev, 202, 92).grid;

describe('bounded New Year shells', () => {
  it('uses a fixed particle cap with smoke underneath trails and tips', () => {
    const instances = fireworkInstances();
    expect(instances.length).toBe(FIREWORK_INSTANCE_COUNT * 4);
    expect(FIREWORK_INSTANCE_COUNT).toBeLessThan(9000);
    expect(instances.byteLength).toBeLessThan(150_000);
    for (let i = 0; i < instances.length; i += 4) {
      expect(instances[i]).toBeGreaterThanOrEqual(0);
      expect(instances[i]).toBeLessThan(FIREWORKS.shells);
      expect(instances[i + 1]).toBeLessThan(instances[i + 3] ? FIREWORKS.smoke : FIREWORKS.stars);
      expect(instances[i + 2]).toBeLessThan(FIREWORKS.tails);
    }
    const sparks = FIREWORKS.shells * FIREWORKS.smoke * 4;
    expect(instances[sparks - 1]).toBe(1);
    expect([...instances.slice(sparks, sparks + 4)]).toEqual([0, 0, FIREWORKS.tails - 1, 0]);
    const secondShell = sparks + FIREWORKS.stars * FIREWORKS.tails * 4;
    expect([...instances.slice(secondShell, secondShell + 4)]).toEqual([
      1,
      0,
      FIREWORKS.tails - 1,
      0,
    ]);
    expect(fireworkInstances()).toEqual(instances);
  });

  it('ties larger overhead bursts and longer rises to higher launches', () => {
    for (const zoom of [7, 16, 19, 19.5, 20]) {
      expect(fireworkRadius(200, zoom)).toBeGreaterThan(fireworkRadius(100, zoom));
      expect(fireworkRadius(200, zoom) / fireworkRadius(100, zoom)).toBeCloseTo(2);
    }
    expect(fireworkRise(200)).toBeGreaterThan(fireworkRise(100));
    const display = createFireworkDisplay(123),
      out = shells();
    fireworkShells(view, grid(), out, display, 0, false);
    const heights = display.launches.slice(0, 49).map((launch) => launch!.height);
    expect(Math.max(...heights) - Math.min(...heights)).toBeGreaterThan(100);
    for (let slot = 0; slot < 49; slot++) {
      const launch = display.launches[slot]!;
      expect(out[slot * 4 + 3]).toBeCloseTo(fireworkRadius(launch.height, 19), 3);
      expect(display.flights[slot * 2 + 1]).toBeCloseTo(fireworkRise(launch.height));
    }
  });

  it('keeps active anchors, heights and phases stable through fractional pans, zoom and resize', () => {
    const display = createFireworkDisplay(123),
      a = shells(),
      b = shells();
    fireworkShells(view, grid(), a, display, 0, false);
    const flights = display.flights.slice();
    const launches = display.launches.slice();
    const original = grid();
    fireworkShells(
      view,
      { ...original, shiftX: original.shiftX + 0.5, shiftY: original.shiftY + 0.25 },
      b,
      display,
      0,
      false,
    );
    for (let slot = 0; slot < 49; slot++) {
      expect(b[slot * 4]).toBeCloseTo(a[slot * 4]! - 0.5, 3);
      expect(b[slot * 4 + 1]).toBeCloseTo(a[slot * 4 + 1]! - 0.25, 3);
      expect(b[slot * 4 + 2]).toBe(a[slot * 4 + 2]);
    }
    for (const [zoom, width, height, dpr] of [
      [19.01, 1000, 800, 1],
      [19.5, 1200, 900, 1],
      [20, 2000, 1600, 2],
    ] as const) {
      const v = {
        ...view,
        camera: { ...view.camera, zoom },
        width,
        height,
        dpr,
        cellDev: { w: 5 * dpr, h: 9 * dpr },
      };
      const next = grid(v),
        scale = dpr * fireworkScale(zoom);
      const count = fireworkShells(v, next, b, display, 0, false);
      for (let slot = 0; slot < count; slot++) {
        const launch = launches[slot]!;
        expect(display.launches[slot]).toBe(launch);
        expect(b[slot * 4]).toBeCloseTo(
          launch.x * scale - (next.originCol * v.cellDev.w + next.shiftX),
          3,
        );
        expect(b[slot * 4 + 1]).toBeCloseTo(
          launch.y * scale - (next.originRow * v.cellDev.h + next.shiftY),
          3,
        );
        expect(b[slot * 4 + 3]).toBeCloseTo(fireworkRadius(launch.height, zoom) * dpr, 3);
        expect(display.flights[slot * 2]).toBe(flights[slot * 2]);
      }
    }
  });

  it('chooses irregular positions and independent times, relocating only after smoke has faded', () => {
    const display = createFireworkDisplay(456),
      out = shells();
    fireworkShells(view, grid(), out, display, 0, false);
    const initial = display.launches.slice(0, 49);
    const nextTimes = initial.map((launch) => launch!.next);
    expect(new Set(nextTimes.map((time) => Math.round(time * 100))).size).toBeGreaterThan(35);
    expect(
      new Set(Array.from({ length: 49 }, (_, i) => Math.round(out[i * 4]!))).size,
    ).toBeGreaterThan(35);
    const quadrants = new Set(
      Array.from(
        { length: 49 },
        (_, i) => (out[i * 4]! > 500 ? 1 : 0) + (out[i * 4 + 1]! > 400 ? 2 : 0),
      ),
    );
    expect(quadrants.size).toBe(4);
    for (let time = 0.1; time <= 12; time += 0.1) {
      const before = display.launches.slice();
      fireworkShells(view, grid(), out, display, time, false);
      for (let slot = 0; slot < 49; slot++) {
        if (display.launches[slot] === before[slot]) continue;
        const previous = before[slot]!,
          launch = display.launches[slot]!;
        expect(time - previous.start - previous.rise).toBeGreaterThan(FIREWORKS.smokeLife);
        expect(launch.x).not.toBe(previous.x);
        expect(launch.y).not.toBe(previous.y);
        expect(launch.seed).not.toBe(previous.seed);
        expect(out[slot * 4]).toBeGreaterThanOrEqual(view.width * 0.08);
        expect(out[slot * 4]).toBeLessThanOrEqual(view.width * 0.92);
        expect(out[slot * 4 + 1]).toBeGreaterThanOrEqual(view.height * 0.08);
        expect(out[slot * 4 + 1]).toBeLessThanOrEqual(view.height * 0.92);
      }
    }
    expect(display.launches.slice(0, 49).every((launch, slot) => launch !== initial[slot])).toBe(
      true,
    );
  });

  it('is reproducible with an injected seed while separate contexts have different shows', () => {
    const a = createFireworkDisplay(123),
      b = createFireworkDisplay(123),
      c = createFireworkDisplay(124);
    const one = shells(),
      two = shells(),
      three = shells();
    for (const time of [0, 1, 5, 10, 20]) {
      fireworkShells(view, grid(), one, a, time, false);
      fireworkShells(view, grid(), two, b, time, false);
      fireworkShells(view, grid(), three, c, time, false);
      expect(two).toEqual(one);
      expect(b.flights).toEqual(a.flights);
      expect(three).not.toEqual(one);
    }
  });

  it('keeps a dense overlapping display across many independently scheduled launches', () => {
    const display = createFireworkDisplay(123),
      out = shells();
    let peak = 0;
    for (let time = 0; time < 60; time += 0.1) {
      fireworkShells(view, grid(), out, display, time, false);
      let active = 0;
      for (let slot = 0; slot < 49; slot++) {
        const age = display.flights[slot * 2]! - display.flights[slot * 2 + 1]!;
        if (age > 0.05 && age < FIREWORKS.sparkLife - 0.05) active++;
      }
      expect(active).toBeGreaterThanOrEqual(12);
      peak = Math.max(peak, active);
    }
    expect(peak).toBeGreaterThanOrEqual(30);
  });

  it('retains zoom bands with one higher-altitude distant shell at a changing location', () => {
    for (const [zoom, count] of [
      [7, 50],
      [15.99, 50],
      [16, 50],
      [16.001, 49],
      [19.999, 49],
      [20, 4],
      [20.999, 4],
      [21, 0],
      [22, 0],
      [6, 0],
      [NaN, 0],
      [Infinity, 0],
    ] as const) {
      const v = { ...view, camera: { ...view.camera, zoom } };
      const display = createFireworkDisplay(123),
        out = shells();
      expect(fireworkShellCount(zoom)).toBe(count);
      expect(fireworkShells(v, grid(v), out, display, 0, false)).toBe(count);
      expect(out.slice(count * 4).every((value) => value === 0)).toBe(true);
      expect(display.flights.slice(count * 2).every((value) => value === 0)).toBe(true);
      if (zoom >= 7 && zoom <= 16) {
        const high = display.launches[49]!;
        expect(high.height).toBeGreaterThan(FIREWORKS.maxHeight);
        expect(out[199]).toBeGreaterThan(
          Math.max(...Array.from({ length: 49 }, (_, i) => out[i * 4 + 3]!)),
        );
        expect(out[196]).not.toBe(view.width / 2);
        const oldX = out[196],
          oldY = out[197];
        fireworkShells(v, grid(v), out, display, high.next + 0.01, false);
        expect(out[196]).not.toBe(oldX);
        expect(out[197]).not.toBe(oldY);
      }
    }
    for (const dpr of [1, 2, 3]) {
      const v = {
        ...view,
        camera: { ...view.camera, zoom: 16 },
        dpr,
        width: 390 * dpr,
        height: 844 * dpr,
        cellDev: { w: 5 * dpr, h: 9 * dpr },
      };
      const out = shells();
      fireworkShells(v, grid(v), out, createFireworkDisplay(123), 0, false);
      expect(out[199]! / dpr).toBeCloseTo(390 * 0.45, 3);
      expect(out[196]! - out[199]!).toBeGreaterThanOrEqual(0);
      expect(out[196]! + out[199]!).toBeLessThanOrEqual(v.width);
    }
  });

  it('freezes reduced-motion launches, safely resumes and bounds ages after long/invalid clocks', () => {
    const display = createFireworkDisplay(123),
      out = shells();
    fireworkShells(view, grid(), out, display, 8, true);
    const pose = out.slice(),
      flights = display.flights.slice();
    fireworkShells(view, grid(), out, display, 1e9, true);
    expect(out).toEqual(pose);
    expect(display.flights).toEqual(flights);
    fireworkShells(view, grid(), out, display, 10, false);
    const resumed = display.flights.slice();
    fireworkShells(view, grid(), out, display, 10.1, false);
    expect(display.flights[0]).toBeCloseTo(resumed[0]! + 0.1);
    for (const time of [1e9, 1e9 + 0.1, -5, NaN, Infinity]) {
      fireworkShells(view, grid(), out, display, time, false);
      expect([...out, ...display.flights].every(Number.isFinite)).toBe(true);
      for (let slot = 0; slot < 49; slot++) {
        expect(display.flights[slot * 2]).toBeGreaterThanOrEqual(0);
        expect(display.flights[slot * 2]).toBeLessThan(12);
      }
    }
  });

  it('magnifies height-driven burst and smoke extent independently of DPR and map-cell density', () => {
    for (const zoom of [7, 14, 15.5, 17, 18.5, 19, 19.5, 20, 20.5]) {
      expect(fireworkScale(zoom)).toBeCloseTo(2 ** (zoom - 19));
      for (const dpr of [1, 1.25, 2, 3])
        for (const cell of [5, 6, 8]) {
          const v = {
            ...view,
            camera: { ...view.camera, zoom },
            dpr,
            cellDev: { w: cell * dpr, h: cell * 1.8 * dpr },
          };
          const display = createFireworkDisplay(123),
            out = shells();
          const count = fireworkShells(v, grid(v), out, display, 0, false);
          for (let slot = 0; slot < Math.min(count, 49); slot++)
            expect(out[slot * 4 + 3]! / dpr).toBeCloseTo(
              display.launches[slot]!.height * 0.95 * Math.max(0.6, 2 ** (zoom - 19)),
              3,
            );
        }
    }
    expect(fireworkRadius(150, 20) / fireworkRadius(150, 19)).toBe(2);
    for (const zoom of [-1000, 1000, NaN, Infinity]) {
      expect(Number.isFinite(fireworkScale(zoom))).toBe(true);
      expect(fireworkScale(zoom)).toBeGreaterThanOrEqual(1 / 4096);
      expect(fireworkScale(zoom)).toBeLessThanOrEqual(4);
    }
    for (const theme of Object.values(themes))
      for (const glyph of ['·', '*', '+', '─', '╱', '│', '╲'])
        expect(mapGlyphs(theme)).toContain(glyph);
    expect(fireworkVariantCodes({ label: 'Display', variants: [...FIREWORK_VARIANTS] })).toEqual([
      0, 1, 2, 3,
    ]);
  });

  it('reframes still poses after panning completely away without animating between frames', () => {
    const display = createFireworkDisplay(123),
      out = shells();
    fireworkShells(view, grid(), out, display, 0, true);
    const launch = display.launches[0];
    const panned = { ...view, camera: { ...view.camera, lng: view.camera.lng + 0.1 } };
    fireworkShells(panned, grid(panned), out, display, 10, true);
    expect(display.launches[0]).not.toBe(launch);
    for (let slot = 0; slot < 49; slot++) {
      expect(out[slot * 4]).toBeGreaterThan(0);
      expect(out[slot * 4]).toBeLessThan(view.width);
    }
    const pose = out.slice(),
      flights = display.flights.slice();
    fireworkShells(panned, grid(panned), out, display, 20, true);
    expect(out).toEqual(pose);
    expect(display.flights).toEqual(flights);
  });

  it('the real city pack selects New Year automatically and explicitly, without replacing Christmas previews', () => {
    const seasons = city.life.seasons as SeasonConfig[];
    expect(
      resolveSeason(seasons, 'auto', 2026, epochDay(2026, 12, 31))?.fireworks?.variants,
    ).toEqual(FIREWORK_VARIANTS);
    expect(resolveSeason(seasons, 'auto', 2027, epochDay(2027, 1, 1))?.id).toBe('new-year');
    expect(resolveSeason(seasons, 'auto', 2027, epochDay(2027, 1, 2))?.id).toBe('christmas');
    expect(resolveSeason(seasons, 'new-year', 2026, epochDay(2026, 7, 10))?.id).toBe('new-year');
    expect(resolveSeason(seasons, 'christmas', 2026, epochDay(2026, 12, 31))?.id).toBe('christmas');
  });
});
