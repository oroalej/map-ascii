import { describe, expect, it, vi } from 'vitest';
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
import { SceneSpeech } from './scene-speech';
import { activityLevels } from './config';
import { LifeBuilder } from './geometry';

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
  it.each([
    [0, 2],
    [0.5, 4.5],
    [0.999, 11.98001],
  ])(
    'schedules the first sample %s within the initial window at %s seconds',
    (sample, deadline) => {
      let rolls = 0;
      const f = fixture('person', () => (rolls++ === 0 ? sample : 0));
      f.step(0);
      const track = f.observer.memory.get(f.m)!;
      expect(track.attemptAt).toBeCloseTo(deadline, 5);
      expect(track.attemptAt).toBeGreaterThanOrEqual(2);
      expect(track.attemptAt).toBeLessThan(12);
      f.step(1.999);
      expect(f.observer.cue(f.m)).toBeUndefined();
      f.step(12 - 1.999);
      expect(f.observer.cue(f.m)).toBeDefined();
      expect(track.attemptAt).toBe(72);
    },
  );
  it.each([
    [17, true],
    [19, false],
  ] as const)('skips observation inputs at z%s with internal enablement=%s', (zoom, enabled) => {
    const world = new LifeWorld(undefined, undefined, undefined, false, enabled);
    const entry = continuityTile(left);
    world.sync([entry]);
    world.setEmojiView([zoom, 1, [0, 0]]);
    const tile = world.resident(entry.key)!;
    expect(tile.movers.length).toBeGreaterThan(0);
    const speaking = vi.spyOn(tile.momentHost, 'speaking');
    world.step(0.1, undefined, zoom);
    expect(speaking).not.toHaveBeenCalled();
    speaking.mockRestore();
    if (enabled) {
      world.setEmojiView([19, 1, [0, 0]]);
      const resumed = vi.spyOn(tile.momentHost, 'speaking');
      world.step(0.1, undefined, 19);
      expect(resumed).toHaveBeenCalled();
      resumed.mockRestore();
    }
  });
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
  it('creates tracks only on eligibility and cleans episodes immediately before safe re-entry', () => {
    const f = fixture('vehicle');
    f.m.waiting = 3;
    f.o.eligible = false;
    f.step();
    expect(f.observer.memory.get(f.m)).toBeUndefined();
    f.o.eligible = true;
    f.step();
    const track = f.observer.memory.get(f.m)!;
    expect(f.observer.cue(f.m)).toBeUndefined();
    f.m.waiting = 0;
    f.step();
    f.m.waiting = 3;
    f.step();
    expect(f.observer.cue(f.m)?.mood).toBe('impatient');
    const cooldown = track.cooldownUntil;
    f.o.eligible = false;
    f.step(0.1);
    expect(f.observer.cue(f.m)).toBeUndefined();
    expect(track.eligible).toBe(false);
    expect(track.cooldownUntil).toBe(cooldown);
    f.o.eligible = true;
    f.step(100);
    expect(f.observer.memory.get(f.m)).toBe(track);
    expect(f.observer.cue(f.m)).toBeUndefined();
    expect(track.attemptAt).toBeGreaterThan(160);
  });
  it('clears sampled pet, visit and passenger references when owners become ineligible', () => {
    const pet = fixture('dog');
    const other = continuityMover(pet.tile, pet.m.x + 2 * pet.tile.perMeter, 'cat');
    const cat: EmojiObservation = {
      owner: other,
      mover: other,
      subject: 'cat',
      eligible: true,
      speaking: false,
    };
    const visit = { state: 'rest', time: 1, site: {} } as Visit;
    pet.o.visit = visit;
    pet.step(0.5, {}, [pet.o, cat]);
    const petTrack = pet.observer.memory.get(pet.m)!;
    expect(petTrack.standoff).toBe(other);
    expect(petTrack.visit?.identity).toBe(visit);
    const cooldown = petTrack.cooldownUntil;
    pet.o.eligible = false;
    pet.step(0.1, {}, [pet.o, cat]);
    expect(petTrack.standoff).toBeUndefined();
    expect(petTrack.visit).toBeUndefined();
    expect(petTrack.cooldownUntil).toBe(cooldown);
    const driver = fixture('vehicle');
    const passenger = fixture().m;
    driver.o.passenger = passenger;
    driver.step();
    const driverTrack = driver.observer.memory.get(driver.m)!;
    expect(driverTrack.passenger).toBe(passenger);
    driver.o.eligible = false;
    driver.step(0.1);
    expect(driverTrack.passenger).toBeUndefined();
  });
  it('matches seasonal drawn attendance and skips never-visible owners before scene queries', () => {
    const builder = new LifeBuilder();
    builder.place({ x: 2000, y: 2000 }, 'worship', 80);
    const tile = new TileLife(left, builder.finish(), 123);
    const template = tile.gatherers[0]!;
    expect(template).toBeDefined();
    const visitors: Gatherer = { ...template, rank: 0.5, seasonal: 'visitors' };
    const congregations: Gatherer = { ...template, rank: 0.5, seasonal: 'congregations' };
    tile.gatherers.splice(0, tile.gatherers.length, visitors, congregations);
    tile.movers.length = tile.stalls.length = 0;
    const read = tile as unknown as { emojiObservations(env: LifeEnv): EmojiObservation[] };
    const levels = activityLevels(1);
    const visible: LifeEnv = {
      rain: 0,
      levels: {
        ...levels,
        places: { ...levels.places, worship: 0.1 },
        season: { visitors: 1, congregations: 1 },
      },
    };
    const speaking = vi.spyOn(tile.momentHost, 'speaking');
    const observations = read.emojiObservations(visible);
    expect(observations.map((o) => o.owner)).toEqual([visitors, congregations]);
    expect(observations.every((o) => o.eligible)).toBe(true);
    tile.emoji.step(0.1, 19, visible, observations);
    speaking.mockClear();
    const hidden: LifeEnv = {
      rain: 0,
      levels: {
        ...levels,
        places: { ...levels.places, worship: 1 },
        season: { visitors: 0, congregations: 0 },
      },
    };
    const unseen: Gatherer = { ...visitors };
    tile.gatherers.push(unseen);
    const cleanup = read.emojiObservations(hidden);
    expect(cleanup.map((o) => o.owner)).toEqual([visitors, congregations]);
    expect(cleanup.every((o) => !o.eligible)).toBe(true);
    expect(speaking).toHaveBeenCalledTimes(2);
    tile.emoji.step(0.1, 19, hidden, cleanup);
    expect(tile.emoji.memory.get(unseen)).toBeUndefined();
    expect(tile.emoji.memory.get(visitors)?.eligible).toBe(false);
    speaking.mockClear();
    expect(read.emojiObservations(hidden)).toHaveLength(0);
    expect(speaking).not.toHaveBeenCalled();
    const resumed = read.emojiObservations(visible);
    expect(resumed.map((o) => o.owner)).toEqual([visitors, congregations, unseen]);
    tile.emoji.step(0.1, 19, visible, resumed);
    expect(tile.emoji.memory.get(visitors)?.eligible).toBe(true);
    speaking.mockRestore();
  });
  it('shares mover and vendor attendance with drawing, including hidden and closed owners', () => {
    const world = new LifeWorld();
    const entry = continuityTile(left);
    world.sync([entry]);
    const tile = world.resident(entry.key)!;
    const m = continuityMover(tile, 2000, 'vehicle');
    m.rank = 0.5;
    const stall: Stall = { x: 2000, y: 2000, hx: 1, hy: 0, paint: 0, shirt: 0, side: 1, rank: 0.5 };
    tile.movers.splice(0, tile.movers.length, m);
    tile.stalls.splice(0, tile.stalls.length, stall);
    tile.gatherers.length = 0;
    const read = tile as unknown as { emojiObservations(env: LifeEnv): EmojiObservation[] };
    const levels = { ...activityLevels(1), person: 1, vehicle: 1 };
    const hidden = vi.spyOn(tile.scenes, 'hidden').mockReturnValue(false);
    const compare = (owners: object[]) => {
      expect(
        read
          .emojiObservations({ rain: 0, levels })
          .filter((o) => o.eligible)
          .map((o) => o.owner),
      ).toEqual(owners);
      expect(world.visible(19, levels, [0, 0])).toHaveLength(owners.length);
    };
    compare([m, stall]);
    hidden.mockReturnValue(true);
    compare([stall]);
    stall.open = false;
    compare([]);
    hidden.mockReturnValue(false);
    stall.open = true;
    levels.person = levels.vehicle = 0.1;
    compare([]);
    hidden.mockRestore();
  });
  it('freezes retirement without new elapsed rest, disposes bounded references and never replays a gap', () => {
    const f = fixture('vehicle');
    f.step(0);
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
  it.each(['off-view', 'frozen'] as const)(
    'rebaselines a %s donor after transfer without replaying elapsed state or overdue opportunities',
    (gap) => {
      const f = fixture('vehicle');
      f.m.v = 0;
      f.step(0);
      f.step(20);
      const track = f.observer.memory.get(f.m)!;
      track.attemptAt = 21;
      const cooldown = track.cooldownUntil;
      if (gap === 'off-view') {
        f.o.eligible = false;
        f.step(0.5);
        f.o.eligible = true;
      } else f.observer.freeze();
      const destination = new EmojiObserver(456, f.tile.perMeter, {
        memory: f.observer.memory,
        rng: () => 0,
      });
      destination.adopt(f.m, f.observer);
      const passenger = fixture().m;
      f.o.passenger = passenger;
      destination.step(0.5, 19, { rain: 0, clock: 100 }, [f.o]);
      expect(destination.memory.get(f.m)).toBe(track);
      expect(track.stop).toBe(0);
      expect(track.cooldownUntil).toBe(cooldown);
      expect(track.attemptAt).toBe(160);
      expect(destination.cue(f.m)).toBeUndefined();
      for (let clock = 100.5; clock <= 105; clock += 0.5)
        destination.step(0.5, 19, { rain: 0, clock }, [f.o]);
      expect(destination.cue(f.m)).toBeUndefined();
      expect(track.passenger).toBe(passenger);
    },
  );
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
    f.step(0);
    f.m.waiting = waiting;
    f.step();
    expect(f.observer.cue(f.m)?.mood).toBe(mood);
    f.observer.memory.get(f.m)!.attemptAt = 100;
    const after = rolls;
    for (let i = 0; i < 3; i++) f.step();
    expect(rolls).toBe(after);
  });
  it.each(['boarding', 'shelter', 'grooming'] as const)(
    'baselines an already-active %s state and reacts only to its later onset',
    (event) => {
      const f = fixture(event === 'boarding' ? 'vehicle' : event === 'grooming' ? 'cat' : 'person');
      const passenger = fixture().m;
      const visit = { state: 'shelter', time: 2, site: {} } as Visit;
      const set = (active: boolean) => {
        if (event === 'boarding') f.o.passenger = active ? passenger : undefined;
        if (event === 'shelter') f.o.visit = active ? visit : undefined;
        if (event === 'grooming') f.m.grooming = active;
      };
      set(true);
      f.step(0, { rain: 1 });
      expect(f.observer.cue(f.m)).toBeUndefined();
      expect(f.observer.memory.get(f.m)?.attemptAt).toBe(2);
      set(false);
      f.step(0.5, { rain: 1 });
      set(true);
      f.step(0.5, { rain: 1 });
      expect(f.observer.cue(f.m)?.mood).toBe(event === 'shelter' ? 'rained' : 'happy');
    },
  );
  it('pairs the nearest pedestrian ahead, preserving observation order for ties', () => {
    const f = fixture('vehicle');
    f.m.hx = 1;
    f.m.hy = 0;
    const people = [2, 1, 1, -0.5].map((distance) => {
      const p = fixture().o;
      p.owner.x = f.m.x + distance * f.tile.perMeter;
      p.owner.y = f.m.y;
      return p;
    });
    const observations = [f.o, ...people];
    f.step(0, {}, observations);
    f.m.waiting = 3;
    f.step(0.5, {}, observations);
    expect(f.observer.cue(people[1]!.owner)?.mood).toBe('sorry');
    expect(f.observer.cue(people[2]!.owner)).toBeUndefined();
    expect(f.observer.cue(people[1]!.owner)?.pair).toBe(f.observer.cue(f.m)?.pair);
  });
  it('does not search driver blockers when admission is unavailable', () => {
    const f = fixture('vehicle');
    const p = fixture().o;
    const x = vi.spyOn(p.owner, 'x', 'get');
    f.step(0, {}, [f.o, p]);
    f.observer.memory.get(f.m)!.cooldownUntil = 100;
    f.m.waiting = 3;
    f.step(0.5, {}, [f.o, p]);
    expect(x).not.toHaveBeenCalled();
    x.mockRestore();
  });
  it('counts elapsed rest rather than remaining pause, resets interruptions and excludes grooming', () => {
    const f = fixture('cat');
    f.step(0);
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
    f.step(0);
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
  it('keeps one owning index when paired members cross different seams and reuses expired capacity', () => {
    const f = fixture('dog');
    const partner = new EmojiObserver(88, f.tile.perMeter, { memory: f.observer.memory });
    const leader = new EmojiObserver(89, f.tile.perMeter, { memory: f.observer.memory });
    for (let cycle = 0; cycle < 5; cycle++) {
      const dog = { ...f.m, rank: cycle / 10 };
      const cat = { ...dog, kind: 'cat' as const, x: dog.x + 2 * f.tile.perMeter };
      const observations: EmojiObservation[] = [
        { ...f.o, owner: dog, mover: dog },
        { owner: cat, mover: cat, subject: 'cat', eligible: true, speaking: false },
      ];
      f.step(4, {}, observations);
      const pair = f.observer.cue(dog)?.pair;
      expect(pair).toBeDefined();
      partner.adopt(cat, f.observer);
      leader.adopt(dog, f.observer);
      expect([f.observer.size, partner.size, leader.size]).toEqual([0, 0, 1]);
      expect(leader.cue(dog)?.pair).toBe(pair);
      expect(partner.cue(cat)?.pair).toBe(pair);
      leader.step(3, 19, { rain: 0, clock: (cycle + 1) * 4 + 3 }, observations);
      expect([f.observer.size, partner.size, leader.size]).toEqual([0, 0, 0]);
      expect(f.observer.cue(dog)).toBeUndefined();
      expect(f.observer.cue(cat)).toBeUndefined();
    }
    partner.dispose();
    expect(partner.size).toBe(0);
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
  it('follows a normally voiced purchase for the buyer without a solo vendor reaction', () => {
    const f = fixture();
    const stall: Stall = {
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
    const scenes = new SceneSpeech(1, [
      {
        id: 'order',
        kind: 'talk',
        profile: 'vendor-order',
        turns: 2,
        speakers: [0, 1],
      },
    ]);
    expect(
      scenes.admit(
        {
          key: {},
          speakers: [
            { owner: f.m, member: 0, figure: 'adult' },
            { owner: stall, member: 0, figure: 'adult' },
          ],
          profiles: ['vendor-order'],
          context: { minutes: 720, rain: 0, wind: 0, figures: [] },
          remaining: 3,
          valid: () => true,
        },
        12,
      ),
    ).toBe(true);
    expect(scenes.voiceActive(stall)).toBe(true);
    scenes.step(1.5, true);
    scenes.step(1.5, true);
    expect(scenes.voiceCompletions).toHaveLength(1);
    f.observer.step(3, 19, { rain: 0, clock: 3.1 }, [f.o, vendor], [], scenes.voiceCompletions);
    expect(f.observer.cue(f.m)?.mood).toBe('playful');
    expect(f.observer.cue(stall)).toBeUndefined();
    expect(f.observer.memory.get(stall)!.followups).toHaveLength(0);
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
    for (let i = 0; i < 120; i++) {
      for (const w of [a, b])
        w.step(0.1, undefined, 19, undefined, undefined, {
          rain: i > 80 ? 1 : 0,
          minutes: i > 40 ? 1380 : 720,
          sunAltitude: i > 40 ? -30 : 70,
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
