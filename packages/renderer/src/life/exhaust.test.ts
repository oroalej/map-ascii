import { describe, expect, it } from 'vitest';
import {
  emitter,
  exhaustKind,
  PUFF,
  PuffStore,
  stepEmitter,
  puffGlyph,
  type PuffKind,
} from './exhaust';

function replay(hz: number, kind: PuffKind = 'diesel', idle = false) {
  const state = emitter(42, 0);
  const events: { at: number; life: number; spread: number }[] = [];
  const store = new PuffStore();
  const speed = (t: number) => (idle ? 0 : Math.max(0, Math.min(2, (t - 2) * 2)));
  for (let frame = 1; frame <= hz * (idle ? 18 : 5); frame++) {
    const clock = frame / hz;
    store.advance(clock, 1 / hz, { dir: [1, 0], strength: 1 }, 1);
    stepEmitter(
      state,
      kind,
      speed((frame - 1) / hz),
      speed(clock),
      clock,
      1 / hz,
      (at, life, spread) => {
        events.push({ at, life, spread });
        // Identical accepted pose histories: exact birth position and partial-frame advection.
        store.add({
          sourceId: 1,
          x: (PUFF.drift + spread) * (clock - at),
          y: 0,
          t0: at,
          life,
          vx: spread,
          vy: 0,
          hx: 1,
          hy: 0,
          kind,
          vehicle: 'bus',
        });
      },
    );
  }
  return { events, puffs: store.snapshot(idle ? 18 : 5), state };
}

describe('exhaust scheduling', () => {
  it('limits exhaust to the illustrative diesel and small-engine fleet', () => {
    for (const v of ['bus', 'truck', 'jeepney'] as const) expect(exhaustKind(v)).toBe('diesel');
    for (const v of ['tricycle', 'motorcycle'] as const) expect(exhaustKind(v)).toBe('twoStroke');
    for (const v of ['car', 'bicycle', 'motorboat', 'locomotive', 'cart'] as const)
      expect(exhaustKind(v)).toBeUndefined();
  });
  it('emits 2–4 pull-away puffs and half as many for smaller engines', () => {
    const diesel = replay(60).events,
      small = replay(60, 'twoStroke').events;
    expect(diesel.length).toBeGreaterThanOrEqual(2);
    expect(diesel.length).toBeLessThanOrEqual(4);
    expect(small).toHaveLength(Math.ceil(diesel.length / 2));
    expect(diesel.at(-1)!.at - diesel[0]!.at).toBeCloseTo(PUFF.pullAway.window);
    expect(diesel[0]!.at).toBeCloseTo(2.25);
  });
  it('uses 3–6 second idle intervals, doubled for smaller engines', () => {
    for (const kind of ['diesel', 'twoStroke'] as const) {
      const events = replay(60, kind, true).events;
      expect(events.length).toBeGreaterThan(0);
      for (const [i, e] of events.entries()) {
        const gap = e.at - (events[i - 1]?.at ?? 0);
        expect(gap).toBeGreaterThanOrEqual(3 * (kind === 'diesel' ? 1 : 2));
        expect(gap).toBeLessThanOrEqual(6 * (kind === 'diesel' ? 1 : 2));
      }
    }
  });
  it('does not puff during uninterrupted cruising or after a brief stop', () => {
    const state = emitter(0, 0),
      events: number[] = [];
    for (let i = 1; i <= 100; i++)
      stepEmitter(state, 'diesel', 2, 2, i / 10, 0.1, (at) => events.push(at));
    expect(events).toEqual([]);
    stepEmitter(state, 'diesel', 0, 0, 10.1, 0.1, (at) => events.push(at));
    stepEmitter(state, 'diesel', 0, 1, 10.2, 0.1, (at) => events.push(at));
    expect(events).toEqual([]);
  });
  it('has matching schedules and positions across 30/60/120 Hz accepted histories', () => {
    for (const idle of [false, true])
      for (const kind of ['diesel', 'twoStroke'] as const) {
        const a = replay(30, kind, idle);
        for (const hz of [60, 120]) {
          const b = replay(hz, kind, idle);
          expect(b.events.length).toBe(a.events.length);
          b.events.forEach((e, i) => {
            expect(e.at).toBeCloseTo(a.events[i]!.at, 8);
            expect(e.life).toBe(a.events[i]!.life);
            expect(e.spread).toBe(a.events[i]!.spread);
          });
          expect(b.puffs.length).toBe(a.puffs.length);
          b.puffs.forEach((p, i) => expect(p.x).toBeCloseTo(a.puffs[i]!.x, 6));
        }
      }
  });
  it('rebases inactive emitters without accumulating catch-up puffs', () => {
    const state = replay(30, 'diesel', true).state;
    const events: number[] = [];
    stepEmitter(state, 'diesel', 0, 0, 100, 0.1, (at) => events.push(at));
    expect(events).toEqual([]);
    expect(state.stopped).toBeCloseTo(18.1);
  });
});

describe('puff ring', () => {
  it('is bounded, overwrites insertion-oldest, drifts, expires, and does not revive', () => {
    const store = new PuffStore();
    for (let i = 0; i < PUFF.cap + 10; i++)
      store.add({
        sourceId: 1,
        x: i,
        y: 0,
        t0: 0,
        life: 2,
        vx: 0,
        vy: 0,
        hx: 1,
        hy: 0,
        kind: 'diesel',
        vehicle: 'bus',
      });
    expect(store.snapshot(0)).toHaveLength(PUFF.cap);
    expect(Math.min(...store.snapshot(0).map((p) => p.x))).toBe(10);
    store.advance(1, 1, { dir: [1, 0], strength: 1 }, 2);
    expect(Math.min(...store.snapshot(1).map((p) => p.x))).toBeCloseTo(11.2);
    expect(store.snapshot(3)).toEqual([]);
    store.advance(3, 1, undefined, 2);
    expect(store.snapshot(3)).toEqual([]);
  });
  it('uses the diminishing glyph ramp', () => {
    expect([0, 0.4, 0.9].map(puffGlyph)).toEqual(['°', '∘', '·']);
  });
  it('freezes particle age while its tile is retired', () => {
    const store = new PuffStore();
    store.advance(1, 0.1, undefined, 1);
    store.add({
      sourceId: 1,
      x: 0,
      y: 0,
      t0: 1,
      life: 2,
      vx: 0.2,
      vy: 0,
      hx: 1,
      hy: 0,
      kind: 'diesel',
      vehicle: 'bus',
    });
    store.advance(11.1, 0.1, undefined, 1);
    const [p] = store.snapshot(11.1);
    expect(p!.t0).toBeCloseTo(11);
    expect(p!.x).toBeCloseTo(0.02);
    store.advance(13.1, 2, undefined, 1);
    expect(store.snapshot(13.1)).toEqual([]);
  });
});
