import { describe, expect, it } from 'vitest';
import type { DialogueChoice, GreetingPeriods } from '@atlas/shared';
import { Moments, MOMENTS, type MomentActor, type MomentContext, type MomentKind } from './moments';

function fixture(
  kind: MomentKind,
  rng: () => number = () => 0,
  dialogue: readonly DialogueChoice[] = [],
  periods?: GreetingPeriods,
) {
  const a: MomentActor = {
    owner: {},
    type: kind === 'talk' || kind === 'ball' ? 'gatherer' : 'walker',
    x: 0,
    y: 0,
    hx: 1,
    hy: 0,
    figure: kind === 'ball' ? 'child' : 'adult',
    idle: kind !== 'greet',
    place: kind === 'ball' ? 'pitch' : 'monument',
    source: 0,
  };
  const b: MomentActor = { ...a, owner: {}, x: kind === 'greet' ? 2 : 6, hx: -1 };
  const actors = kind === 'look' ? [a] : [a, b];
  const facing = new Map<object, [number, number]>();
  const releases: object[] = [];
  const c: MomentContext = {
    zoom: 21,
    rain: 0,
    perMeter: 1,
    actors: () => actors,
    anchors: kind === 'look' ? [{ x: 8, y: 0, source: 0 }] : [],
    eligible: () => true,
    clearance: () => 0.5,
    face: (actor, hx, hy) => {
      facing.set(actor.owner, [hx, hy]);
      return true;
    },
    release: (actor) => {
      releases.push(actor.owner);
      facing.delete(actor.owner);
    },
  };
  return { a, b, actors, c, facing, releases, m: new Moments(42, true, rng, dialogue, periods) };
}
const start = (f: ReturnType<typeof fixture>, kind: MomentKind) => {
  for (let i = 0; i < 20 && !f.m.stats.started[kind]; i++) f.m.step(0.1, f.c);
  expect(f.m.stats.started[kind]).toBe(1);
};

describe('small human moments', () => {
  const reaction = [{ id: 'monument-reaction', kind: 'look', turns: 1 }] as const;
  const visitor = () => {
    const f = fixture('look', () => 0.99, reaction);
    f.a.type = 'gatherer';
    return f;
  };
  it('admits an existing monument visit promptly despite unrelated walkers in the tile', () => {
    const f = visitor();
    f.actors.unshift(
      ...Array.from({ length: 50 }, (_, i): MomentActor => ({
        ...f.a,
        owner: {},
        type: 'walker',
        x: 100 + i * 20,
      })),
    );
    f.m.step(0.1, f.c);
    expect(f.m.speech(f.a.owner)?.exchangeId).toBe('monument-reaction');
    expect(f.m.stats.checks).toBeLessThanOrEqual(MOMENTS.checks);
  });
  it('lets separated monument visitors react to their own monument without a chance roll', () => {
    const f = visitor();
    f.b.type = 'gatherer';
    f.b.x = 9.16;
    f.actors.push(f.b);
    f.c.anchors = [
      { x: -1, y: 0, source: 99 },
      { x: 4.58, y: 0, source: 0 },
    ];
    f.m.step(0.1, f.c);
    expect(f.m.stats.started.look).toBe(2);
    expect(f.m.stats.started.talk).toBe(0);
    expect(f.facing.get(f.a.owner)).toEqual([1, 0]);
    expect(f.facing.get(f.b.owner)).toEqual([-1, 0]);
    for (const a of f.actors)
      expect(f.m.speech(a.owner)).toMatchObject({ exchangeId: 'monument-reaction', line: 0 });
    f.m.step(3, f.c);
    expect(f.m.speech(f.a.owner)).toBeUndefined();
  });
  it('requires a new idle episode and the completed reaction cooldown before speaking again', () => {
    const f = visitor();
    start(f, 'look');
    f.m.step(10, f.c);
    f.m.step(61, f.c);
    expect(f.m.stats.started.look).toBe(1);
    f.a.idle = false;
    f.m.step(0.1, f.c);
    f.a.idle = true;
    f.m.step(0.1, f.c);
    expect(f.m.stats.started.look).toBe(2);
    f.m.step(10, f.c);
    f.a.idle = false;
    f.m.step(0.1, f.c);
    f.a.idle = true;
    f.m.step(59, f.c);
    expect(f.m.stats.started.look).toBe(2);
    f.m.step(1, f.c);
    expect(f.m.stats.started.look).toBe(3);
  });
  it('retries visitor facing within the shared budget and discards a moving visitor retry', () => {
    for (const leaves of [false, true]) {
      const f = visitor();
      let attempts = 0;
      f.c.face = () => ++attempts > 1;
      f.m.step(0.1, f.c);
      expect(f.m.speech(f.a.owner)).toBeUndefined();
      expect(f.m.snapshot().pending).toHaveLength(1);
      f.a.idle = !leaves;
      for (let i = 0; i < 10; i++) {
        const checks = f.m.stats.checks;
        f.m.step(0.1, f.c);
        expect(f.m.stats.checks - checks).toBeLessThanOrEqual(MOMENTS.checks);
      }
      expect(f.m.stats.started.look).toBe(leaves ? 0 : 1);
      expect(f.m.snapshot().pending).toEqual([]);
    }
  });
  it.each(['source', 'moving', 'catalog', 'eligibility'])(
    'does not invent a visitor reaction with missing %s',
    (reason) => {
      const f = reason === 'catalog' ? fixture('look', () => 0.99) : visitor();
      f.a.type = 'gatherer';
      if (reason === 'source') f.a.source = undefined;
      if (reason === 'moving') f.a.idle = false;
      if (reason === 'eligibility') f.c.eligible = () => false;
      f.m.step(1, f.c);
      expect(f.m.stats.started.look).toBe(0);
    },
  );
  it.each(['rain', 'zoom', 'eligibility'])(
    'cancels visitor reactions when %s blocks the moment',
    (reason) => {
      const f = visitor();
      start(f, 'look');
      if (reason === 'rain') f.c.rain = 0.5;
      if (reason === 'zoom') f.c.zoom = 17;
      if (reason === 'eligibility') f.c.eligible = () => false;
      f.m.step(0.1, f.c);
      expect(f.m.speech(f.a.owner)).toBeUndefined();
      expect(f.releases).toEqual([f.a.owner]);
    },
  );
  it('selects speech using the catalog greeting schedule', () => {
    const dialogue: DialogueChoice[] = [
      { id: 'morning', kind: 'greet', period: 'morning', turns: 2 },
      { id: 'afternoon', kind: 'greet', period: 'afternoon', turns: 2 },
    ];
    const f = fixture('greet', () => 0, dialogue, {
      morningStart: 360,
      afternoonStart: 780,
      eveningStart: 1140,
    });
    f.c.minutes = 720;
    start(f, 'greet');
    expect(f.m.speech(f.a.owner)?.exchangeId).toBe('morning');
  });
  it('accommodates pair and third-member clearance without relaxing minimum separation', () => {
    for (const kind of ['greet', 'talk', 'ball'] as const) {
      const f = fixture(kind);
      f.c.clearance = () => 6;
      f.b.x = 13;
      if (kind === 'talk') f.actors.push({ ...f.a, owner: {}, x: 6.5, y: 12 });
      start(f, kind);
      expect(f.m.snapshot().active[0]!.members).toHaveLength(kind === 'talk' ? 3 : 2);
    }
  });
  it.each(['greet', 'talk', 'ball', 'look'] as const)(
    'retries accepted %s admission without rerolling its chance or exceeding the scan budget',
    (kind) => {
      let rolls = 0;
      const f = fixture(kind, () => {
        rolls++;
        return 0;
      });
      let attempts = 0;
      f.c.face = () => {
        attempts++;
        return false;
      };
      for (let i = 0; i < 5; i++) f.m.step(0.1, f.c);
      const initialRolls = rolls,
        initialAttempts = attempts;
      expect(initialAttempts).toBeGreaterThan(0);
      for (let i = 0; i < 5; i++) f.m.step(0.1, f.c);
      expect(attempts).toBe(initialAttempts);
      expect(rolls).toBe(initialRolls);
      const checks = f.m.stats.checks;
      f.c.face = () => true;
      for (let i = 0; i < 5; i++) f.m.step(0.1, f.c);
      expect(f.m.stats.started[kind]).toBe(1);
      expect(f.m.stats.checks - checks).toBeLessThanOrEqual(5 * MOMENTS.checks);
      expect(f.m.snapshot().pending).toEqual([]);
    },
  );
  it.each(['separation', 'eligibility', 'rain', 'zoom'])(
    'discards pending greetings on lost %s',
    (reason) => {
      const f = fixture('greet');
      f.c.face = () => false;
      f.m.step(0.1, f.c);
      expect(f.m.snapshot().pending).toHaveLength(1);
      if (reason === 'separation') f.b.x = 10;
      if (reason === 'eligibility') f.c.eligible = () => false;
      if (reason === 'rain') f.c.rain = 1;
      if (reason === 'zoom') f.c.zoom = 17;
      f.m.step(0.1, f.c);
      expect(f.m.snapshot().pending).toEqual([]);
      expect(f.m.size).toBe(0);
    },
  );
  it('gives a greeting two readable turns, matching gestures, then clears the cue', () => {
    const choices: DialogueChoice[] = ['morning', 'afternoon', 'evening'].map((period) => ({
      id: `greet-${period}`,
      kind: 'greet',
      period: period as DialogueChoice['period'],
      turns: 2,
    }));
    const f = fixture('greet', () => 0, choices);
    f.c.minutes = 480;
    start(f, 'greet');
    expect(f.m.speech(f.a.owner)).toMatchObject({ exchangeId: 'greet-morning', line: 0 });
    expect(f.m.speech(f.b.owner)).toBeUndefined();
    f.m.step(2.5, f.c);
    expect(f.m.speech(f.a.owner)).toBeUndefined();
    expect(f.m.speech(f.b.owner)).toMatchObject({ exchangeId: 'greet-morning', line: 1 });
    expect(f.m.pose(f.b.owner)).toBe('gesture');
    f.m.step(2.5, f.c);
    expect(f.m.speech(f.b.owner)).toBeUndefined();
    expect(f.m.busy(f.a.owner)).toBe(false);
  });
  it('finishes a three-turn exchange once, using the actual rotating speaker', () => {
    const f = fixture('talk', () => 0, [{ id: 'chat', kind: 'talk', turns: 3 }]);
    start(f, 'talk');
    expect(f.m.speech(f.a.owner)?.line).toBe(0);
    f.m.step(3, f.c);
    expect(f.m.speech(f.b.owner)?.line).toBe(1);
    expect(f.m.pose(f.b.owner)).toBe('gesture');
    f.m.step(3, f.c);
    expect(f.m.speech(f.a.owner)?.line).toBe(2);
    f.m.step(3, f.c);
    expect(f.m.speech(f.a.owner)).toBeUndefined();
    expect(f.m.speech(f.b.owner)).toBeUndefined();
  });
  it('starts a ball exchange at a throw and rate limits further exchanges', () => {
    const f = fixture('ball', () => 0, [{ id: 'play', kind: 'ball', turns: 2 }]);
    start(f, 'ball');
    expect(f.m.speech(f.a.owner)).toBeUndefined();
    f.m.step(0.5, f.c);
    const first = f.m.speech(f.a.owner)!;
    expect(first).toMatchObject({ exchangeId: 'play', line: 0 });
    f.m.step(2.5, f.c);
    expect(f.m.speech(f.b.owner)?.line).toBe(1);
    f.m.step(2.5, f.c);
    expect(f.m.speech(f.a.owner)).toBeUndefined();
    expect(f.m.speech(f.b.owner)).toBeUndefined();
    f.m.step(6, f.c);
    const next = f.m.speech(f.a.owner) ?? f.m.speech(f.b.owner);
    expect(next?.id).not.toBe(first.id);
    expect(next?.line).toBe(0);
  });
  it('uses a separate deterministic dialogue stream and clears all kinds on cancellation', () => {
    for (const kind of ['greet', 'talk', 'ball', 'look'] as const) {
      const choice: DialogueChoice = {
        id: kind,
        kind,
        period: kind === 'greet' ? 'afternoon' : undefined,
        turns: kind === 'look' ? 1 : 2,
      };
      const a = fixture(kind, () => 0, [choice]),
        b = fixture(kind, () => 0, [choice]);
      start(a, kind);
      start(b, kind);
      expect(a.m.snapshot()).toEqual(b.m.snapshot());
      if (kind === 'ball') a.m.step(0.5, a.c);
      expect(structuredClone(a.m.speech(a.a.owner))).toEqual(a.m.speech(a.a.owner));
      a.c.rain = 0.5;
      a.m.step(0.1, a.c);
      expect(a.m.speech(a.a.owner)).toBeUndefined();
      expect(a.m.speech(a.b.owner)).toBeUndefined();
      a.m.clear((actor) => a.c.release(actor));
      expect(a.m.size).toBe(0);
    }
  });
  for (const kind of ['greet', 'talk', 'ball', 'look'] as const) {
    it(`starts, faces, holds and releases ${kind} without moving anyone`, () => {
      const f = fixture(kind);
      start(f, kind);
      expect(f.m.busy(f.a.owner)).toBe(true);
      expect(f.facing.get(f.a.owner)).toEqual([1, 0]);
      expect(f.m.pose(f.a.owner)).toBe(kind === 'ball' ? 'attentive' : 'gesture');
      expect(f.a.x).toBe(0);
      for (let i = 0; i < 1000 && f.m.busy(f.a.owner); i++) f.m.step(0.1, f.c);
      expect(f.m.stats.completed).toBe(1);
      expect(f.m.busy(f.a.owner)).toBe(false);
      expect(f.m.pose(f.a.owner)).toBeUndefined();
      expect(f.facing.size).toBe(0);
      expect(f.m.snapshot().cooldown.length).toBe(kind === 'look' ? 1 : 2);
    });
  }
  it('rotates conversation speakers and freezes everyone at their existing positions', () => {
    const f = fixture('talk');
    start(f, 'talk');
    expect(f.m.pose(f.a.owner)).toBe('gesture');
    expect(f.m.pose(f.b.owner)).toBe('attentive');
    f.m.step(2, f.c);
    expect(f.m.pose(f.b.owner)).toBe('gesture');
    expect(f.a.x).toBe(0);
    expect(f.b.x).toBe(6);
  });
  it('emits a linear airborne ball only between throws and catches', () => {
    const f = fixture('ball');
    start(f, 'ball');
    expect(f.m.balls()).toEqual([]);
    f.m.step(0.8, f.c);
    const [ball] = f.m.balls();
    expect(ball).toMatchObject({ a: f.a.owner, b: f.b.owner, y: 0 });
    expect(ball!.x).toBeCloseTo(3, 12);
    f.m.step(0.3, f.c);
    expect(f.m.balls()).toEqual([]);
  });
  it('rolls back partial admission in reverse order', () => {
    const f = fixture('greet');
    f.c.face = (a, hx, hy) => {
      if (a === f.b) return false;
      f.facing.set(a.owner, [hx, hy]);
      return true;
    };
    f.m.step(0.1, f.c);
    expect(f.m.stats.started.greet).toBe(0);
    expect(f.releases).toEqual([f.a.owner]);
    expect(f.facing.size).toBe(0);
    expect(f.m.snapshot().cooldown).toEqual([]);
  });
  it('recruits a third conversation member and rolls back both reservations if they are denied', () => {
    for (const deny of [false, true]) {
      const f = fixture('talk');
      const third: MomentActor = { ...f.a, owner: {}, x: 3, y: 4 };
      f.actors.push(third);
      f.c.face = (a, hx, hy) => {
        if (deny && a === third) return false;
        f.facing.set(a.owner, [hx, hy]);
        return true;
      };
      f.m.step(0.1, f.c);
      expect(f.m.size).toBe(deny ? 0 : 1);
      if (deny) expect(f.releases).toEqual([f.b.owner, f.a.owner]);
      else expect(f.m.snapshot().active[0]!.members).toHaveLength(3);
      expect(f.m.stats.checks).toBeLessThanOrEqual(MOMENTS.checks);
    }
  });
  it('allows pitch players as fallback, but requires children at schools', () => {
    for (const place of ['pitch', 'school'] as const) {
      const f = fixture('ball');
      f.a.figure = f.b.figure = 'adult';
      f.a.place = f.b.place = place;
      for (let i = 0; i < 20; i++) f.m.step(0.1, f.c);
      expect(f.m.stats.started.ball).toBe(place === 'pitch' ? 1 : 0);
    }
  });
  it('cancels when a changed cell size can no longer pack the pair', () => {
    const f = fixture('greet');
    start(f, 'greet');
    f.c.clearance = () => 2;
    f.m.step(0.01, f.c);
    expect(f.m.stats.canceled).toBe(1);
    expect(f.m.size).toBe(0);
  });
  it('cancels immediately for rain, zoom and lost eligibility, with cooldown', () => {
    for (const cancel of [
      (c: MomentContext) => {
        c.rain = 0.5;
      },
      (c: MomentContext) => {
        c.zoom = 17.99;
      },
      (c: MomentContext) => {
        c.eligible = () => false;
      },
    ]) {
      const f = fixture('ball');
      start(f, 'ball');
      cancel(f.c);
      f.m.step(0.01, f.c);
      expect(f.m.stats.canceled).toBe(1);
      expect(f.m.balls()).toEqual([]);
      expect(f.m.busy(f.a.owner)).toBe(false);
    }
  });
  it('uses exact source identity, idle episodes and legal separation', () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => {
        f.b.source = 1;
      },
      (f: ReturnType<typeof fixture>) => {
        f.b.idle = false;
      },
      (f: ReturnType<typeof fixture>) => {
        f.b.x = 0;
      },
      (f: ReturnType<typeof fixture>) => {
        f.c.clearance = () => 4;
      },
    ]) {
      const f = fixture('talk');
      mutate(f);
      for (let i = 0; i < 20; i++) f.m.step(0.1, f.c);
      expect(f.m.stats.started.talk).toBe(0);
    }
  });
  it('makes one chance roll per approach and rearms only beyond the hysteresis radius', () => {
    let rolls = 0;
    const f = fixture('greet', () => {
      rolls++;
      return 0.99;
    });
    for (let i = 0; i < 100; i++) f.m.step(0.1, f.c);
    expect(rolls).toBe(1);
    f.b.x = 5;
    f.m.step(0.1, f.c);
    f.b.x = 2;
    for (let i = 0; i < 10; i++) f.m.step(0.1, f.c);
    expect(rolls).toBe(2);
  });
  it('limits failed idle chances to one per actor per idle episode', () => {
    let rolls = 0;
    const f = fixture('talk', () => {
      rolls++;
      return 0.99;
    });
    for (let i = 0; i < 100; i++) f.m.step(0.1, f.c);
    expect(rolls).toBe(2);
    f.a.idle = f.b.idle = false;
    f.m.step(0.1, f.c);
    f.a.idle = f.b.idle = true;
    for (let i = 0; i < 10; i++) f.m.step(0.1, f.c);
    expect(rolls).toBe(4);
  });
  it('keeps scans and controlled timing identical at 30, 60 and 120 Hz', () => {
    const snapshots = [30, 60, 120].map((hz) => {
      const f = fixture('talk');
      for (let i = 0; i < 8 * hz; i++) f.m.step(1 / hz, f.c);
      const s = f.m.snapshot();
      // Floating point accumulation is intentionally compared with a small tolerance.
      expect(s.time).toBeCloseTo(8, 10);
      expect(s.stats.checks).toBe(80 * MOMENTS.checks);
      return {
        ...s,
        time: 8,
        active: s.active.map((m) => ({
          ...m,
          start: +m.start.toFixed(6),
          end: +m.end.toFixed(6),
          turnStart: +m.turnStart.toFixed(6),
          turnEnd: +m.turnEnd.toFixed(6),
          phaseStart: +m.phaseStart.toFixed(6),
          phaseEnd: +m.phaseEnd.toFixed(6),
        })),
      };
    });
    expect(snapshots[1]).toEqual(snapshots[0]);
    expect(snapshots[2]).toEqual(snapshots[0]);
  });
  it('disables all decisions per instance and bounds active moments and flights', () => {
    const f = fixture('ball');
    const off = new Moments(42, false);
    off.step(100, f.c);
    expect(off.snapshot().stats.checks).toBe(0);
    for (let i = 0; i < 200; i++)
      f.actors.push(
        { ...f.a, owner: {}, source: i + 1, x: i * 30 },
        { ...f.b, owner: {}, source: i + 1, x: i * 30 + 6 },
      );
    for (let i = 0; i < 100; i++) f.m.step(0.1, f.c);
    expect(f.m.snapshot().active.length).toBeLessThanOrEqual(MOMENTS.capacity);
    expect(f.m.snapshot().active.filter((m) => m.kind === 'ball').length).toBe(MOMENTS.balls);
    expect(f.m.balls().length).toBeLessThanOrEqual(MOMENTS.balls);
    expect(f.m.stats.checks).toBe(100 * MOMENTS.checks);
  });
});
