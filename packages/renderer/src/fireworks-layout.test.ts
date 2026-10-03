import { describe, expect, it } from 'vitest';
import { FIREWORK_VARIANTS, resolveSeason, epochDay, type SeasonConfig } from '@atlas/shared';
import city from '../../content/cities/naga/city.json';
import {
  FIREWORKS,
  FIREWORK_INSTANCE_COUNT,
  createFireworkDisplay,
  fireworkCameraHeight,
  fireworkInstances,
  fireworkRadius,
  fireworkPerspective,
  fireworkRise,
  fireworkScale,
  fireworkShellCount,
  fireworkShells,
  fireworkSparkWidth,
  fireworkVisibility,
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
    for (const zoom of [7, 16, 19, 19.5]) {
      expect(fireworkRadius(200, zoom)).toBeGreaterThan(fireworkRadius(100, zoom));
    }
    expect(fireworkRise(200)).toBeGreaterThan(fireworkRise(100));
    const display = createFireworkDisplay(123),
      out = shells();
    const count = fireworkShells(view, grid(), out, display, 0, false);
    const heights = display.launches.slice(0, 49).map((launch) => launch!.height);
    expect(Math.max(...heights) - Math.min(...heights)).toBeGreaterThan(100);
    for (let slot = 0; slot < count; slot++) {
      const launch = display.launches[display.admitted[slot]!]!;
      expect(out[slot * 4 + 3]).toBeCloseTo(fireworkRadius(launch.height, 19), 3);
      expect(display.flights[slot * 2 + 1]).toBeCloseTo(fireworkRise(launch.height));
    }
  });

  it('grows each fixed launch on approach, then hides it when the viewpoint passes below its height', () => {
    for (const height of [80, 100, 150, 220, 500]) {
      let radius = 0,
        ink = 0;
      for (let zoom = 7; zoom < 21; zoom += 0.02) {
        const visible = fireworkVisibility(height, zoom);
        const nextRadius = fireworkRadius(height, zoom),
          nextInk = fireworkSparkWidth(height, zoom);
        expect(Number.isFinite(nextRadius)).toBe(true);
        expect(nextRadius).toBeLessThanOrEqual(FIREWORKS.maxRadius);
        if (visible > 0) {
          expect(nextRadius).toBeGreaterThanOrEqual(radius - 1e-6);
          expect(nextInk).toBeGreaterThanOrEqual(ink - 1e-6);
          radius = nextRadius;
          ink = nextInk;
        } else {
          expect(nextRadius).toBe(0);
          expect(nextInk).toBe(0);
        }
      }
      const crossing = 19 + Math.log2(FIREWORKS.cameraHeight / height);
      expect(fireworkVisibility(height, crossing - 0.3)).toBeGreaterThan(0);
      expect(fireworkVisibility(height, crossing - 0.3)).toBeLessThan(1);
      expect(fireworkVisibility(height, crossing + 0.001)).toBe(0);
      expect(fireworkRadius(height, crossing + 0.001)).toBe(0);
    }
    expect(fireworkVisibility(220, 20)).toBe(0);
    expect(fireworkVisibility(100, 20)).toBe(1);
    expect(fireworkCameraHeight(21)).toBe(FIREWORKS.minHeight);
  });

  it('keeps the high launch across z16 and removes it according to altitude without lowering its height', () => {
    const display = createFireworkDisplay(123),
      out = shells();
    const distant = { ...view, camera: { ...view.camera, zoom: 16 } };
    fireworkShells(distant, grid(distant), out, display, 0, false);
    const high = display.launches[49]!;
    const crossing = 19 + Math.log2(FIREWORKS.cameraHeight / high.height);
    let previousRadius = out[199]!;
    for (const zoom of [16.001, 17, 17.5, crossing - 0.001]) {
      const next = { ...view, camera: { ...view.camera, zoom } };
      fireworkShells(next, grid(next), out, display, 0, false);
      const packed = display.admitted.indexOf(49);
      expect(packed).toBeGreaterThanOrEqual(0);
      expect(display.launches[49]).toBe(high);
      expect(out[packed * 4 + 3]).toBeGreaterThanOrEqual(previousRadius);
      expect(display.flights[packed * 2]).toBeCloseTo(-high.start);
      previousRadius = out[packed * 4 + 3]!;
    }
    const below = { ...view, camera: { ...view.camera, zoom: crossing + 0.001 } };
    fireworkShells(below, grid(below), out, display, 0, false);
    expect(display.admitted).not.toContain(49);
    expect(display.launches[49]).toBe(high);
  });

  it('packs only below-camera launches and preserves heights when nothing survives, including reduced motion', () => {
    for (const reduced of [false, true]) {
      const display = createFireworkDisplay(123),
        out = shells();
      fireworkShells(view, grid(), out, display, 0, reduced);
      for (const launch of display.launches) if (launch) launch.height = 200;
      const launches = display.launches.slice();
      const close = { ...view, camera: { ...view.camera, zoom: 20 } };
      for (let frame = 0; frame < 3; frame++) {
        expect(fireworkShells(close, grid(close), out, display, 0, reduced)).toBe(0);
        expect(out.every((value) => value === 0)).toBe(true);
        expect(display.flights.every((value) => value === 0)).toBe(true);
        expect(display.appearance.every((value) => value === 0)).toBe(true);
        expect(display.admitted.every((value) => value === -1)).toBe(true);
        expect(display.launches).toEqual(launches);
      }
      expect(fireworkShells(view, grid(), out, display, 0, reduced)).toBe(fireworkShellCount(19));
      expect(display.launches).toEqual(launches);
    }
  });
  it('keeps active anchors, heights and phases stable through fractional pans, zoom and resize', () => {
    const display = createFireworkDisplay(123),
      a = shells(),
      b = shells();
    fireworkShells(view, grid(), a, display, 0, false);
    const sources = display.admitted.slice();
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
    for (let slot = 0; display.admitted[slot]! >= 0; slot++) {
      const source = display.admitted[slot]!,
        previous = sources.indexOf(source);
      expect(previous).toBeGreaterThanOrEqual(0);
      const perspective = fireworkPerspective(launches[source]!.height, view.camera.zoom);
      expect(b[slot * 4]).toBeCloseTo(a[previous * 4]! - 0.5 * perspective, 3);
      expect(b[slot * 4 + 1]).toBeCloseTo(a[previous * 4 + 1]! - 0.25 * perspective, 3);
      expect(b[slot * 4 + 2]).toBe(a[previous * 4 + 2]);
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
        const source = display.admitted[slot]!,
          launch = launches[source]!;
        const perspective = fireworkPerspective(launch.height, zoom);
        expect(display.launches[source]).toBe(launch);
        expect(b[slot * 4]).toBeCloseTo(
          width / 2 +
            (launch.x * scale - (next.originCol * v.cellDev.w + next.shiftX) - width / 2) *
              perspective,
          3,
        );
        expect(b[slot * 4 + 1]).toBeCloseTo(
          height / 2 +
            (launch.y * scale - (next.originRow * v.cellDev.h + next.shiftY) - height / 2) *
              perspective,
          3,
        );
        expect(b[slot * 4 + 3]).toBeCloseTo(fireworkRadius(launch.height, zoom) * dpr, 3);
        expect(display.flights[slot * 2]).toBe(Math.fround(-launch.start));
      }
    }
  });

  it('chooses irregular positions and independent times, relocating only after smoke has faded', () => {
    const display = createFireworkDisplay(456),
      out = shells();
    const distant = { ...view, camera: { ...view.camera, zoom: 16 } };
    fireworkShells(distant, grid(distant), out, display, 0, false);
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
      fireworkShells(distant, grid(distant), out, display, time, false);
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
    const distant = { ...view, camera: { ...view.camera, zoom: 16 } };
    let peak = 0;
    for (let time = 0; time < 60; time += 0.1) {
      fireworkShells(distant, grid(distant), out, display, time, false);
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

  it('progressively thins the display with one higher-altitude shell at a changing location', () => {
    for (const [zoom, count] of [
      [7, 50],
      [15.99, 50],
      [16, 50],
      [16.001, 50],
      [17, 31],
      [18, 17],
      [18.5, 11],
      [19, 7],
      [19.999, 5],
      [20, 4],
      [20.25, 3],
      [20.5, 2],
      [20.75, 1],
      [20.999, 1],
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
      const admitted = fireworkShells(v, grid(v), out, display, 0, false);
      expect(admitted).toBeLessThanOrEqual(count);
      if (zoom <= 19 && zoom >= 7) expect(admitted).toBe(count);
      expect(out.slice(admitted * 4).every((value) => value === 0)).toBe(true);
      expect(display.flights.slice(admitted * 2).every((value) => value === 0)).toBe(true);
      expect(display.appearance.slice(admitted * 2).every((value) => value === 0)).toBe(true);
      expect(display.admitted.slice(admitted).every((value) => value === -1)).toBe(true);
      for (let slot = 0; slot < admitted; slot++) {
        expect(display.launches[display.admitted[slot]!]!.height).toBeLessThan(
          fireworkCameraHeight(zoom),
        );
        expect(display.appearance[slot * 2]).toBeGreaterThan(0);
      }
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
      expect(out[199]! / dpr).toBeLessThanOrEqual(390 * 0.45);
      expect(out[196]! - out[199]!).toBeGreaterThanOrEqual(0);
      expect(out[196]! + out[199]!).toBeLessThanOrEqual(v.width);
    }
  });

  it('never increases the density ceiling or packed count on zoom, without restarting fixed launches', () => {
    const display = createFireworkDisplay(123),
      out = shells();
    const distant = { ...view, camera: { ...view.camera, zoom: 16 } };
    fireworkShells(distant, grid(distant), out, display, 0, false);
    const launches = display.launches.slice();
    let previousLimit = FIREWORKS.shells,
      previousCount = FIREWORKS.shells;
    for (let step = 0; step <= 200; step++) {
      const zoom = 16 + step / 40,
        v = { ...view, camera: { ...view.camera, zoom } };
      const limit = fireworkShellCount(zoom),
        count = fireworkShells(v, grid(v), out, display, 0, false);
      expect(limit).toBeLessThanOrEqual(previousLimit);
      expect(count).toBeLessThanOrEqual(previousCount);
      expect(count).toBeLessThanOrEqual(limit);
      for (let packed = 0; packed < count; packed++) {
        const source = display.admitted[packed]!,
          launch = launches[source]!;
        expect(display.launches[source]).toBe(launch);
        expect(out[packed * 4 + 2]).toBe(launch.seed);
        expect(out[packed * 4 + 3]).toBeCloseTo(fireworkRadius(launch.height, zoom), 3);
        expect(display.flights[packed * 2]).toBe(Math.fround(-launch.start));
        expect(display.appearance[packed * 2]).toBeCloseTo(fireworkVisibility(launch.height, zoom));
      }
      expect(out.slice(count * 4).every((value) => value === 0)).toBe(true);
      expect(display.admitted.slice(count).every((value) => value === -1)).toBe(true);
      previousLimit = limit;
      previousCount = count;
    }
    expect(previousCount).toBe(0);
    fireworkShells(distant, grid(distant), out, display, 0, false);
    expect(display.launches).toEqual(launches);

    const high = display.launches[49]!;
    high.height = 560;
    const underHigh = { ...view, camera: { ...view.camera, zoom: 18.3 } };
    expect(fireworkShells(underHigh, grid(underHigh), out, display, 0, false)).toBe(
      fireworkShellCount(18.3) - 1,
    );
    expect(display.admitted).not.toContain(49);
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
          for (let slot = 0; slot < count; slot++) {
            const launch = display.launches[display.admitted[slot]!]!;
            expect(out[slot * 4 + 3]! / dpr).toBeCloseTo(fireworkRadius(launch.height, zoom), 3);
            expect(display.appearance[slot * 2 + 1]! / dpr).toBeCloseTo(
              fireworkSparkWidth(launch.height, zoom),
              3,
            );
          }
        }
    }
    expect(fireworkRadius(150, 20) / fireworkRadius(150, 19)).toBeGreaterThan(2);
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
    const count = fireworkShells(panned, grid(panned), out, display, 10, true);
    expect(display.launches[0]).not.toBe(launch);
    for (let slot = 0; slot < count; slot++) {
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
