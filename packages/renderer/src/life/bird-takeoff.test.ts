import { describe, expect, it } from 'vitest';
import { BIRD_SPECIES, BirdPose } from './birds';
import { BIRD_POINTER, BIRD_TAKEOFF } from './config';
import { birdFixture, birdLngLat, birdPoint, birdPerMeter, birdTile } from './testing/bird-fixture';
import { lngLatToTile, tileToLngLat } from '../raster/geometry';

function sitting(ground = false) {
  const f = birdFixture();
  Object.assign(f.flock, birdPoint(50, 0), {
    perched: !ground,
    landed: ground,
    perch: ground ? -1 : 0,
  });
  const first = f.flock.birds[0]!;
  // Equal phases exercise independent slot timing as well as the usual seeded variation.
  for (let i = 1; i < 4; i++) f.flock.birds.push({ ...first, ox: (2 + i) * birdPerMeter });
  if (ground)
    for (const [i, bird] of f.flock.birds.entries())
      Object.assign(bird, {
        gx: i * birdPerMeter,
        gy: 0,
        tx: i * birdPerMeter,
        ty: 0,
        face: i,
        wait: 10,
      });
  return f;
}

const positions = (f: ReturnType<typeof sitting>) =>
  f.visible().map((view) => lngLatToTile(birdTile, view.lng, view.lat));

describe('individual pointer takeoffs', () => {
  it('keeps flying birds moving when the mouse cancels their target', () => {
    const f = birdFixture('maya');
    f.flock.perch = 0;
    f.flock.birds[0]!.phase = 0.4;
    f.flock.birds.push({ ...f.flock.birds[0]!, phase: 0.8 });
    let before = positions(f);
    for (let frame = 0; frame < 20; frame++) {
      f.step(birdLngLat(50, 0), 1 / 60);
      expect(f.flock.takeoff).toBeUndefined();
      expect(f.flock.birds.every((bird) => bird.takeoff === undefined)).toBe(true);
      const after = positions(f);
      for (const [i, at] of after.entries())
        expect(Math.hypot(at.x - before[i]!.x, at.y - before[i]!.y)).toBeGreaterThan(1e-6);
      before = after;
    }
    expect(f.flock.perch).toBe(-1);
  });

  it.each([false, true])('preserves each resting position at the flush (ground=%s)', (ground) => {
    const f = sitting(ground);
    const before = positions(f);
    f.step(birdLngLat(50, 0), 1 / 60);
    expect(f.flock.perched || f.flock.landed).toBe(false);
    const after = positions(f);
    for (const [i, p] of after.entries()) {
      expect(p.x).toBeCloseTo(before[i]!.x, 6);
      expect(p.y).toBeCloseTo(before[i]!.y, 6);
    }
    expect(f.visible().every((view) => view.bird?.pose === BirdPose.perched)).toBe(true);
  });

  it('staggered birds accelerate independently instead of sharing a translation', () => {
    const f = sitting();
    const pointer = birdLngLat(50, 0);
    const before = positions(f);
    f.step(pointer, 1 / 60);
    f.step(pointer, 1 / 60);
    const after = positions(f);
    expect(Math.hypot(after[0]!.x - before[0]!.x, after[0]!.y - before[0]!.y)).toBeGreaterThan(0);
    expect(after[1]!.x).toBeCloseTo(before[1]!.x, 6);
    expect(after[1]!.y).toBeCloseTo(before[1]!.y, 6);
    expect(f.visible()[0]!.bird?.pose).not.toBe(BirdPose.perched);
    expect(f.visible()[1]!.bird?.pose).toBe(BirdPose.perched);
    for (let i = 0; i < 12; i++) f.step(pointer, 1 / 60);
    const moving = positions(f);
    const displacements = moving.map((p, i) => Math.hypot(p.x - before[i]!.x, p.y - before[i]!.y));
    expect(new Set(displacements.map((d) => d.toFixed(3))).size).toBe(4);
  });

  it.each([true, false])(
    'uses active takeoff positions for pointer clearance (inside=%s)',
    (inside) => {
      const control = sitting();
      const f = sitting();
      for (const fixture of [control, f]) {
        fixture.step(birdLngLat(50, 0), 1 / 60);
        for (let i = 0; i < 12; i++) fixture.step(birdLngLat(50, 0), 1 / 60);
        expect(fixture.flock.takeoff).toBeDefined();
      }
      // Sample the normal movement at this age, then put the mouse either side of its
      // clearance boundary. The response must include birds still catching up from rest.
      control.step(undefined, 1 / 60);
      const extent = Math.max(
        ...positions(control).map((p) => Math.hypot(p.x - control.flock.x, p.y - control.flock.y)),
      );
      const reach =
        Math.max(BIRD_SPECIES.pigeon.wary, BIRD_POINTER.cells * f.cellMeters(19)) * birdPerMeter;
      const pointer = tileToLngLat(birdTile, {
        x: control.flock.x + reach + extent + (inside ? -0.01 : 0.01) * birdPerMeter,
        y: control.flock.y,
      });
      f.step(pointer, 1 / 60);
      expect(f.flock.takeoff).toBeDefined();
      if (inside) expect(f.flock.x).toBeLessThan(control.flock.x);
      else expect(f.flock.x).toBeCloseTo(control.flock.x, 8);
      expect(f.flock.y).toBeCloseTo(control.flock.y, 8);
    },
  );

  it('bounds the longest individual takeoff below one second', () => {
    expect(BIRD_TAKEOFF.stagger + BIRD_TAKEOFF.seconds[1]).toBeLessThan(1);
  });

  it.each([true, false])('finishes takeoff after mouse departure (keep pointer=%s)', (keep) => {
    const f = sitting();
    const pointer = birdLngLat(50, 0);
    f.step(pointer, 1 / 60);
    for (let i = 0; i < 120; i++) f.step(keep ? pointer : undefined, 1 / 60);
    expect(f.flock.takeoff).toBeUndefined();
    expect(f.flock.birds.every((bird) => bird.takeoff === undefined)).toBe(true);
    expect(f.visible().every((view) => view.bird?.pose !== BirdPose.perched)).toBe(true);
    if (keep) {
      const p = lngLatToTile(birdTile, ...pointer);
      for (const at of positions(f))
        expect(Math.hypot(at.x - p.x, at.y - p.y) / birdPerMeter).toBeGreaterThanOrEqual(
          BIRD_POINTER.cells * f.cellMeters(19),
        );
    }
  });
});
