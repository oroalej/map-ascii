import { birdFixture, birdPoint, birdLngLat } from './testing/bird-fixture';
import { afterEach, expect, it, vi } from 'vitest';
import { epochDay, expandSeasons, type RuntimeSeasonConfig } from '@atlas/shared';
import { LifeBuilder, LifeLine } from './geometry';
import { LifeWorld, type Mover, type TileLife } from './simulate';
import { simulationSeasons } from './seasonal-simulation';
import { completeScenarioState, SCENARIO_DIALOGUE } from './testing/scenarios';
import { left, right } from './testing/continuity';
import type { DialogueMemory } from './dialogue';
import type { EmojiObservation } from './emoji';
import type { Visit } from './interactions';
import { pedestrianWorld } from './testing/pedestrians';

afterEach(() => vi.restoreAllMocks());

it('keeps emoji deadlines on elapsed time through slow frames without advancing movement faster', () => {
  const a = pedestrianWorld();
  const b = pedestrianWorld();
  for (const { world, life, human } of [a, b]) {
    world.setEmojiView([19, 1, [0, 0]]);
    // Fix only observer rolls so the earliest permitted ambient opportunity is deterministic.
    world.emojiMemory.track(
      human,
      0,
      () => 0,
      () => 0,
    );
    vi.spyOn(life.momentHost, 'speaking').mockReturnValue(false);
  }
  const weather = { rain: 0, minutes: 720, sunAltitude: 70 };
  a.world.step(0.1, undefined, 19, undefined, undefined, weather);
  b.world.step(0.1, undefined, 19, undefined, undefined, weather);
  const deadline = a.world.emojiMemory.get(a.human)!.attemptAt!;
  expect(deadline).toBeCloseTo(2.1);
  for (let frame = 0; frame < 3; frame++) {
    a.world.step(1, undefined, 19, undefined, undefined, weather);
    b.world.step(0.1, undefined, 19, undefined, undefined, weather);
    expect(completeScenarioState(a.world)).toEqual(completeScenarioState(b.world));
  }
  expect(a.world.signalClock).toBeCloseTo(0.4);
  expect(a.life.emoji.cue(a.human)).toBeDefined();
  expect(b.life.emoji.cue(b.human)).toBeUndefined();
  const track = a.world.emojiMemory.get(a.human)!;
  expect(track.attemptAt).toBeCloseTo(62.1);
  const cue = a.life.emoji.cue(a.human);
  a.world.step(0, undefined, 19, undefined, undefined, weather);
  expect(a.life.emoji.cue(a.human)).toEqual(cue);
  expect(track.clock).toBeCloseTo(3.1);
  a.world.step(2, undefined, 19, undefined, undefined, weather);
  expect(a.life.emoji.cue(a.human)).toBeUndefined();
});

it('reuses borrowed inputs without keeping actor references or stale passenger and visit fields', () => {
  const { world, life, car, human } = pedestrianWorld();
  world.setEmojiView([19, 1, [0, 0]]);
  const visit = { state: 'wait', time: 1, site: {} } as Visit;
  life.scenes.visits.set(car, visit);
  life.scenes.services.set(car, {
    site: visit.site,
    time: 1,
    boarded: 0,
    arriving: false,
    passenger: human,
  });
  vi.spyOn(life.scenes, 'step').mockImplementation(() => {});
  vi.spyOn(life.momentHost, 'step').mockImplementation(() => {});
  const step = life.emoji.step.bind(life.emoji);
  const borrowed: EmojiObservation[][] = [],
    samples: EmojiObservation[][] = [];
  vi.spyOn(life.emoji, 'step').mockImplementation((...args) => {
    borrowed.push([...args[3]]);
    samples.push(args[3].map((input) => ({ ...input })));
    step(...args);
  });
  world.step(0.1, undefined, 19, undefined, undefined, { rain: 0 });
  expect(samples[0]![0]).toMatchObject({ owner: car, passenger: human, visit });
  for (const input of borrowed[0]!)
    expect([input.owner, input.mover, input.gatherer, input.visit, input.passenger]).toEqual(
      Array(5).fill(undefined),
    );
  life.scenes.visits.clear();
  life.scenes.services.clear();
  life.movers.splice(0, 1);
  world.step(0.1, undefined, 19, undefined, undefined, { rain: 0 });
  expect(borrowed[1]![0]).toBe(borrowed[0]![0]);
  expect(samples[1]![0]).toMatchObject({
    owner: human,
    subject: 'person',
    passenger: undefined,
    visit: undefined,
    vendor: undefined,
    gatherer: undefined,
  });
  for (const input of borrowed[0]!) expect(input.owner).toBeUndefined();
});

it('reuses observer records across vendor, mover and gatherer roles without stale flags', () => {
  const { life, car, human } = pedestrianWorld();
  const read = life as unknown as {
    emojiObservations: (env: { rain: number }) => EmojiObservation[];
  };
  life.movers.length = 0;
  const stall = {
    x: human.x,
    y: human.y,
    hx: 1,
    hy: 0,
    paint: 0,
    shirt: 0,
    side: 1 as const,
    rank: 0,
  };
  life.stalls.push(stall);
  const pooled = read.emojiObservations({ rain: 0 })[0]!;
  expect(pooled).toMatchObject({ owner: stall, vendor: true, figure: 'adult' });

  life.stalls.length = 0;
  car.pause = 1;
  life.movers.push(car);
  const moving = read.emojiObservations({ rain: 0 })[0]!;
  expect(moving).toBe(pooled);
  expect(moving).toMatchObject({
    owner: car,
    vendor: undefined,
    figure: undefined,
    held: false,
    arrival: false,
    still: true,
  });

  life.movers.length = 0;
  const gatherer = {
    place: 'fountain' as const,
    behavior: 'gather' as const,
    cx: human.x,
    cy: human.y,
    inner: 0,
    outer: 1,
    x: human.x,
    y: human.y,
    hx: human.hx,
    hy: human.hy,
    tx: human.x,
    ty: human.y,
    speed: 0,
    pause: 0,
    walked: 0,
    rank: 0,
    walker: { ...human.group![0]!, figure: 'child' as const },
    rx: 1,
    ry: 0,
    sign: 1 as const,
  };
  life.gatherers.push(gatherer);
  const gathered = read.emojiObservations({ rain: 0 })[0]!;
  expect(gathered).toBe(pooled);
  expect(gathered).toMatchObject({
    owner: gatherer,
    gatherer,
    mover: undefined,
    figure: 'child',
    vendor: undefined,
    held: undefined,
    arrival: undefined,
    still: undefined,
  });

  life.gatherers.length = 0;
  life.stalls.push(stall);
  const vendor = read.emojiObservations({ rain: 0 })[0]!;
  expect(vendor).toBe(pooled);
  expect(vendor).toMatchObject({
    owner: stall,
    gatherer: undefined,
    vendor: true,
    figure: 'adult',
  });
});

function speechState(tile: TileLife) {
  const owners = [...tile.movers, ...tile.gatherers, ...tile.stalls];
  const memory = tile.momentHost.moments.selector.memory;
  const history = memory as unknown as {
    actors: WeakMap<object, string[]>;
    speechCooldown: WeakMap<object, number>;
    ambientCooldown: WeakMap<object, number>;
    attempts: WeakMap<object, number>;
    outcomes: boolean[];
  };
  const scenes = tile.momentHost.scenes as unknown as {
    active: {
      dialogue: unknown;
      start: number;
      turn: number;
      id: number;
      voiced: boolean;
      scene: { speakers: { owner: object; member: number; figure: string }[] };
    }[];
    selector: { memory: DialogueMemory };
  };
  return structuredClone({
    cues: owners.map((owner) => [
      tile.momentHost.moments.speech(owner),
      tile.momentHost.scenes.speech(owner),
    ]),
    active: scenes.active.map(({ scene, ...rest }) => ({
      ...rest,
      speakers: scene.speakers.map(({ owner, ...speaker }) => ({
        ...speaker,
        owner: owners.indexOf(owner as Mover),
      })),
    })),
    recent: memory.recent,
    outcomes: history.outcomes,
    histories: owners.map((owner) => [
      history.actors.get(owner),
      history.speechCooldown.get(owner),
      history.ambientCooldown.get(owner),
      history.attempts.get(owner),
    ]),
  });
}

it('preserves complete mixed-world and speech state through real pairs, seasons and retirement', () => {
  const builder = new LifeBuilder();
  builder.line(
    [
      { x: 0, y: 2000 },
      { x: 4095, y: 2000 },
    ],
    LifeLine.roadMajor,
    6,
    77,
  );
  builder.line(
    [
      { x: 0, y: 2050 },
      { x: 4095, y: 2050 },
    ],
    LifeLine.path,
    0,
    78,
  );
  builder.market({ x: 2000, y: 2050 });
  builder.place({ x: 1200, y: 1200 }, 'worship', 40);
  builder.place({ x: 2500, y: 2500 }, 'pitch', 100);
  const entry = { key: `${left.z}/${left.x}/${left.y}`, tile: left, life: builder.finish() };
  const window = { from: { month: 12, day: 1 }, to: { month: 1, day: 6 } } as const;
  const seasons: RuntimeSeasonConfig[] = [
    {
      id: 'base',
      title: { en: 'Base' },
      window,
      emoji: [{ mood: 'gift', subjects: ['person'], weight: 1 }],
    },
    {
      id: 'special',
      title: { en: 'Special' },
      window,
      includes: ['base'],
      emoji: [{ mood: 'scared', subjects: ['dog', 'cat'], weight: 1 }],
    },
  ];
  const a = new LifeWorld(undefined, undefined, { dialogue: SCENARIO_DIALOGUE });
  const b = new LifeWorld(undefined, undefined, { dialogue: SCENARIO_DIALOGUE }, false, false);
  for (const world of [a, b]) {
    world.setSeasons(simulationSeasons(expandSeasons(seasons)));
    world.sync([structuredClone(entry)]);
    world.setEmojiView([19, 1, [0, 0]]);
    const tile = world.resident(entry.key)!;
    const people = tile.movers.filter((m) => m.kind === 'person').slice(0, 4);
    const driver = tile.movers.find((m) => m.kind === 'vehicle')!;
    expect(people).toHaveLength(4);
    expect(driver).toBeDefined();
    expect(tile.gatherers.length).toBeGreaterThan(0);
    expect(tile.stalls.length).toBeGreaterThan(0);
    const pets = (['dog', 'cat'] as const).map((kind, i): Mover => ({
      ...structuredClone(people[0]!),
      kind,
      group: undefined,
      rank: 0,
      x: 700 + i * 2 * tile.perMeter,
      d: 700 + i * 2 * tile.perMeter,
      y: 2050,
      line: 1,
      from: 2,
      speed: 0,
      v: 0,
      pause: 60,
      lying: true,
    }));
    tile.movers.splice(0, tile.movers.length, ...people, driver, ...pets);
    // Force only the observer's standoff roll; physical RNG streams are untouched.
    for (const pet of pets)
      world.emojiMemory.track(
        pet,
        0,
        () => 0,
        () => 0,
      );
  }
  let paired = false,
    spoke = false;
  for (let frame = 0; frame < 120; frame++) {
    for (const world of [a, b]) {
      if (frame === 40) world.sync([]);
      if (frame === 45) world.sync([structuredClone(entry)]);
      if (frame === 75)
        world.sync([entry, { ...entry, key: `${right.z}/${right.x}/${right.y}`, tile: right }]);
      world.step(0.1, undefined, 19, undefined, undefined, {
        rain: frame > 90 ? 1 : 0,
        minutes: frame < 60 ? 720 : 1380,
        sunAltitude: frame < 60 ? 70 : -30,
        windPreset: frame > 90 ? 'storm' : 'gusty',
        date: { epochDay: epochDay(2026, 12, 24), weekday: 4, preview: frame > 60 },
        season: frame > 60 ? 'special' : null,
      });
    }
    const current = a.resident(entry.key);
    paired ||= !!current?.movers.some((m) => a.emojiMemory.cue(m)?.pair);
    if (current)
      spoke ||= [...current.movers, ...current.gatherers, ...current.stalls].some(
        (owner) =>
          !!(current.momentHost.moments.speech(owner) || current.momentHost.scenes.speech(owner)),
      );
    if (frame % 15 === 0 || frame === 119) {
      expect(completeScenarioState(a)).toEqual(completeScenarioState(b));
      if (current) expect(speechState(current)).toEqual(speechState(b.resident(entry.key)!));
    }
  }
  expect(paired).toBe(true);
  expect(spoke).toBe(true);
});

it('keeps actual pointer-flushed flock state identical with the observer enabled or disabled', () => {
  const on = birdFixture('pigeon', { observer: true });
  const off = birdFixture('pigeon', { observer: false });
  for (const f of [on, off]) Object.assign(f.flock, birdPoint(50, 0), { perched: true, perch: 0 });
  let seen = false;
  for (let frame = 0; frame < 120; frame++) {
    const pointer = frame < 60 ? birdLngLat(50, 0) : undefined;
    on.step(pointer);
    off.step(pointer);
    expect(completeScenarioState(on.world)).toEqual(completeScenarioState(off.world));
    seen ||= on.visible().some((a) => a.emoji?.subject === 'bird' && a.emoji.mood === 'scared');
    expect(off.visible().some((a) => a.emoji)).toBe(false);
    if (frame === 0) expect(on.flock.perched).toBe(false);
  }
  expect(seen).toBe(true);
});
