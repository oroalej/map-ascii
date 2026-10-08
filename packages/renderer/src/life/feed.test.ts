import { expect, it, vi } from 'vitest';
import { feedSpot, feedCrumbs, type TapPointer } from './feed';
import { birdFixture, birdLngLat, birdPoint } from './testing/bird-fixture';
import type { LifeTap } from './tap';
import { PERCH } from './config';

function fixture(pointer = 'touch', at = birdLngLat(0, 0)) {
  const f = birdFixture('pigeon', { fullFlock: true });
  f.world.enableTaps();
  f.world.visible(19, 1, f.center);
  const tap: LifeTap = {
    id: 1,
    generation: 1,
    frame: f.world.tapSources!.frame,
    at,
    pointer,
    pointerRevision: 1,
    cellMeters: f.cellMeters(19),
  };
  const act = (t: LifeTap = tap) =>
    f.world.step(
      0,
      undefined,
      19,
      undefined,
      undefined,
      { rain: 0 },
      tap.cellMeters,
      1.8,
      tap.cellMeters,
      undefined,
      [t],
    );
  const step = (pointer?: readonly [number, number], activity?: TapPointer, dt = 0.1) =>
    f.world.step(
      dt,
      undefined,
      19,
      undefined,
      undefined,
      { rain: 0 },
      tap.cellMeters,
      1.8,
      tap.cellMeters,
      pointer,
      undefined,
      activity,
    );
  return { ...f, tap, act, step };
}
it('flushes a tapped perched flock with captured takeoff and no bird or forage RNG draws', () => {
  const f = fixture('touch', birdLngLat(50, 0));
  Object.assign(f.flock, birdPoint(50, 0), { perched: true, perch: 0 });
  const bird = vi.fn(() => 0.5),
    forage = vi.fn(() => 0.5);
  Object.assign(f.life, { birdRng: bird, forageRng: forage });
  f.act({ ...f.tap, firework: true });
  expect(f.world.tapReceipts).toEqual([{ id: 1, action: 'tree' }]);
  expect(f.flock.perched).toBe(false);
  expect(f.flock.scatter).toBe(PERCH.scatter);
  expect(f.flock.takeoff?.x).toBe(birdPoint(50, 0).x);
  expect(f.life.startled).toContain(f.flock);
  expect(f.life.tapFeed).toBeUndefined();
  expect(bird).not.toHaveBeenCalled();
  expect(forage).not.toHaveBeenCalled();
});
it('prepares a bounded deterministic feed layout without using ordinary forage RNG', () => {
  const f = fixture();
  const bird = vi.fn(() => 0.5),
    forage = vi.fn(() => 0.5);
  Object.assign(f.life, { birdRng: bird, forageRng: forage });
  f.act();
  expect(f.world.tapReceipts).toEqual([{ id: 1, action: 'rice' }]);
  expect(f.life.prepareFeedLanding(f.flock, birdPoint(0, 0))).toBe(true);
  expect(f.flock.landing).toBe(true);
  expect(f.flock.birds.every((b) => Number.isFinite(b.gx) && Number.isFinite(b.gy))).toBe(true);
  expect(bird).not.toHaveBeenCalled();
  expect(forage).not.toHaveBeenCalled();
  const calls: { x: number; y: number }[] = [];
  expect(
    feedSpot({ x: 0, y: 0 }, 2, (p) => {
      calls.push(p);
      return p.x > 0.5;
    }),
  ).toBeDefined();
  expect(calls.length).toBeLessThanOrEqual(8);
  expect(calls.every((p) => Math.hypot(p.x, p.y) <= 2 + 1e-9)).toBe(true);
});
it('holds mouse feed through pointerdown clearing until a new hover is outside reach', () => {
  const f = fixture('mouse');
  f.act();
  for (let i = 0; i < 20; i++) f.step();
  expect(f.life.tapFeed?.inhibited).toBe(true);
  expect(f.flock.landing || f.flock.landed).toBe(false);
  f.step(birdLngLat(0, 0), { revision: 2, left: false });
  expect(f.life.tapFeed?.inhibited).toBe(true);
  f.step(birdLngLat(100, 0), { revision: 3, left: false });
  expect(f.life.tapFeed?.inhibited).toBe(false);
  for (let i = 0; i < 100 && !f.flock.landing; i++)
    f.step(birdLngLat(100, 0), { revision: 3, left: false });
  expect(f.flock.landing).toBe(true);
});
it('releases mouse feed on leave, starts touch feed immediately, and renewed proximity flushes it', () => {
  const mouse = fixture('mouse');
  mouse.act();
  mouse.step(undefined, { revision: 2, left: true });
  expect(mouse.flock.landing).toBe(true);
  const touch = fixture();
  touch.act();
  touch.step();
  expect(touch.flock.landing).toBe(true);
  touch.step(birdLngLat(0, 0), { revision: 2, left: false });
  expect(touch.flock.landing).toBe(false);
  expect(touch.flock.scatter).toBeGreaterThan(0);
});
it('draws three to five guarded crumbs, expires the feed and clears it on reset', () => {
  const f = fixture();
  f.act();
  const crumbs = () =>
    f.world.visible(19, 1, f.center).filter((a) => a.prop === 'event' && a.glyph === '.');
  expect(crumbs().length).toBeGreaterThanOrEqual(3);
  expect(crumbs().length).toBeLessThanOrEqual(5);
  expect(feedCrumbs(12)).toEqual(feedCrumbs(12));
  f.step(undefined, undefined, 20.1);
  expect(crumbs()).toEqual([]);
  expect(f.life.tapFeed).toBeUndefined();
  f.world.clearTiles();
  f.world.sync([f.entry]);
  expect(f.world.resident(f.entry.key)?.tapFeed).toBeUndefined();
});
it('a chosen firework never creates rice and an exhausted placement search has eight candidates', () => {
  const f = fixture();
  f.act({ ...f.tap, firework: true });
  expect(f.life.tapFeed).toBeUndefined();
  const valid = vi.fn(() => false);
  expect(feedSpot({ x: 0, y: 0 }, 2, valid)).toBeUndefined();
  expect(valid).toHaveBeenCalledTimes(8);
});
