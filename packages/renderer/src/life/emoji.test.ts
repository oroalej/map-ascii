import { birdFixture } from './testing/bird-fixture';
import { describe, expect, it, vi } from 'vitest';
import { epochDay, emojiGlyph, expandSeasons, type RuntimeSeasonConfig } from '@atlas/shared';
import {
  EmojiObserver,
  EmojiMemory,
  EMOJI,
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
import { simulationSeasons } from './seasonal-simulation';

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
  it('admits explicit cues without chance or cooldown, retaining capacity, speech and a separate owner rate limit', () => {
    const draws = vi.fn(() => 0.99);
    const f = fixture('person', draws);
    const request = {
      owner: f.m,
      subject: 'person' as const,
      mood: 'wave' as const,
      eligible: true,
      speaking: false,
      duration: 0.2,
      expires: 8,
    };
    f.observer.request([request], 19, 0);
    expect(draws).not.toHaveBeenCalled();
    expect(f.observer.cue(f.m)?.mood).toBe('wave');
    f.step(0.3);
    expect(f.observer.cue(f.m)).toBeUndefined();
    f.observer.memory.get(f.m)!.cooldownUntil = 100;
    f.observer.request([request], 19, 0.3);
    expect(f.observer.cue(f.m)).toBeUndefined();
    f.observer.request([request], 19, 1);
    expect(f.observer.cue(f.m)?.mood).toBe('wave');
    expect(f.observer.groups.values().next().value?.end).toBe(1.2);
    f.step(1);
    f.observer.request([{ ...request, speaking: true }], 19, 2);
    expect(f.observer.cue(f.m)).toBeUndefined();
    f.observer.request([request], 17, 3);
    f.observer.request([request], 19, 9);
    expect(f.observer.cue(f.m)).toBeUndefined();
  });
  it('shows relief on shade arrival and excludes ambient heat after arrival', () => {
    const f = fixture();
    f.step(0.1);
    f.o.visit = { state: 'approach', time: 40, site: {} } as Visit;
    f.step(0.1);
    f.o.visit.state = 'shade';
    f.step(0.3, { sunAltitude: 60 });
    expect(f.observer.cue(f.m)?.mood).toBe('relaxed');
    const moods = ambientPool(f.o, { rain: 0, minutes: 720, sunAltitude: 60 }).map((p) => p.mood);
    expect(moods).not.toContain('hot');
    expect(moods).not.toContain('melting');
  });
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
    expect(f.observer.cue(f.m)?.mood).toBe('drooling');
    expect(f.observer.cue(stall)?.mood).toBe('profit');
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
      expect(f.observer.cue(f.m)?.mood).toBe(
        event === 'shelter' ? 'rained' : event === 'grooming' ? 'beauty' : 'happy',
      );
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
    expect(f.observer.cue(f.m)?.mood).toBe('beauty');
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
    expect(b.mood).toBe('sideeye');
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
    expect(f.observer.cue(f.m)?.mood).toBe('gossip');
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
    expect(f.observer.cue(f.m)?.mood).toBe('gossip');
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
describe('funny emoji events', () => {
  const quiet = (f: ReturnType<typeof fixture>) => {
    f.observer.memory.get(f.m)!.attemptAt = Infinity;
  };
  const vendorFor = (f: ReturnType<typeof fixture>): EmojiObservation => ({
    owner: { x: f.m.x, y: f.m.y, hx: 1, hy: 0, paint: 0, shirt: 0, side: 1, rank: 0 },
    subject: 'person',
    figure: 'adult',
    eligible: true,
    speaking: false,
    vendor: true,
  });
  it('latches fast-driver and running-person onsets, baselines gaps, and consumes failed chances', () => {
    for (const kind of ['vehicle', 'person'] as const) {
      const f = fixture(kind);
      f.m.v = 9 * f.tile.perMeter;
      f.step(0);
      quiet(f);
      f.step();
      expect(f.observer.cue(f.m)).toBeUndefined();
      if (kind === 'vehicle') f.m.v = EMOJI.driver.rushSpeed * f.tile.perMeter;
      else f.m.run = 1;
      f.step(0.1);
      expect(f.observer.cue(f.m)).toBeUndefined();
      f.step(0.4);
      expect(f.observer.cue(f.m)?.mood).toBe('rushing');
      f.observer.release(f.m);
      f.observer.memory.get(f.m)!.cooldownUntil = 0;
      const rng = vi.fn(() => 0);
      f.observer.memory.get(f.m)!.rng = rng;
      f.step(3);
      expect(f.observer.cue(f.m)).toBeUndefined();
      expect(rng).not.toHaveBeenCalled();
      f.observer.freeze();
      f.step();
      f.step();
      expect(f.observer.cue(f.m)).toBeUndefined();
      if (kind === 'vehicle') f.m.v = 9 * f.tile.perMeter;
      else f.m.run = 0;
      f.step();
      if (kind === 'vehicle') f.m.v = 10 * f.tile.perMeter;
      else f.m.run = 1;
      rng.mockReturnValue(0.99);
      f.step();
      const rolls = rng.mock.calls.length;
      f.step();
      expect(rng.mock.calls).toHaveLength(rolls);
      expect(f.observer.cue(f.m)).toBeUndefined();
    }
  });
  it('smokes only on an exhaust vehicle pulling away after an observed stop', () => {
    for (const [vehicle, seconds, smoke] of [
      ['jeepney', 1, true],
      ['car', 1, false],
      ['jeepney', 0.5, false],
    ] as const) {
      const f = fixture('vehicle');
      f.m.vehicle = vehicle;
      f.m.v = 0;
      f.step(0);
      quiet(f);
      f.step(seconds);
      f.m.v = f.tile.perMeter;
      f.step();
      expect(f.observer.cue(f.m)?.mood).toBe(smoke ? 'smoke' : undefined);
      f.observer.release(f.m);
      f.observer.memory.get(f.m)!.cooldownUntil = 0;
      f.step();
      expect(f.observer.cue(f.m)).toBeUndefined();
      f.m.v = 0;
      f.step();
      f.step(1);
      f.observer.freeze();
      f.m.v = f.tile.perMeter;
      f.step();
      expect(f.observer.cue(f.m)).toBeUndefined();
    }
  });
  it('honks with a pedestrian sorry reply only after the usual driver chance', () => {
    for (const [chance, variant, mood] of [
      [0, 0, 'honk'],
      [0, 0.9, 'impatient'],
      [0.99, 0, undefined],
    ] as const) {
      const f = fixture('vehicle');
      const person = fixture().o;
      person.owner.x = f.m.x + f.tile.perMeter;
      person.owner.y = f.m.y;
      f.m.hx = 1;
      f.m.hy = 0;
      const observations = [f.o, person];
      f.step(0, {}, observations);
      quiet(f);
      const rng = vi.fn((): number => variant).mockReturnValueOnce(chance);
      f.observer.memory.get(f.m)!.rng = rng;
      f.m.waiting = EMOJI.driver.impatientWait;
      f.step(0.5, {}, observations);
      expect(f.observer.cue(f.m)?.mood).toBe(mood);
      expect(f.observer.cue(person.owner)?.mood).toBe(mood ? 'sorry' : undefined);
      if (mood) expect(f.observer.cue(f.m)?.pair).toBe(f.observer.cue(person.owner)?.pair);
      else expect(rng).toHaveBeenCalledTimes(1);
    }
  });
  it('honks alone at a distant pedestrian and stays impatient when nobody is ahead', () => {
    for (const distance of [5, null]) {
      const f = fixture('vehicle');
      const person = fixture().o;
      person.owner.x = f.m.x + (distance ?? 0) * f.tile.perMeter;
      person.owner.y = f.m.y;
      f.m.hx = 1;
      f.m.hy = 0;
      const observations = distance === null ? [f.o] : [f.o, person];
      f.step(0, {}, observations);
      quiet(f);
      const rng = vi.fn(() => 0);
      f.observer.memory.get(f.m)!.rng = rng;
      f.m.waiting = EMOJI.driver.impatientWait;
      f.step(0.5, {}, observations);
      expect(f.observer.cue(f.m)?.mood).toBe(distance === null ? 'impatient' : 'honk');
      expect(f.observer.cue(f.m)?.pair).toBeUndefined();
      expect(f.observer.cue(person.owner)).toBeUndefined();
      expect(rng).toHaveBeenCalledTimes(distance === null ? 1 : 2);
    }
  });
  it('gossips only for adult completion follow-ups and keeps both original outcomes', () => {
    for (const [figure, share, split, mood] of [
      ['adult', 0, 0, 'gossip'],
      ['adult', 0.9, 0, 'playful'],
      ['adult', 0.9, 0.9, 'thumbs'],
      ['child', 0, 0, 'playful'],
    ] as const) {
      const f = fixture();
      f.o.figure = figure;
      f.step(0);
      quiet(f);
      const rng = vi.fn(() => split).mockReturnValueOnce(0);
      if (figure === 'adult') rng.mockReturnValueOnce(share);
      f.observer.memory.get(f.m)!.rng = rng;
      const token = {};
      f.observer.step(0.5, 19, { rain: 0, clock: 0.5 }, [f.o], [], [{ token, owners: [f.m] }]);
      expect(f.observer.cue(f.m)?.mood).toBe(mood);
      f.observer.release(f.m);
      f.observer.memory.get(f.m)!.cooldownUntil = 0;
      const rolls = rng.mock.calls.length;
      f.observer.step(0.5, 19, { rain: 0, clock: 1 }, [f.o], [], [{ token, owners: [f.m] }]);
      expect(rng.mock.calls).toHaveLength(rolls);
      expect(f.observer.cue(f.m)).toBeUndefined();
    }
  });
  it('varies grooming happy cues without changing unrelated happiness or rerolling rejected cues', () => {
    for (const [kind, action, variant, mood] of [
      ['cat', 'grooming', 0, 'beauty'],
      ['cat', 'grooming', 0.9, 'happy'],
      ['cat', 'trot', 0, 'happy'],
      ['dog', 'grooming', 0, 'happy'],
      ['cat', 'rest', 0, 'happy'],
    ] as const) {
      const f = fixture(kind);
      f.step(0);
      quiet(f);
      f.observer.memory.get(f.m)!.rng = vi.fn(() => variant).mockReturnValueOnce(0);
      if (action === 'grooming') f.m.grooming = true;
      else if (action === 'trot') f.m.trot = 1;
      else f.o.visit = { state: 'rest', time: 1, site: {} } as Visit;
      f.step(0.1);
      f.step(0.4);
      expect(f.observer.cue(f.m)?.mood).toBe(mood);
    }
    const f = fixture('cat');
    f.step(0);
    quiet(f);
    const rng = vi.fn(() => 0.99);
    f.observer.memory.get(f.m)!.rng = rng;
    f.m.grooming = true;
    f.step();
    f.step();
    expect(rng).toHaveBeenCalledTimes(1);
    expect(f.observer.cue(f.m)).toBeUndefined();
  });
  it('varies paired and solo cat standoffs while retaining dog anger and one group', () => {
    for (const paired of [true, false])
      for (const variant of [0, 0.9]) {
        const f = fixture('dog');
        const c = continuityMover(f.tile, f.m.x + 2 * f.tile.perMeter, 'cat');
        c.y = f.m.y;
        const cat: EmojiObservation = {
          owner: c,
          mover: c,
          subject: 'cat',
          eligible: true,
          speaking: false,
        };
        c.x += 10 * f.tile.perMeter;
        f.step(0, {}, [f.o, cat]);
        quiet(f);
        f.observer.memory.get(c)!.attemptAt = Infinity;
        f.observer.memory.get(c)!.rng = paired
          ? () => variant
          : vi.fn(() => variant).mockReturnValueOnce(0);
        if (!paired) f.observer.memory.get(f.m)!.cooldownUntil = 100;
        c.x -= 10 * f.tile.perMeter;
        f.step(0.5, {}, [f.o, cat]);
        expect(f.observer.cue(c)?.mood).toBe(variant === 0 ? 'sideeye' : 'angry');
        expect(f.observer.cue(f.m)?.mood).toBe(paired ? 'angry' : undefined);
        expect(f.observer.size).toBe(1);
        if (paired) expect(f.observer.cue(c)?.pair).toBe(f.observer.cue(f.m)?.pair);
      }
  });
  it('keeps purchase variants together and never blocks a solo buyer on an unavailable vendor', () => {
    for (const available of [true, false])
      for (const variant of [0, 0.9]) {
        const f = fixture();
        const vendor = vendorFor(f);
        vendor.speaking = !available;
        f.step(0, {}, [f.o, vendor]);
        quiet(f);
        f.observer.memory.get(f.m)!.rng = vi.fn(() => variant).mockReturnValueOnce(0);
        f.observer.step(
          0.5,
          19,
          { rain: 0, clock: 0.5 },
          [f.o, vendor],
          [{ mover: f.m, stall: vendor.owner as Stall, key: {} }],
        );
        expect(f.observer.cue(f.m)?.mood).toBe(variant === 0 ? 'drooling' : 'yummy');
        expect(f.observer.cue(vendor.owner)?.mood).toBe(
          available ? (variant === 0 ? 'profit' : 'happy') : undefined,
        );
        expect(f.observer.size).toBe(1);
        if (available) expect(f.observer.cue(f.m)?.pair).toBe(f.observer.cue(vendor.owner)?.pair);
      }
  });
  it('processes buyers before begging dogs in either observation order, including latched purchases', () => {
    for (const dogFirst of [true, false])
      for (const variant of [0, 0.9]) {
        const f = fixture();
        const vendor = vendorFor(f);
        const dog = fixture('dog').o;
        dog.owner.x = f.m.x + 2 * f.tile.perMeter;
        dog.owner.y = f.m.y;
        const observations = dogFirst ? [dog, f.o, vendor] : [f.o, vendor, dog];
        f.step(0, {}, observations);
        quiet(f);
        f.observer.memory.get(f.m)!.rng = vi.fn(() => variant).mockReturnValueOnce(0);
        const purchase = { mover: f.m, stall: vendor.owner as Stall, key: {} };
        f.observer.step(0.1, 19, { rain: 0, clock: 0.1 }, observations, [purchase]);
        f.observer.step(0.4, 19, { rain: 0, clock: 0.5 }, observations);
        expect(f.observer.cue(f.m)?.mood).toBe(variant === 0 ? 'drooling' : 'yummy');
        expect(f.observer.cue(vendor.owner)?.mood).toBe(variant === 0 ? 'profit' : 'happy');
        expect(f.observer.cue(dog.owner)?.mood).toBe('beg');
        expect(f.observer.cue(dog.owner)?.pair).toBeUndefined();
        for (const o of observations) {
          f.observer.release(o.owner);
          const t = f.observer.memory.get(o.owner)!;
          t.cooldownUntil = 0;
          t.attemptAt = Infinity;
        }
        f.observer.step(0.5, 19, { rain: 0, clock: 1 }, observations, [purchase]);
        expect(observations.every((o) => !f.observer.cue(o.owner))).toBe(true);
      }
  });
  it('pairs begging only within pair reach after a failed purchase, excludes distant dogs and cats', () => {
    for (const [kind, distance, mood, paired] of [
      ['dog', 2, 'beg', true],
      ['dog', 3.5, 'beg', false],
      ['dog', 4, 'beg', false],
      ['dog', 4.1, undefined, false],
      ['cat', 2, undefined, false],
    ] as const) {
      const f = fixture();
      const vendor = vendorFor(f);
      const pet = fixture(kind).o;
      pet.owner.x = f.m.x + distance * f.tile.perMeter;
      pet.owner.y = f.m.y;
      const observations = [pet, f.o, vendor];
      f.step(0, {}, observations);
      quiet(f);
      f.observer.memory.get(f.m)!.rng = () => 0.99;
      f.observer.step(0.5, 19, { rain: 0, clock: 0.5 }, observations, [
        { mover: f.m, stall: vendor.owner as Stall, key: {} },
      ]);
      expect(f.observer.cue(pet.owner)?.mood, `${kind} at ${distance} m`).toBe(mood);
      expect(f.observer.cue(f.m)?.mood).toBe(paired ? 'sorry' : undefined);
      if (paired) expect(f.observer.cue(pet.owner)?.pair).toBe(f.observer.cue(f.m)?.pair);
    }
  });
  it('cries at person and driver wait thresholds once, excludes held owners and baselines gaps', () => {
    for (const kind of ['person', 'vehicle'] as const)
      for (const held of [false, true]) {
        const f = fixture(kind);
        f.o.held = held;
        const threshold = kind === 'person' ? EMOJI.person.impatientWait : EMOJI.driver.angryStop;
        f.step(0);
        quiet(f);
        f.observer.memory.get(f.m)!.rng = () => 0.99;
        f.m.waiting = threshold - 0.5;
        f.step();
        expect(f.observer.cue(f.m)).toBeUndefined();
        f.observer.memory.get(f.m)!.rng = () => 0;
        f.m.waiting = threshold;
        f.step();
        expect(f.observer.cue(f.m)?.mood).toBe(held ? undefined : 'crying');
        f.observer.release(f.m);
        f.observer.memory.get(f.m)!.cooldownUntil = 0;
        const rng = vi.fn(() => 0);
        f.observer.memory.get(f.m)!.rng = rng;
        f.step();
        f.step();
        expect(rng).not.toHaveBeenCalled();
        f.observer.freeze();
        f.step();
        f.step();
        expect(f.observer.cue(f.m)).toBeUndefined();
        f.observer.memory.reset();
        f.step();
        f.step();
        quiet(f);
        expect(f.observer.cue(f.m)).toBeUndefined();
      }
  });
  it('uses observed queue and stop duration without inventing elapsed time after a gap', () => {
    for (const kind of ['person', 'vehicle'] as const) {
      const f = fixture(kind, () => 0.99);
      if (kind === 'person') f.o.visit = { state: 'wait', time: 100, site: {} } as Visit;
      else f.m.v = 0;
      f.step(0);
      quiet(f);
      const threshold = kind === 'person' ? EMOJI.person.impatientWait : EMOJI.driver.angryStop;
      for (let i = 0; i < (threshold - 0.5) * 2; i++) f.step();
      expect(f.observer.cue(f.m)).toBeUndefined();
      f.observer.memory.get(f.m)!.rng = () => 0;
      f.step();
      expect(f.observer.cue(f.m)?.mood).toBe('crying');
      f.observer.release(f.m);
      f.observer.memory.get(f.m)!.cooldownUntil = 0;
      f.observer.freeze();
      f.step(100);
      expect(f.observer.memory.get(f.m)![kind === 'person' ? 'wait' : 'stop']).toBe(0);
      expect(f.observer.cue(f.m)).toBeUndefined();
    }
  });
  it('confuses only fresh blocked-turn markers, latches zero, and rebaselines observation gaps', () => {
    const f = fixture();
    f.step(0);
    quiet(f);
    f.m.turning = { hx: 1, hy: 0, left: 1 };
    f.step();
    expect(f.observer.cue(f.m)).toBeUndefined();
    f.m.turnedAt = 0;
    f.step(0.1);
    expect(f.observer.cue(f.m)).toBeUndefined();
    f.step(0.4);
    expect(f.observer.cue(f.m)?.mood).toBe('confused');
    f.observer.release(f.m);
    f.observer.memory.get(f.m)!.cooldownUntil = 0;
    f.m.turning = undefined;
    f.step();
    f.m.turning = { hx: -1, hy: 0, left: 1 };
    f.step();
    expect(f.observer.cue(f.m)).toBeUndefined();
    f.observer.freeze();
    f.m.turnedAt = 5;
    f.step();
    f.step();
    expect(f.observer.cue(f.m)).toBeUndefined();
    f.m.turnedAt = 6;
    f.step();
    expect(f.observer.cue(f.m)?.mood).toBe('confused');
  });
});
describe('emoji ambient eligibility', () => {
  const worshipper = () => {
    const builder = new LifeBuilder();
    builder.place({ x: 2000, y: 2000 }, 'worship', 80);
    const tile = new TileLife(left, builder.finish(), 123);
    const g = tile.gatherers[0]!;
    g.pause = 2;
    g.rank = 0;
    tile.gatherers.splice(0, tile.gatherers.length, g);
    tile.movers.length = tile.stalls.length = 0;
    const read = tile as unknown as { emojiObservations(env: LifeEnv): EmojiObservation[] };
    const o = read.emojiObservations({ rain: 0, levels: activityLevels(1) })[0]!;
    expect(o.eligible).toBe(true);
    expect(o.still).toBeUndefined();
    return { g, o };
  };
  const moods = (o: EmojiObservation, env: LifeEnv) => ambientPool(o, env).map((p) => p.mood);
  it('limits mosquitoes to still people in the dusk window, including real paused and seated gatherers', () => {
    const { o, g } = worshipper();
    for (const [minutes, eligible] of [
      [1049, false],
      [1050, true],
      [1169, true],
      [1170, false],
      [undefined, false],
    ] as const)
      expect(moods(o, { rain: 0, minutes }).includes('mosquito')).toBe(eligible);
    g.pause = 0;
    expect(moods(o, { rain: 0, minutes: 1080 })).not.toContain('mosquito');
    g.behavior = 'sit';
    expect(moods(o, { rain: 0, minutes: 1080 })).toContain('mosquito');
    const f = fixture();
    f.o.still = true;
    expect(moods(f.o, { rain: 0, minutes: 1080 })).toContain('mosquito');
    f.o.still = false;
    expect(moods(f.o, { rain: 0, minutes: 1080 })).not.toContain('mosquito');
    expect(moods({ ...o, subject: 'cat' }, { rain: 0, minutes: 1080 })).not.toContain('mosquito');
  });
  it('offers videoke only to non-worship person gatherers during evening hours', () => {
    const { o, g } = worshipper();
    g.place = 'monument';
    for (const [minutes, eligible] of [
      [1139, false],
      [1140, true],
      [1379, true],
      [1380, false],
      [undefined, false],
    ] as const)
      expect(moods(o, { rain: 0, minutes }).includes('karaoke')).toBe(eligible);
    g.place = 'worship';
    expect(moods(o, { rain: 0, minutes: 1200 })).not.toContain('karaoke');
    expect(moods(o, { rain: 0, minutes: 1200 })).toContain('music');
    g.place = 'monument';
    g.behavior = 'sit';
    expect(moods(o, { rain: 0, minutes: 1200 })).not.toContain('karaoke');
    g.behavior = 'gather';
    expect(moods({ ...o, subject: 'dog' }, { rain: 0, minutes: 1200 })).not.toContain('karaoke');
    expect(moods(fixture().o, { rain: 0, minutes: 1200 })).not.toContain('karaoke');
  });
  it('sneezes in exposed rain or resolved storm, without a time restriction', () => {
    const f = fixture();
    expect(
      ambientPool(f.o, { rain: EMOJI.rainThreshold }).find((p) => p.mood === 'sneeze')?.weight,
    ).toBe(1);
    expect(moods(f.o, { rain: EMOJI.rainThreshold - 0.01 })).not.toContain('sneeze');
    f.o.visit = { state: 'shelter', time: 1, site: {} } as Visit;
    expect(moods(f.o, { rain: 1 })).not.toContain('sneeze');
    expect(moods(f.o, { rain: 0, windPreset: 'storm' })).toContain('sneeze');
    expect(moods(f.o, { rain: 0, windPreset: 'gusty' })).not.toContain('sneeze');
    for (const kind of ['vehicle', 'dog', 'cat'] as const)
      expect(moods(fixture(kind).o, { rain: 1, windPreset: 'storm' })).not.toContain('sneeze');
  });
  it('melts only hot-eligible people and open drivers, keeping pet heat and excluding wet or low sun', () => {
    const hot = { rain: 0, minutes: 720, sunAltitude: EMOJI.hotAltitude };
    const person = fixture();
    expect(ambientPool(person.o, hot).find((p) => p.mood === 'melting')?.weight).toBe(0.5);
    for (const env of [
      { ...hot, rain: 0.01 },
      { ...hot, sunAltitude: EMOJI.hotAltitude - 1 },
      { ...hot, sunAltitude: undefined },
      { ...hot, minutes: 659 },
      { ...hot, minutes: 870 },
    ]) {
      expect(moods(person.o, env)).not.toContain('melting');
      expect(moods(person.o, env)).not.toContain('hot');
    }
    for (const vehicle of [
      'car',
      'bus',
      'truck',
      'motorcycle',
      'bicycle',
      'tricycle',
      'jeepney',
    ] as const) {
      const f = fixture('vehicle');
      f.m.vehicle = vehicle;
      expect(moods(f.o, hot).includes('melting')).toBe(
        ['motorcycle', 'bicycle', 'tricycle', 'jeepney'].includes(vehicle),
      );
    }
    for (const kind of ['cat', 'dog'] as const) {
      const f = fixture(kind);
      f.o.still = true;
      expect(moods(f.o, hot)).toContain('hot');
      expect(moods(f.o, hot)).not.toContain('melting');
    }
  });
  it('reserves silly for children playing at a place', () => {
    const { o, g } = worshipper();
    g.behavior = 'play';
    o.figure = 'child';
    expect(ambientPool(o, { rain: 0 }).find((p) => p.mood === 'silly')?.weight).toBe(1);
    o.figure = 'adult';
    expect(moods(o, { rain: 0 })).not.toContain('silly');
    o.figure = 'child';
    g.behavior = 'gather';
    expect(moods(o, { rain: 0 })).not.toContain('silly');
    g.behavior = 'play';
    expect(moods({ ...o, subject: 'cat' }, { rain: 0 })).not.toContain('silly');
    expect(moods({ ...fixture().o, figure: 'child' }, { rain: 0 })).not.toContain('silly');
  });
  it('reads paused worship eligibility from the real projection while keeping prayer dominant', () => {
    const { o, g } = worshipper();
    const env: LifeEnv = {
      rain: 0,
      minutes: 480,
      date: { epochDay: 1, weekday: 0, preview: false },
    };
    const paused = ['moved', 'crying', 'angelic', 'hush', 'yawn'] as const;
    for (const mood of [...paused, 'music'] as const)
      expect(ambientPool(o, env).find((p) => p.mood === mood)?.weight).toBe(EMOJI.churchWeight);
    expect(ambientPool(o, env).find((p) => p.mood === 'pray')?.weight).toBe(4.5);
    expect(emojiGlyph('person', 'crying')).toBe('😭');
    g.pause = 0;
    o.still = true;
    for (const mood of paused) expect(moods(o, env)).not.toContain(mood);
    expect(moods(o, env)).toContain('music');
    g.pause = 2;
    for (const subject of ['driver', 'dog', 'cat'] as const)
      for (const mood of [...paused, 'music'] as const)
        expect(moods({ ...o, subject }, env)).not.toContain(mood);
    g.place = 'monument';
    for (const mood of [...paused, 'music'] as const) expect(moods(o, env)).not.toContain(mood);
    g.place = 'worship';
    g.behavior = 'sit';
    for (const mood of [...paused, 'music'] as const) expect(moods(o, env)).not.toContain(mood);
  });
  it('yawns only for a paused worship gatherer in the city morning window', () => {
    const { o, g } = worshipper();
    for (const [minutes, eligible] of [
      [299, false],
      [300, true],
      [539, true],
      [540, false],
      [undefined, false],
    ] as const)
      expect(moods(o, { rain: 0, minutes }).includes('yawn')).toBe(eligible);
    g.pause = 0;
    expect(moods(o, { rain: 0, minutes: 330 })).not.toContain('yawn');
  });
  it('remembers only a selected grave-visitation season, including a composed season and preview', () => {
    const { o, g } = worshipper();
    const calendar: RuntimeSeasonConfig = {
      id: 'remembrance',
      title: { en: 'Remembrance' },
      window: { from: { month: 3, day: 1 }, to: { month: 3, day: 2 } },
      visitors: {
        label: 'Families',
        share: 1,
        per_grave_family: [2, 3],
        max_per_tile: 10,
        hours: [
          [0, 1],
          [23, 1],
        ],
      },
    };
    const included: RuntimeSeasonConfig = {
      id: 'combined',
      title: { en: 'Combined' },
      window: calendar.window,
      includes: ['remembrance'],
    };
    const table = simulationSeasons(expandSeasons([calendar, included]));
    for (const season of [undefined, null, 'absent'])
      expect(moods(o, { rain: 0, season, emojiSeasons: table })).not.toContain('candle');
    expect(moods(o, { rain: 0, season: calendar.id })).not.toContain('candle');
    expect(
      moods(o, { rain: 0, season: calendar.id, emojiSeasons: [{ id: calendar.id }] }),
    ).not.toContain('candle');
    for (const season of ['remembrance', 'combined'])
      for (const preview of [false, true]) {
        const env: LifeEnv = {
          rain: 0,
          season,
          emojiSeasons: table,
          date: { epochDay: 1, weekday: 1, preview },
        };
        const pool = ambientPool(o, env);
        expect(pool.find((p) => p.mood === 'candle')?.weight).toBe(EMOJI.churchWeight);
        expect(pool.find((p) => p.mood === 'pray')?.weight).toBe(1.5);
        expect(
          pool
            .filter((p) =>
              ['moved', 'crying', 'angelic', 'hush', 'music', 'candle'].includes(p.mood),
            )
            .every((p) => p.weight < 1.5),
        ).toBe(true);
      }
    // Exercise the observer's cached selection through real ambient admissions.
    g.pause = 0;
    const observer = new EmojiObserver(123, 1, { rng: () => 0 });
    observer.step(0, 19, { rain: 0, clock: 0 }, [o]);
    const track = observer.memory.get(o.owner)!;
    let clock = 0;
    for (const [emojiSeasons, season, mood] of [
      [table, 'remembrance', 'candle'],
      [table, 'absent', 'happy'],
      [table, 'remembrance', 'candle'],
      [[{ id: 'remembrance' }], 'remembrance', 'happy'],
      [table, 'remembrance', 'candle'],
      [table, null, 'happy'],
      [table, 'combined', 'candle'],
      [undefined, 'combined', 'happy'],
    ] as const) {
      observer.release(o.owner);
      track.cooldownUntil = 0;
      track.attemptAt = clock += 0.5;
      // With no stationary choices, this selects candle when present, else happy.
      track.rng = vi.fn(() => 0.08).mockReturnValueOnce(0);
      observer.step(0.5, 19, { rain: 0, clock, emojiSeasons, season }, [o]);
      expect(observer.cue(o.owner)?.mood).toBe(mood);
    }
    g.place = 'monument';
    expect(moods(o, { rain: 0, season: calendar.id, emojiSeasons: table })).not.toContain('candle');
  });
  it('retains normal temperament weighting for new weather and music choices', () => {
    const { o, g } = worshipper();
    g.place = 'monument';
    const rankFor = (kind: ReturnType<typeof temperament>) =>
      Array.from({ length: 100 }, (_, i) => i / 100).find((rank) => temperament(rank) === kind)!;
    for (const [kind, weight] of [
      ['neutral', 1.5],
      ['cheerful', 3],
      ['sleepy', 0.75],
    ] as const) {
      g.rank = rankFor(kind);
      expect(
        ambientPool(o, { rain: 0, minutes: 1200 }).find((p) => p.mood === 'karaoke')?.weight,
      ).toBe(weight);
    }
    g.rank = rankFor('grumpy');
    const pool = ambientPool(o, { rain: 1, minutes: 1080 });
    expect(pool.find((p) => p.mood === 'mosquito')?.weight).toBe(3);
    expect(pool.find((p) => p.mood === 'sneeze')?.weight).toBe(2);
    g.rank = rankFor('cheerful');
    g.place = 'worship';
    expect(ambientPool(o, { rain: 0 }).find((p) => p.mood === 'music')?.weight).toBe(
      EMOJI.churchWeight * 2,
    );
  });
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

describe('event-only bird fear', () => {
  const bird = () => {
    const { flock } = birdFixture();
    const observer = new EmojiObserver(123, 1, { rng: () => 0 });
    const o: EmojiObservation = { owner: flock, subject: 'bird', eligible: true, speaking: false };
    const step = (clock: number, events: (typeof flock)[] = [], observations = [o]) =>
      observer.step(
        0.1,
        19,
        {
          rain: 1,
          clock,
          minutes: 1200,
          season: 'birds',
          emojiSeasons: [{ id: 'birds', emoji: [{ mood: 'gift', subjects: ['bird'], weight: 1 }] }],
        },
        observations,
        [],
        [],
        events,
      );
    return { flock, observer, o, step };
  };
  it('latches a first observation between ticks, expires after 2.5 seconds and respects cooldown', () => {
    const f = bird();
    f.step(0.1, [], []);
    f.step(0.2, [f.flock]);
    expect(f.observer.cue(f.flock)).toBeUndefined();
    f.step(0.3);
    f.step(0.4);
    f.step(0.5);
    expect(f.observer.cue(f.flock)).toMatchObject({ subject: 'bird', mood: 'scared' });
    f.step(2.99);
    expect(f.observer.cue(f.flock)).toBeDefined();
    f.step(3);
    expect(f.observer.cue(f.flock)).toBeUndefined();
    f.step(3.1, [f.flock]);
    f.step(3.5);
    expect(f.observer.cue(f.flock)).toBeUndefined();
    f.step(45.5, [f.flock]);
    expect(f.observer.cue(f.flock)?.mood).toBe('scared');
  });
  it.each([false, true])('releases fear on eligibility loss (active=%s)', (active) => {
    const f = bird();
    f.step(0.1, [], []);
    f.step(0.2, [f.flock]);
    if (active) f.step(0.5);
    f.o.eligible = false;
    f.step(active ? 0.6 : 0.3);
    expect(f.observer.cue(f.flock)).toBeUndefined();
    expect(f.observer.memory.get(f.flock)!.edges.size).toBe(0);
    f.o.eligible = true;
    f.step(1);
    expect(f.observer.cue(f.flock)).toBeUndefined();
  });
  it('never samples person, ambient or bird-subject seasonal moods', () => {
    const f = bird();
    for (let i = 1; i <= 1500; i++) f.step(i * 0.1);
    expect(f.observer.size).toBe(0);
    expect(f.observer.memory.get(f.flock)!.attemptAt).toBeUndefined();
  });
  it('keeps the shared tile capacity across simultaneous startled flocks', () => {
    const f = bird();
    const flocks = Array.from({ length: 8 }, () => birdFixture().flock);
    const observations = flocks.map((owner): EmojiObservation => ({
      owner,
      subject: 'bird',
      eligible: true,
      speaking: false,
    }));
    f.step(0.5, flocks, observations);
    expect(f.observer.size).toBe(EMOJI.capacity);
    expect(flocks.filter((owner) => f.observer.cue(owner))).toHaveLength(EMOJI.capacity);
    expect(flocks.every((owner) => !f.observer.memory.get(owner)!.edges.size)).toBe(true);
  });
});
