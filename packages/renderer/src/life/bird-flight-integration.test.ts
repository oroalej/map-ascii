import { describe, expect, it } from 'vitest';
import { BirdPose, BIRD_SPECIES } from './birds';
import { BIRD_FLIGHT, BIRD_POINTER } from './config';
import { birdFlightMargin } from './bird-flight';
import { birdFixture, birdLngLat, birdPerMeter, birdPoint, birdTile } from './testing/bird-fixture';
import { lngLatToTile } from '../raster/geometry';
import { completeScenarioState } from './testing/scenarios';

function flying(observer = true) {
  const f = birdFixture('swallow', { perch: false, observer });
  Object.assign(f.flock, birdPoint(20, 0), { hx: 1, hy: 0 });
  Object.assign(f.flock.birds[0]!, { ox: 0, oy: 0, phase: 0.1 });
  for (let i = 0; i < 3; i++) f.flock.birds.push({ ...f.flock.birds[0]! });
  return f;
}
const positions = (f: ReturnType<typeof flying>) =>
  f.visible().map((v) => lngLatToTile(birdTile, v.lng, v.lat));

describe('airborne pointer escape in the world', () => {
  it.each([30, 60, 120])('uses the same breakoff boundary at %s Hz', (rate) => {
    for (const inside of [true, false]) {
      const f = birdFixture('swallow', { roost: false });
      Object.assign(f.flock, birdPoint(0, 0));
      Object.assign(f.flock.birds[0]!, { ox: 0, oy: 0 });
      const reach = Math.max(BIRD_SPECIES.swallow.wary, BIRD_POINTER.cells * f.cellMeters(19));
      const margin = birdFlightMargin(BIRD_SPECIES.swallow.speed * 1.4, BIRD_FLIGHT);
      f.step(birdLngLat(reach + margin + (inside ? -0.01 : 0.01), 0), 1 / rate);
      expect(f.flock.birds[0]!.flight !== undefined).toBe(inside);
    }
  });
  it('replaces the shared shove with continuous individual flight paths', () => {
    const f = flying();
    const before = positions(f);
    const pointer = birdLngLat(20, 0);
    for (let frame = 0; frame < 30; frame++) {
      const previous = positions(f);
      f.step(pointer, 1 / 60);
      expect(f.flock.takeoff).toBeUndefined();
      const current = positions(f);
      expect(current).toHaveLength(4);
      for (const [i, at] of current.entries()) {
        const distance = Math.hypot(at.x - previous[i]!.x, at.y - previous[i]!.y) / birdPerMeter;
        expect(distance).toBeGreaterThan(0);
        expect(distance).toBeLessThanOrEqual(
          (BIRD_SPECIES.swallow.speed * 1.4 * BIRD_FLIGHT.flee * 1.15) / 60 + 1e-6,
        );
      }
      expect(f.visible().every((v) => v.bird?.pose !== BirdPose.perched)).toBe(true);
    }
    const displacements = positions(f).map((p, i) => [p.x - before[i]!.x, p.y - before[i]!.y]);
    expect(new Set(displacements.map((d) => d.map((n) => n.toFixed(4)).join(','))).size).toBe(4);
    expect(f.flock.scatter).toBe(0);
    for (let frame = 0; frame < 120; frame++) f.step(pointer, 1 / 60);
    const p = lngLatToTile(birdTile, ...pointer);
    const reach = Math.max(BIRD_SPECIES.swallow.wary, BIRD_POINTER.cells * f.cellMeters(19));
    for (const at of positions(f))
      expect(Math.hypot(at.x - p.x, at.y - p.y) / birdPerMeter).toBeGreaterThanOrEqual(reach);
  });

  it('rejoins the moving flock after the pointer leaves', () => {
    const f = flying();
    const identities = [...f.flock.birds];
    for (let i = 0; i < 60; i++) f.step(birdLngLat(20, 0), 1 / 60);
    expect(f.flock.flightBounds).toBeDefined();
    for (let i = 0; i < 1200 && f.flock.flightBounds; i++) f.step(undefined, 1 / 60);
    expect(f.flock.flightBounds).toBeUndefined();
    expect(f.flock.birds.every((b) => b.flight === undefined)).toBe(true);
    f.flock.birds.forEach((b, i) => expect(b).toBe(identities[i]));
  });

  it('clears every independent flight after a perch flush and rain shelter', () => {
    const f = birdFixture('pigeon', { roost: false });
    Object.assign(f.flock, birdPoint(50, 0), { perch: 0, perched: true });
    const first = f.flock.birds[0]!;
    f.flock.birds = Array.from({ length: 6 }, (_, i) => ({
      ...first,
      ox: 3 * birdPerMeter * Math.cos(i),
      oy: 3 * birdPerMeter * Math.sin(i),
      phase: i / 6,
    }));
    for (let frame = 0; frame < 60; frame++) f.step(birdLngLat(49, 0), 1 / 60);
    expect(f.flock.flightBounds).toBeDefined();
    for (let frame = 0; frame < 30 * 60 && (!f.flock.perched || f.flock.flightBounds); frame++)
      f.step(undefined, 1 / 60, 19, { rain: 1 });
    expect(f.flock.perched).toBe(true);
    expect(f.flock.birds.every((bird) => bird.flight === undefined)).toBe(true);
    expect(f.flock.flightBounds).toBeUndefined();
  });

  it('freezes individual flights while the tile is retired, and resumes them on revival', () => {
    const f = flying();
    f.step(birdLngLat(20, 0), 1 / 60);
    const before = structuredClone(f.flock);
    f.world.sync([]);
    for (let i = 0; i < 20; i++) f.step();
    expect(f.flock).toEqual(before);
    f.world.sync([f.entry]);
    f.step();
    expect(f.flock.birds[0]!.flight).not.toEqual(before.birds[0]!.flight);
  });

  it('keeps independent birds visible when the navigation anchor leaves the view', () => {
    const f = flying();
    f.step(birdLngLat(20, 0), 1 / 60);
    Object.assign(f.flock, birdPoint(1000, 1000));
    const a = birdLngLat(15, 5),
      b = birdLngLat(25, -5);
    const views = f.world.visible(19, 1, f.center, undefined, [a[0], a[1], b[0], b[1]]);
    expect(views.filter((v) => v.kind === 'bird')).toHaveLength(4);
  });

  it('keeps complete airborne flock state identical with emoji observation disabled', () => {
    const on = flying(),
      off = flying(false);
    for (let frame = 0; frame < 300; frame++) {
      const pointer = frame < 120 ? birdLngLat(20, 0) : undefined;
      on.step(pointer, 1 / 60);
      off.step(pointer, 1 / 60);
      expect(completeScenarioState(on.world)).toEqual(completeScenarioState(off.world));
    }
  });
});
