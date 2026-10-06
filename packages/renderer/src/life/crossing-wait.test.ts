import { expect, it, vi } from 'vitest';
import {
  CrossingReservations,
  CrossingWaits,
  type WaitingPose,
  type CrossingCursor,
} from './crossing-wait';
import { finalizeControlledCrossings } from './crossing-geometry';
import { LifeBuilder, type ControlledCrossingAnchor } from './geometry';
import { RoadAccess, stripRing } from './terrain';
import { bodyCorners, bodiesOverlap, type Body } from './occupancy';
import { pedestrianState } from './signals';
import type { GroundAgent, Mover } from './simulate';

const phase = (value: 'walk' | 'flash' | 'dont') =>
  Array.from({ length: 2000 }, (_, i) => i / 10).find(
    (t) => pedestrianState(7, t, false, 'a') === value,
  )!;
const mover = (count = 1): Mover => ({
  kind: 'person',
  line: 0,
  from: 0,
  dir: 1,
  d: 0,
  speed: 1,
  paint: 0,
  lane: 0,
  pause: 0,
  rank: 0,
  x: 0,
  y: -7,
  hx: 0,
  hy: 1,
  group: Array.from({ length: count }, (_, i) => ({
    figure: 'adult',
    shirt: 0,
    umbrella: 0,
    canopy: 0,
    lateral: ((i % 2) - 0.5) * 1.2,
    back: Math.floor(i / 2),
    step: 0,
  })),
});
const bodies = (
  owner: GroundAgent,
  minimum = 0,
  natural = false,
  cursor: CrossingCursor = owner,
): Body[] => {
  if (!('kind' in owner)) return [];
  return (owner.group ?? []).map((w, i) => {
    const p = natural ? undefined : owner.crossingWait?.waiting?.poses[i];
    return {
      x: cursor.x + (p?.x ?? -cursor.hy * w.lateral - cursor.hx * w.back),
      y: cursor.y + (p?.y ?? cursor.hx * w.lateral - cursor.hy * w.back),
      hx: p?.hx ?? cursor.hx,
      hy: p?.hy ?? cursor.hy,
      length: Math.max(0.9, minimum),
      width: Math.max(1, minimum),
    };
  });
};
function fixture(id = 'cross', sample = bodies) {
  const crossing: ControlledCrossingAnchor = {
    id,
    anchor: { x: 0, y: 0 },
    bearing: 90,
    width: 10,
    lineId: 42,
    controller: { id: 'signal', at: [0, 0], seed: 7, midBlock: false, walk: 'a' },
  };
  const roads = [[stripRing({ x: -100, y: 0 }, { x: 100, y: 0 }, 5)]];
  finalizeControlledCrossings([crossing], roads, 1);
  const geo = new LifeBuilder().finish();
  geo.controlledCrossings = [crossing];
  return new CrossingWaits(geo, 1, sample, new RoadAccess(roads, []), (owner, minimum) => {
    if (!('kind' in owner)) return 0;
    return (
      Math.max(0, ...(owner.group ?? []).map((w) => Math.hypot(w.lateral, w.back))) +
      Math.hypot(Math.max(0.9, minimum), Math.max(1, minimum)) / 2
    );
  });
}

it('validates unknown wait payloads even when no crossing records exist', () => {
  const owner = mover();
  const source = fixture();
  const before = { ...owner };
  owner.y += source.limit(owner, { x: 0, y: 20 }, 30, phase('dont'));
  source.accept(owner, before, phase('dont'), 0, 0);
  expect(owner.crossingWait?.waiting).toBeDefined();
  const empty = new CrossingWaits(new LifeBuilder().finish(), 1, bodies, new RoadAccess([], []));
  expect(empty.prepare(owner, undefined)).not.toBeNull();
  expect(empty.permits(owner, undefined, phase('dont'))).toBe(false);
  expect(empty.prepare({ ...owner, crossingWait: undefined }, undefined)).toBeNull();
});

it('projects natural bodies only when a waiting cohort starts releasing', () => {
  const sample = vi.fn(bodies),
    waits = fixture('cross', sample),
    m = mover(2);
  const before = { ...m };
  m.y += waits.limit(m, { x: 0, y: 20 }, 30, phase('dont'));
  waits.accept(m, before, phase('dont'));
  waits.registry.resolve();
  sample.mockClear();
  waits.tick(m, 0.1, phase('dont'), 0, () => true);
  expect(sample).not.toHaveBeenCalled();
  waits.tick(m, 0.1, phase('walk'), 0, () => true);
  expect(sample).toHaveBeenCalledExactlyOnceWith(m, 0, true);
});

it('probes complete swept bounds before building bodies for distant or held walkers', () => {
  const sample = vi.fn(bodies),
    waits = fixture('cross', sample),
    m = mover(4);
  m.x = 200;
  expect(waits.limit(m, { x: 200, y: 20 }, 30, phase('dont'), 3)).toBe(30);
  expect(sample).not.toHaveBeenCalled();
  m.x = 0;
  m.y = -40;
  const cap = waits.limit(m, { x: 0, y: 40 }, 80, phase('dont'), 3);
  expect(cap).toBeLessThan(40);
  expect(sample).toHaveBeenCalledTimes(1);
  m.y += cap;
  waits.accept(m, { ...m, y: -40 }, phase('dont'), 3);
  sample.mockClear();
  expect(waits.limit(m, { x: 0, y: 40 }, 30, phase('dont'), 3)).toBe(0);
  expect(sample).not.toHaveBeenCalled();
  const rotated = mover(4);
  rotated.x = 20;
  rotated.y = -7;
  rotated.hx = 1;
  rotated.hy = 0;
  rotated.group![0]!.back = 20;
  expect(waits.limit(rotated, { x: 20, y: 20 }, 30, phase('dont'), 3)).toBeLessThan(30);
});
it('clamps complete cohorts at the curb and gates unrelated scene routes without latching the expanded cut', () => {
  const waits = fixture(),
    m = mover(4),
    clock = phase('dont');
  m.line = 99;
  const distance = waits.limit(m, { x: 0, y: 20 }, 30, clock);
  expect(distance).toBeCloseTo(1.54);
  m.y += distance;
  waits.accept(m, { ...m, y: -7 }, clock);
  expect(m.crossingWait?.commitments).toEqual([]);
  expect(m.crossingWait?.waiting).toBeDefined();
  expect(bodies(m).every((b) => bodyCorners(b).every((p) => p.y <= -5))).toBe(true);
  const inside = { ...m, crossingWait: undefined, y: -4 };
  expect(waits.permits(inside, undefined, phase('flash'))).toBe(false);
});
it('commits only an accepted walk entry and keeps the whole cohort until its last body clears', () => {
  const waits = fixture(),
    m = mover(4),
    before = { ...m };
  m.y = -4;
  expect(waits.permits(m, before, phase('walk'))).toBe(true);
  // A rejected physical trial never calls accept, so no phase latch exists.
  expect(m.crossingWait).toBeUndefined();
  waits.accept(m, before, phase('walk'));
  expect(m.crossingWait?.commitments).toHaveLength(1);
  expect(waits.limit(m, { x: 0, y: 20 }, 20, phase('dont'))).toBe(20);
  m.y = 5.5;
  waits.accept(m, before, phase('dont'));
  expect(m.crossingWait?.commitments).toHaveLength(1);
  m.y = 6.5;
  waits.accept(m, before, phase('dont'));
  expect(m.crossingWait).toBeUndefined();
});
it('eases immutable poses into compatible slots, rolls back rejection, and releases in slot order', () => {
  const waits = fixture(),
    m = mover(2),
    original = structuredClone(m.group),
    clock = phase('dont');
  m.y += waits.limit(m, { x: 0, y: 20 }, 30, clock);
  waits.accept(m, { ...m, y: -7 }, clock);
  waits.registry.resolve();
  const state = m.crossingWait;
  waits.tick(m, 0.1, clock, 0, () => false);
  expect(m.crossingWait).toBe(state);
  for (let i = 0; i < 8; i++)
    waits.tick(m, 0.1, clock, 0, (owner, before) => {
      if (!waits.permits(owner, before, clock)) return false;
      waits.accept(owner, before, clock);
      return true;
    });
  expect(m.group).toEqual(original);
  expect(m.crossingWait?.waiting?.slots).toEqual([0, 1]);
  expect(m.crossingWait?.waiting?.age).toBeCloseTo(0.8);
  const request = vi.spyOn(waits.registry, 'request');
  waits.accept(m, structuredClone(m), clock);
  expect(request).not.toHaveBeenCalled();
  const bs = bodies(m);
  expect(bodiesOverlap(bs[0]!, bs[1]!, 0.15)).toBe(false);
  expect(waits.limit(m, { x: 0, y: 20 }, 20, phase('walk'))).toBe(0);
  waits.tick(m, 0.1, phase('walk'), 0, () => true);
  expect(m.crossingWait?.waiting?.releasing).toBe(true);
  expect(waits.limit(m, { x: 0, y: 20 }, 20, phase('walk'))).toBe(20);
  const beforeRelease = structuredClone(m);
  m.y += 2;
  waits.accept(m, beforeRelease, phase('walk'));
  expect(m.crossingWait?.waiting?.slots).toHaveLength(2);
  expect(m.crossingWait?.commitments).toHaveLength(1);
  expect(waits.permits({ ...m }, undefined, phase('walk'))).toBe(true);
});
it('uses collision-safe geographic keys and preserves stable clipped slot ids', () => {
  const registry = new CrossingReservations();
  expect(registry.empty).toBe(true);
  const wait = (id: string, side: number, index: number): WaitingPose => ({
    id,
    side,
    index,
    owner: `owner:${index}`,
    arrival: 0,
    slots: [],
    activeSlots: [],
    age: 0,
    releasing: false,
    poses: [],
    start: [],
  });
  registry.request(wait('a:1', 2, 3), 2, [0, 1, 2, 3]);
  expect(registry.empty).toBe(false);
  registry.retain(new Set(['owner:3']));
  expect(registry.snapshot().requests).toHaveLength(1);
  registry.request(wait('a', 12, 2), 2, [0, 1, 2, 3]);
  registry.request(wait('a:1', 2, 1), 2, [0, 1, 2, 3]);
  registry.resolve();
  expect(registry.claim('owner:1')?.slots).toEqual([0, 1]);
  expect(registry.claim('owner:3')?.slots).toEqual([2, 3]);
  expect(registry.claim('owner:2')?.slots).toEqual([0, 1]);
  expect(registry.canDepart(wait('a:1', 2, 3))).toBe(false);
  registry.release('owner:1');
  expect(registry.canDepart(wait('a:1', 2, 3))).toBe(true);
  registry.retain(new Set(['owner:2']));
  expect(registry.snapshot().claims).toHaveLength(1);
  registry.retain(new Set());
  expect(registry.empty).toBe(true);
});
it('retains a safe upstream footprint when coarse bodies cannot fit any slot', () => {
  const waits = fixture(),
    m = mover();
  m.y = -8;
  m.y += waits.limit(m, { x: 0, y: 20 }, 30, phase('dont'), 3);
  waits.accept(m, { ...m, y: -8 }, phase('dont'), 3);
  waits.registry.resolve();
  expect(waits.registry.snapshot().claims).toHaveLength(0);
  expect(m.crossingWait?.waiting?.slots).toEqual([]);
  expect(bodies(m, 3).every((b) => bodyCorners(b).every((p) => p.y <= -5))).toBe(true);
});

it('shares whole swept trials and resolves queue order only when a waiter is created', () => {
  const waits = fixture(),
    m = mover(),
    index = vi.fn(() => 17);
  m.x = 200;
  const trial = waits.prepare(m, { ...m, x: 199 });
  expect(trial).toBeNull();
  expect(waits.permits(m, undefined, phase('dont'), 0, trial)).toBe(true);
  waits.accept(m, undefined, phase('dont'), 0, index, trial);
  expect(index).not.toHaveBeenCalled();
  m.x = 0;
  const before = { ...m };
  m.y += waits.limit(m, { x: 0, y: 20 }, 30, phase('dont'));
  const stopped = waits.prepare(m, before);
  expect(waits.permits(m, before, phase('dont'), 0, stopped)).toBe(true);
  waits.accept(m, before, phase('dont'), 0, index, stopped);
  expect(index).toHaveBeenCalledTimes(1);
  expect(m.crossingWait?.waiting?.index).toBe(17);
  waits.accept(m, before, phase('dont'), 0, index);
  expect(index).toHaveBeenCalledTimes(1);
  const crossing = { ...m, crossingWait: undefined, y: 40 };
  const swept = waits.prepare(crossing, { ...crossing, y: -40 }, 3);
  expect(waits.permits(crossing, { ...crossing, y: -40 }, phase('dont'), 3, swept)).toBe(false);
});
