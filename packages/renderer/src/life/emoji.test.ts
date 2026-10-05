import { describe, expect, it } from 'vitest';
import { epochDay } from '@atlas/shared';
import {
  EmojiObserver,
  EmojiMemory,
  ambientPool,
  eveningDate,
  seasonalPool,
  temperament,
  type EmojiObservation,
} from './emoji';
import { continuityMover, continuityTile, left } from './testing/continuity';
import { LifeWorld, TileLife, type LifeEnv } from './simulate';
import { completeScenarioState } from './testing/scenarios';
import type { Gatherer, Stall } from './simulate';
import type { Visit } from './interactions';

function fixture(kind: 'person' | 'vehicle' | 'dog' | 'cat' = 'person', rng = () => 0) {
  const entry = continuityTile(left);
  const tile = new TileLife(left, entry.life, 123);
  const m = continuityMover(tile, 2000, kind);
  if (kind === 'person')
    m.group = [{ figure: 'adult', shirt: 0, umbrella: 0, canopy: 0, lateral: 0, back: 0, step: 0 }];
  const o: EmojiObservation = {
    owner: m,
    mover: m,
    subject: kind === 'vehicle' ? 'driver' : kind,
    eligible: true,
    speaking: false,
    figure: m.group?.[0]?.figure,
  };
  const observer = new EmojiObserver(123, tile.perMeter, { rng });
  let clock = 0;
  const step = (dt = 0.5, env: Partial<LifeEnv> = {}, observations = [o]) => {
    clock += dt;
    observer.step(dt, 19, { rain: 0, minutes: 720, clock, ...env }, observations);
  };
  return { observer, o, m, tile, step };
}
describe('read-only emoji observer', () => {
  it('latches purchase, shelter and arrival edges between evaluation ticks and ignores canceled purchases', () => {
    const f = fixture(),
      stall: Stall = {
        x: f.m.x + f.tile.perMeter,
        y: f.m.y,
        hx: 1,
        hy: 0,
        paint: 0,
        shirt: 0,
        side: 1,
        rank: 0,
      };
    const vendor: EmojiObservation = {
      owner: stall,
      subject: 'person',
      figure: 'adult',
      vendor: true,
      eligible: true,
      speaking: false,
    };
    f.step(0.1, {}, [f.o, vendor]);
    f.observer.step(
      0.1,
      19,
      { rain: 0, clock: 0.2 },
      [f.o, vendor],
      [{ mover: f.m, stall, key: {} }],
    );
    f.observer.step(0.3, 19, { rain: 0, clock: 0.5 }, [f.o, vendor]);
    expect(f.observer.cue(f.m)?.mood).toBe('yummy');
    expect(f.observer.cue(stall)?.mood).toBe('happy');
    expect(f.observer.cue(stall)?.pair).toBe(f.observer.cue(f.m)?.pair);
    const canceled = fixture();
    canceled.step(0.1);
    const visit = { state: 'purchase', time: 2, site: { stall } } as Visit;
    canceled.o.visit = visit;
    canceled.step(0.1);
    visit.state = 'return';
    canceled.step(0.3);
    expect(canceled.observer.cue(canceled.m)).toBeUndefined();
  });
  it('freezes retirement without new elapsed rest, disposes bounded references and never replays a gap', () => {
    const f = fixture('vehicle');
    f.m.waiting = 3;
    f.step();
    const before = f.observer.cue(f.m)!.id;
    f.observer.freeze();
    f.observer.step(0.5, 19, { rain: 0, clock: 100 }, [f.o]);
    expect(f.observer.cue(f.m)?.id).toBe(before);
    expect(f.observer.memory.get(f.m)!.stop).toBe(0);
    expect(f.observer.size).toBe(1);
    f.observer.dispose();
    expect(f.observer.groups.size).toBe(0);
    expect(f.observer.cue(f.m)).toBeUndefined();
  });
  it.each([false, true])(
    'uses one isolated first opportunity with the specified ambient rate (seasonal=%s)',
    (seasonal) => {
      const f = fixture();
      let admitted = 0;
      const env: LifeEnv = {
        rain: 0,
        minutes: 720,
        season: seasonal ? 'moods' : null,
        emojiSeasons: [{ id: 'moods', emoji: [{ mood: 'gift', subjects: ['person'], weight: 1 }] }],
      };
      for (let seed = 0; seed < 4000; seed++) {
        const observer = new EmojiObserver(seed, f.tile.perMeter);
        const o = { ...f.o, owner: { ...f.m } };
        observer.step(0, 19, { ...env, clock: 0 }, [o]);
        observer.step(12, 19, { ...env, clock: 12 }, [o]);
        admitted += Number(!!observer.cue(o.owner));
        expect(observer.memory.get(o.owner)!.attemptAt).toBe(72);
      }
      const target = seasonal ? 0.2 : 0.15;
      expect(Math.abs(admitted / 4000 - target)).toBeLessThan(target * 0.2);
    },
  );
  it('replays the same controlled trace at 30, 60 and 120 Hz through fixed evaluation deadlines', () => {
    const f = fixture('vehicle');
    const traces: unknown[][] = [];
    for (const hz of [30, 60, 120]) {
      const observer = new EmojiObserver(19, f.tile.perMeter, { rng: () => 0 });
      const m = { ...f.m },
        o = { ...f.o, owner: m, mover: m },
        trace: unknown[] = [];
      observer.step(0, 19, { rain: 0, clock: 0 }, [o]);
      for (let i = 1; i <= hz * 12; i++) {
        const clock = i / hz;
        m.waiting = clock >= 2 ? 3 : 0;
        observer.step(1 / hz, 19, { rain: 0, clock }, [o]);
        if (i % (hz / 2) === 0) trace.push(observer.cue(m) ?? null);
      }
      traces.push(trace);
    }
    expect(traces[1]).toEqual(traces[0]);
    expect(traces[2]).toEqual(traces[0]);
  });
  it.each([
    ['angry', 7],
    ['impatient', 3],
  ] as const)('observes driver %s once without rerolling a held trigger', (mood, waiting) => {
    let rolls = 0;
    const f = fixture('vehicle', () => {
      rolls++;
      return 0;
    });
    f.m.waiting = waiting;
    f.step();
    expect(f.observer.cue(f.m)?.mood).toBe(mood);
    const after = rolls;
    for (let i = 0; i < 3; i++) f.step();
    expect(rolls).toBe(after);
  });
  it('counts elapsed rest rather than remaining pause, resets interruptions and excludes grooming', () => {
    const f = fixture('cat');
    f.m.pause = 30;
    f.o.still = true;
    f.m.grooming = true;
    f.step();
    expect(f.observer.cue(f.m)?.mood).toBe('happy');
    f.observer.dispose();
    f.m.grooming = false;
    for (let i = 0; i < 10; i++) f.step(0.5);
    expect(f.observer.cue(f.m)).toBeUndefined();
    f.o.still = false;
    f.step();
    f.o.still = true;
    f.observer.memory.get(f.m)!.cooldownUntil = 0;
    for (let i = 0; i < 20; i++) f.step(0.5, { minutes: 1380 });
    f.observer.memory.get(f.m)!.cooldownUntil = 0;
    f.step(0.5, { minutes: 1380 });
    expect(f.observer.cue(f.m)?.mood).toBe('sleeping');
  });
  it('admits a standoff pair before solos, counts one leader and suppresses both for speech', () => {
    const f = fixture('dog');
    const c = continuityMover(f.tile, 2000 + 2 * f.tile.perMeter, 'cat');
    const cat: EmojiObservation = {
      owner: c,
      mover: c,
      subject: 'cat',
      eligible: true,
      speaking: false,
    };
    f.step(0.5, {}, [cat, f.o]);
    const a = f.observer.cue(f.m)!,
      b = f.observer.cue(c)!;
    expect(a.mood).toBe('angry');
    expect(b.mood).toBe('angry');
    expect(a.pair).toBe(b.pair);
    expect(a.id).not.toBe(b.id);
    expect(f.observer.size).toBe(1);
    cat.speaking = true;
    f.step(0.1, {}, [cat, f.o]);
    expect(f.observer.cue(f.m)).toBeUndefined();
    expect(f.observer.cue(c)).toBeUndefined();
  });
  it('pairs a held driver on boarding onset without spending cooldown on holding', () => {
    const f = fixture('vehicle');
    f.o.held = true;
    const p = fixture().m;
    p.x = f.m.x + f.tile.perMeter;
    p.y = f.m.y;
    const passenger: EmojiObservation = {
      owner: p,
      mover: p,
      subject: 'person',
      eligible: true,
      speaking: false,
      figure: 'adult',
    };
    f.step(0.5, {}, [f.o, passenger]);
    expect(f.observer.cue(f.m)).toBeUndefined();
    f.o.passenger = p;
    f.step(0.1, {}, [f.o, passenger]);
    f.step(0.4, {}, [f.o, passenger]);
    expect(f.observer.cue(f.m)?.mood).toBe('happy');
    expect(f.observer.cue(p)?.mood).toBe('wave');
  });
  it('consumes blocked ambient deadlines and clears below zoom without catch-up', () => {
    const f = fixture();
    f.step();
    f.o.speaking = true;
    for (let i = 0; i < 5; i++) f.step();
    const t = f.observer.memory.get(f.m)!;
    expect(t.attemptAt).toBeGreaterThan(60);
    f.o.speaking = false;
    f.step();
    expect(f.observer.cue(f.m)).toBeUndefined();
    f.observer.step(0.5, 17, { rain: 0, clock: 4 }, [f.o]);
    f.observer.step(0.5, 19, { rain: 0, clock: 100, minutes: 720 }, [f.o]);
    expect(f.observer.cue(f.m)).toBeUndefined();
    expect(t.attemptAt).toBe(160);
  });
  it('preserves tracks and IDs across shared-memory adoption, disposal and reset', () => {
    const f = fixture('vehicle');
    f.m.waiting = 3;
    f.step();
    const id = f.observer.cue(f.m)!.id,
      track = f.observer.memory.get(f.m);
    const target = new EmojiObserver(88, f.tile.perMeter, { memory: f.observer.memory });
    target.adopt(f.m, f.observer);
    f.observer.release(f.m);
    expect(target.cue(f.m)?.id).toBe(id);
    expect(target.memory.get(f.m)).toBe(track);
    expect(f.observer.size).toBe(0);
    target.dispose();
    expect(target.size).toBe(0);
    target.memory.reset();
    expect(target.memory.get(f.m)).toBeUndefined();
    expect(target.memory.id()).not.toBe(id);
  });
  it('deduplicates normal voiced completions by occurrence and never follows busy listeners', () => {
    const f = fixture();
    const token = {};
    f.step(0.1);
    f.o.speaking = true;
    f.observer.step(0.4, 19, { rain: 0, clock: 0.5 }, [f.o], [], [{ token, owners: [f.m] }]);
    expect(f.observer.cue(f.m)).toBeUndefined();
    f.o.speaking = false;
    f.observer.step(0.5, 19, { rain: 0, clock: 1 }, [f.o], [], [{ token, owners: [f.m] }]);
    expect(f.observer.cue(f.m)).toBeUndefined();
    f.observer.step(0.5, 19, { rain: 0, clock: 1.5 }, [f.o], [], [{ token: {}, owners: [f.m] }]);
    expect(f.observer.cue(f.m)?.mood).toBe('playful');
  });
  it('produces a first ambient pop in a fixed seeded 30-owner fixture', () => {
    const f = fixture();
    const observer = new EmojiObserver(51, f.tile.perMeter);
    const owners = Array.from({ length: 30 }, (_, i) => ({
      ...f.o,
      owner: { ...f.m, rank: i / 30 },
    }));
    let pops = 0;
    for (let clock = 0.5; clock <= 12; clock += 0.5) {
      observer.step(0.5, 19, { rain: 0, minutes: 720, clock }, owners);
      pops += owners.filter((o) => observer.cue(o.owner)).length;
    }
    expect(pops).toBeGreaterThan(0);
    expect(observer.size).toBeLessThanOrEqual(4);
  });
  it('keeps physical state identical with observers enabled and disabled, including future RNG', () => {
    const a = new LifeWorld(),
      b = new LifeWorld(undefined, undefined, undefined, false, false);
    const entry = continuityTile(left);
    a.sync([entry]);
    b.sync([structuredClone(entry)]);
    a.setEmojiView([19, 1, [0, 0]]);
    b.setEmojiView([19, 1, [0, 0]]);
    const people = Array.from({ length: 20 }, (_, i) => {
      const m = fixture().m;
      m.x += i * 4;
      m.d += i * 4;
      m.rank = i / 40;
      return m;
    });
    for (const w of [a, b]) w.resident(entry.key)!.movers.push(...structuredClone(people));
    let admitted = false;
    for (let i = 0; i < 400; i++) {
      for (const w of [a, b])
        w.step(0.1, undefined, 19, undefined, undefined, {
          rain: i > 200 ? 1 : 0,
          minutes: i > 100 ? 1380 : 720,
          sunAltitude: i > 100 ? -30 : 70,
          date: { epochDay: epochDay(2026, 12, 24), weekday: 4, preview: false },
          windPreset: 'storm',
        });
      admitted ||= a.resident(entry.key)!.movers.some((m) => !!a.emojiMemory.cue(m));
    }
    expect(admitted).toBe(true);
    expect(completeScenarioState(a)).toEqual(completeScenarioState(b));
  });
});
describe('emoji ambient eligibility', () => {
  it('gates place moods by weekday, daylight and behavior without enabling excluded moods', () => {
    const f = fixture();
    const g = {
      ...f.m,
      walker: f.m.group![0]!,
      place: 'worship',
      behavior: 'gather',
    } as unknown as Gatherer;
    const o = { ...f.o, owner: g, mover: undefined, gatherer: g };
    const monday = {
      rain: 0,
      minutes: 600,
      sunAltitude: 70,
      date: { epochDay: 1, weekday: 1, preview: false },
    };
    expect(
      ambientPool(o, { ...monday, minutes: 480, date: { ...monday.date, weekday: 0 } }).find(
        (p) => p.mood === 'pray',
      )!.weight,
    ).toBe(4.5);
    g.place = 'school';
    expect(ambientPool(o, monday).some((p) => p.mood === 'study')).toBe(true);
    expect(
      ambientPool(o, { ...monday, date: { ...monday.date, weekday: 6 } }).some(
        (p) => p.mood === 'study',
      ),
    ).toBe(false);
    expect(ambientPool(o, { rain: 0, minutes: 600 }).some((p) => p.mood === 'study')).toBe(false);
    g.place = 'pitch';
    g.behavior = 'play';
    expect(ambientPool(o, monday).some((p) => p.mood === 'basketball')).toBe(true);
    g.behavior = 'gather';
    expect(ambientPool(o, monday).some((p) => p.mood === 'basketball')).toBe(false);
  });
  it('uses time, same-frame sun, dryness, open vehicles and resolved wind', () => {
    const f = fixture('vehicle');
    expect(ambientPool(f.o, { rain: 0, minutes: 1380 }).map((p) => p.mood)).toContain('sleepy');
    expect(ambientPool(f.o, { rain: 0, minutes: 420 }).map((p) => p.mood)).toContain('coffee');
    expect(ambientPool(f.o, { rain: 0, minutes: 720, sunAltitude: 70 })).toEqual([]);
    f.m.vehicle = 'motorcycle';
    expect(
      ambientPool(f.o, { rain: 0, minutes: 720, sunAltitude: 70 }).map((p) => p.mood),
    ).toContain('hot');
    expect(
      ambientPool(f.o, { rain: 1, minutes: 720, sunAltitude: 70 }).map((p) => p.mood),
    ).not.toContain('hot');
    const person = fixture().o;
    expect(
      ambientPool(person, {
        rain: 1,
        windPreset: 'storm',
        wind: { dir: [1, 0], strength: 0.9 },
      }).map((p) => p.mood),
    ).toContain('windy');
    expect(ambientPool(person, { rain: 0, windPreset: 'breeze' }).map((p) => p.mood)).not.toContain(
      'windy',
    );
  });
  it('matches real evening dates with UTC arithmetic across year and leap boundaries', () => {
    expect(
      eveningDate({
        minutes: 30,
        date: { epochDay: epochDay(2027, 1, 1), weekday: 5, preview: false },
      }),
    ).toEqual({ month: 12, day: 31 });
    expect(
      eveningDate({
        minutes: 60,
        date: { epochDay: epochDay(2024, 3, 1), weekday: 5, preview: false },
      }),
    ).toEqual({ month: 2, day: 29 });
    expect(
      eveningDate({
        minutes: 60,
        date: { epochDay: epochDay(2025, 3, 1), weekday: 6, preview: false },
      }),
    ).toEqual({ month: 2, day: 28 });
    const f = fixture();
    const entries = [
      {
        mood: 'feast' as const,
        subjects: ['person' as const],
        hours: [1080, 120] as [number, number],
        days: [{ month: 12, day: 24 }],
        weight: 3,
      },
    ];
    for (const [day, minutes, count] of [
      [24, 1200, 1],
      [25, 60, 1],
      [25, 1200, 0],
    ])
      expect(
        seasonalPool(
          f.o,
          {
            rain: 0,
            minutes,
            date: { epochDay: epochDay(2026, 12, day!), weekday: 5, preview: false },
          },
          entries,
        ),
      ).toHaveLength(count!);
    expect(
      seasonalPool(
        f.o,
        { rain: 0, minutes: 1200, date: { epochDay: 0, weekday: 4, preview: true } },
        entries,
      ),
    ).toEqual([{ mood: 'feast', weight: 1.5 }]);
  });
  it('never gives figure-restricted drinking to children, drivers or pets', () => {
    const entries = [
      { mood: 'beer' as const, subjects: ['person' as const], figure: 'adult' as const, weight: 1 },
    ];
    const f = fixture();
    expect(seasonalPool(f.o, { rain: 0 }, entries)).toHaveLength(1);
    f.o.figure = 'child';
    expect(seasonalPool(f.o, { rain: 0 }, entries)).toEqual([]);
    expect(seasonalPool(fixture('vehicle').o, { rain: 0 }, entries)).toEqual([]);
    expect(seasonalPool(fixture('dog').o, { rain: 0 }, entries)).toEqual([]);
  });
  it('decorrelates rank into the specified stable temperament shares', () => {
    const counts = { neutral: 0, cheerful: 0, grumpy: 0, sleepy: 0 };
    for (let i = 0; i < 10000; i++) counts[temperament(i / 10000)]++;
    for (const [kind, share] of [
      ['neutral', 0.5],
      ['cheerful', 0.2],
      ['grumpy', 0.2],
      ['sleepy', 0.1],
    ] as const)
      expect(Math.abs(counts[kind] / 10000 - share)).toBeLessThan(0.03);
    const memory = new EmojiMemory();
    expect(memory.id()).toContain('emoji:0');
    memory.reset();
    expect(memory.id()).toContain('emoji:1');
  });
});
