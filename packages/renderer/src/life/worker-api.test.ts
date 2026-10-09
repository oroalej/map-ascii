import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as MomentsModule from './moments';
import { continuityMover, continuityTile, left, parent, right } from './testing/continuity';
import { createInlineHost } from './inline-host';
import { LifePreparation } from './preparation';
import { LifeWorld, TileLife } from './simulate';
import type { SimulationSeason } from './seasonal-simulation';
import { completeScenarioState, makeScenario, worldTiles } from './testing/scenarios';
import { pedestrianEntry, seedPedestrians } from './testing/pedestrians';
import { createLifeWorkerApi, runLifeFrame, type FrameInput } from './worker-api';
import { placeGrid } from '../grid';
import { treeGust } from '../glyphs/select';
import type { DialogueChoice, ProcessionRoute } from '@atlas/shared';
import { LifeBuilder } from './geometry';
import { activityLevels } from './config';
import { ensureVehicleEffects } from './vehicle-effects';
import { emitter } from './exhaust';
import { BRAKE } from './lamps';
import { emergencyConfig, emergencyFixture } from './testing/emergency';
import { metersPerUnit, tileToLngLat } from '../raster/geometry';
import { folkloreConfig, folkloreTile, folkloreCenter, calendar } from './testing/folklore';
import { signalState } from './signals';
import { birdFixture, birdLngLat } from './testing/bird-fixture';
import { deliver } from './testing/worker-reply';
import { RecentKeys, RETAINED_LIFE_TILES } from './recent-keys';
import type * as ComlinkModule from 'comlink';
import { packAgents, packedTransferables, unpackAgents } from './agent-frame';
import type { VisibleAgent } from './simulate';
it('transports pressed canonical signal phases equally and retains them through tile replacement', () => {
  const builder = new LifeBuilder();
  builder.signal({ x: 2048, y: 2048 }, 8, 90, 0, true, undefined, { seed: 0 });
  const entry = { key: 'signal', tile: left, life: builder.finish() },
    center = tileToLngLat(left, { x: 2048, y: 2048 });
  const direct = new LifeWorld(),
    api = createLifeWorkerApi(() => 0);
  direct.enableTaps();
  direct.sync([entry]);
  api.init({ processions: [], tapTargets: true });
  api.sync([entry]);
  const input: FrameInput = {
    gust: {
      camera: { lng: center[0], lat: center[1], zoom: 19 },
      size: { width: 800, height: 600 },
      cssCell: { w: 5, h: 9 },
      time: 0,
      wind: { dir: [1, 0], strength: 0 },
    },
    step: {
      dt: 0,
      zoom: 19,
      cellMeters: 1,
      bounds: undefined,
      wind: undefined,
      weather: undefined,
    },
    visible: [19, 1, center],
  };
  const first = runLifeFrame(direct, input);
  expect(deliver(api.frame(input)).signalOffsets).toBeUndefined();
  input.step.taps = [
    {
      id: 1,
      generation: 1,
      frame: first.tapFrame!,
      at: center,
      pointer: 'touch',
      cellMeters: 1,
      signal: { seed: 0, midBlock: false },
    },
  ];
  const result = runLifeFrame(direct, input),
    remote = deliver(api.frame(input));
  expect(remote.signalOffsets).toEqual(result.signalOffsets);
  expect(remote.tapReceipts).toEqual([{ id: 1, action: 'signal' }]);
  expect(signalState(0, remote.signalClock, false, remote.signalOffsets).a).toBe('amber');
  input.step.taps = undefined;
  const replacement = { ...entry, key: 'replacement' };
  direct.sync([replacement]);
  api.sync([replacement]);
  expect(runLifeFrame(direct, input).signalOffsets).toEqual(result.signalOffsets);
  expect(deliver(api.frame(input)).signalOffsets).toEqual(result.signalOffsets);
  direct.clearTiles();
  api.clearTiles();
  expect(runLifeFrame(direct, input).signalOffsets).toBeUndefined();
  expect(deliver(api.frame(input)).signalOffsets).toBeUndefined();
});
it('adds independent cursor gusts to perched-bird flushing with cloned worker parity', () => {
  const direct = birdFixture(),
    remote = birdFixture();
  const api = createLifeWorkerApi(
    () => 0,
    () => remote.world,
  );
  api.init({ processions: [] });
  const at = birdLngLat(20, 0);
  const input: FrameInput = {
    gust: {
      camera: { lng: at[0], lat: at[1], zoom: 19 },
      size: { width: 400, height: 300 },
      cssCell: { w: 5, h: 9 },
      time: 0,
      wind: { dir: [1, 0], strength: 0 },
    },
    step: {
      dt: 0.1,
      zoom: 19,
      bounds: undefined,
      wind: undefined,
      weather: undefined,
      cellMeters: direct.cellMeters(19),
      gust: { lngLat: at, dir: [1, 0], radiusM: 8, strength: 0.3 },
    },
    visible: [19, 1, at],
  };
  for (const f of [direct.flock, remote.flock]) Object.assign(f, { perched: true, perch: 0 });
  runLifeFrame(direct.world, input);
  const weak = deliver(api.frame(structuredClone(input)));
  expect(remote.flock.perched).toBe(true);
  expect(weak.agents).toEqual(direct.world.visible(...input.visible));
  input.step.gust!.strength = 1;
  const strong = deliver(api.frame(structuredClone(input)));
  const expected = runLifeFrame(direct.world, input);
  expect(remote.flock.perched).toBe(false);
  expect(strong.agents).toEqual(expected.agents);
  expect(remote.flock).toEqual(direct.flock);
});

it('transports pointer rest, gust and tap activity independently without inventing absent inputs', () => {
  const world = new LifeWorld(),
    step = vi.spyOn(world, 'step');
  const input: FrameInput = {
    gust: {
      camera: { lng: 0, lat: 0, zoom: 18 },
      size: { width: 800, height: 600 },
      cssCell: { w: 5, h: 9 },
      time: 0,
      wind: { dir: [1, 0], strength: 0 },
    },
    step: {
      dt: 0.1,
      zoom: 18,
      bounds: undefined,
      wind: undefined,
      weather: undefined,
      cellMeters: 1,
    },
    visible: [18, 1, [0, 0]],
  };
  runLifeFrame(world, input);
  expect(step.mock.calls[0]!.slice(9)).toEqual([
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  ]);
  input.step.pointer = [0, 0];
  input.step.pointerRest = 2;
  input.step.gust = { lngLat: [0, 0], dir: [0, 1], strength: 0.8, radiusM: 8 };
  input.step.taps = [
    { id: 1, generation: 1, frame: 0, at: [0, 0], pointer: 'mouse', cellMeters: 1 },
  ];
  input.step.tapPointer = { revision: 2, left: true };
  runLifeFrame(world, structuredClone(input));
  expect(step.mock.calls[1]!.slice(9)).toEqual([
    input.step.pointer,
    2,
    input.step.gust,
    input.step.taps,
    input.step.tapPointer,
  ]);
});
it('transports independent active folklore identically without detaching observer storage', () => {
  const t = folkloreTile(),
    entry = { key: t.key, tile: t.tile, life: t.geo },
    direct = new LifeWorld(),
    api = createLifeWorkerApi(() => 0);
  direct.setFolklore(folkloreConfig);
  direct.sync([entry]);
  api.init({ processions: [], folklore: folkloreConfig });
  api.sync([structuredClone(entry)]);
  const input: FrameInput = {
    gust: {
      camera: { lng: folkloreCenter[0], lat: folkloreCenter[1], zoom: 18 },
      size: { width: 800, height: 600 },
      cssCell: { w: 5, h: 9 },
      time: 0,
      wind: { dir: [1, 0], strength: 0 },
    },
    step: {
      dt: 6,
      zoom: 18,
      bounds: undefined,
      wind: undefined,
      weather: { rain: 0, minutes: 1320, folkloreDate: calendar() },
      cellMeters: 0.9,
    },
    visible: [18, 1, folkloreCenter],
  };
  for (let i = 0; i < 3; i++) {
    const a = runLifeFrame(direct, input),
      b = deliver(api.frame(input));
    expect(structuredClone(b.folklore)).toEqual(a.folklore);
    if (i > 0) expect(b.folklore.sprites.length).toBeGreaterThan(0);
  }
  api.clearTiles();
  expect(deliver(api.frame(input)).folklore.sprites).toEqual([]);
});

/** The transfer list of the latest reply, recorded on the way through Comlink. */
const transfers = vi.hoisted(() => ({ last: undefined as readonly unknown[] | undefined }));
vi.mock('comlink', async (load) => {
  const actual = await load<typeof ComlinkModule>();
  return {
    ...actual,
    transfer: <T>(value: T, list: Transferable[]) => {
      transfers.last = list;
      return actual.transfer(value, list);
    },
  };
});
vi.mock('./moments', async (load) => {
  const actual = await load<typeof MomentsModule>();
  return {
    ...actual,
    Moments: class extends actual.Moments {
      constructor(...args: ConstructorParameters<typeof actual.Moments>) {
        args[2] = () => 0;
        super(...args);
      }
    },
  };
});

describe('life worker protocol', () => {
  it.each(['lane', 'filter'] as const)(
    'matches complete accepted %s state and indicators through worker frames',
    (kind) => {
      const entry = continuityTile(left, undefined, 77, 0, 1);
      entry.life.widths[0] = 9.6;
      const direct = new LifeWorld();
      direct.sync([entry]);
      const worlds: LifeWorld[] = [];
      const api = createLifeWorkerApi(undefined, () => {
        const world = new LifeWorld();
        worlds.push(world);
        return world;
      });
      api.init({ processions: [] });
      api.sync([structuredClone(entry)]);
      for (const world of [direct, worlds[0]!]) {
        const life = worldTiles(world).get(entry.key)!;
        life.movers.length = life.parked.length = life.gatherers.length = life.stalls.length = 0;
        life.scenes.sites.length = 0;
        const m = continuityMover(life, 2000);
        Object.assign(m, {
          lane: 0.9,
          lat: -0.1,
          vehicle: kind === 'filter' ? 'motorcycle' : 'car',
          maneuver:
            kind === 'filter'
              ? { kind, target: 0.9, corridor: 1 / 3, queueSpeed: 0 }
              : { kind, target: 0.5 },
          laneSignal: 'left',
        });
        life.movers.push(m);
      }
      const center = tileToLngLat(left, { x: 2000, y: 2000 });
      let indicating = false;
      for (let frame = 0; frame < 40; frame++) {
        const input: FrameInput = {
          gust: {
            camera: { lng: center[0], lat: center[1], zoom: 21 },
            size: { width: 800, height: 600 },
            cssCell: { w: 5, h: 7.5 },
            time: frame / 10,
            wind: { dir: [1, 0], strength: 0 },
          },
          step: {
            dt: 0.1,
            zoom: 21,
            bounds: undefined,
            wind: undefined,
            weather: { rain: 0, minutes: 720 },
            cellMeters: 0.2,
          },
          visible: [21, activityLevels(1), center],
        };
        const inline = runLifeFrame(direct, input),
          remote = deliver(api.frame(input));
        expect(remote.agents).toEqual(inline.agents);
        expect(completeScenarioState(worlds[0]!)).toEqual(completeScenarioState(direct));
        indicating ||= remote.agents.some((agent) => agent.turnSignal?.side === 'left');
      }
      expect(indicating).toBe(true);
    },
  );

  it('installs initial and late emergency geography without replacing ordinary owners', () => {
    const world = new LifeWorld(),
      api = createLifeWorkerApi(undefined, () => world),
      { data } = emergencyFixture();
    api.init({ processions: [], emergencyConfig });
    expect(world.emergencyRouter).toBeUndefined();
    world.sync(makeScenario('sparse', 1).tiles);
    const life = [...worldTiles(world).values()][0]!,
      movers = life.movers.slice(),
      terrain = world.cellTerrain();
    api.setEmergency(data);
    expect(world.emergencyRouter?.targets.has('fire')).toBe(true);
    expect(life.emergencyRouter).toBe(world.emergencyRouter);
    api.setEmergency(undefined);
    expect(world.emergencyRouter).toBeUndefined();
    expect(life.movers).toEqual(movers);
    expect(world.cellTerrain()?.version).toBe(terrain?.version);
    api.init({ processions: [], emergencyConfig, emergency: data });
    expect(world.emergencyRouter).toBeDefined();
    api.init({ processions: [], emergency: data });
    expect(world.emergencyRouter).toBeUndefined();
    api.init({
      processions: [],
      emergencyConfig: { ambulance: { ...emergencyConfig.ambulance!, max: 0 }, source: 'zero' },
      emergency: data,
    });
    expect(world.emergencyRouter).toBeUndefined();
  });
  it.each([0.1, 1])(
    'emits natural emoji equally through worker and inline %s-second frames',
    (dt) => {
      const direct = new LifeWorld(),
        entry = pedestrianEntry();
      direct.sync([entry]);
      const seeded = seedPedestrians(direct);
      for (let i = 1; i < 20; i++)
        seeded.life.movers.push({
          ...structuredClone(seeded.human),
          x: seeded.human.x + i * seeded.life.perMeter,
          rank: i / 40,
        });
      const worlds: LifeWorld[] = [];
      const api = createLifeWorkerApi(undefined, () => {
        const world = new LifeWorld();
        worlds.push(world);
        return world;
      });
      api.init({ processions: [] });
      api.sync([structuredClone(entry)]);
      const remote = seedPedestrians(worlds[0]!);
      for (let i = 1; i < 20; i++)
        remote.life.movers.push({
          ...structuredClone(remote.human),
          x: remote.human.x + i * remote.life.perMeter,
          rank: i / 40,
        });
      const center = tileToLngLat(entry.tile, { x: 2000, y: 2000 });
      const input: FrameInput = {
        gust: {
          camera: { lng: center[0], lat: center[1], zoom: 19 },
          size: { width: 800, height: 600 },
          cssCell: { w: 5, h: 7.5 },
          time: 0,
          wind: { dir: [1, 0], strength: 0 },
        },
        step: {
          dt,
          zoom: 19,
          bounds: undefined,
          wind: undefined,
          weather: { rain: 0, minutes: 720, sunAltitude: 70 },
          cellMeters: 0.9,
        },
        visible: [19, 1, center],
      };
      let seen = false;
      for (let i = 0; i < Math.ceil(15 / dt); i++) {
        const a = runLifeFrame(direct, input),
          b = deliver(api.frame(input));
        expect(b.agents).toEqual(a.agents);
        seen ||= a.agents.some((agent) => !!agent.emoji);
      }
      expect(seen).toBe(true);
    },
  );
  it('delivers composed emoji-only seasons equally to worker and inline step environments', () => {
    const seasons: SimulationSeason[] = [
      { id: 'moods', emoji: [{ mood: 'gift', subjects: ['person'], weight: 2 }] },
    ];
    const direct = new LifeWorld();
    direct.setSeasons(seasons);
    const entry = continuityTile(left);
    direct.sync([entry]);
    const api = createLifeWorkerApi();
    api.init({ processions: [], seasons });
    api.sync([structuredClone(entry)]);
    const delivered: (readonly SimulationSeason[] | undefined)[] = [];
    // eslint-disable-next-line @typescript-eslint/unbound-method -- apply supplies each tile.
    const step = TileLife.prototype.step;
    const spy = vi.spyOn(TileLife.prototype, 'step').mockImplementation(function (
      this: TileLife,
      ...args
    ) {
      delivered.push(args[4]?.emojiSeasons);
      step.apply(this, args);
    });
    const center = tileToLngLat(left, { x: 2000, y: 2000 });
    const input: FrameInput = {
      gust: {
        camera: { lng: center[0], lat: center[1], zoom: 18 },
        size: { width: 800, height: 600 },
        cssCell: { w: 5, h: 7.5 },
        time: 0,
        wind: { dir: [1, 0], strength: 0 },
      },
      step: {
        dt: 0.1,
        zoom: 18,
        bounds: undefined,
        wind: undefined,
        weather: {
          rain: 0,
          season: 'moods',
          minutes: 720,
          date: { epochDay: 20731, weekday: 1, preview: true },
          sunAltitude: 70,
          windPreset: 'gusty',
        },
        cellMeters: 0.9,
      },
      visible: [18, activityLevels(1), center],
    };
    try {
      expect(deliver(api.frame(input)).agents).toEqual(runLifeFrame(direct, input).agents);
      expect(delivered).toEqual([seasons, seasons]);
      expect(worldTiles(direct).get(entry.key)!.seasonalStalls).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
  it('matches braking, crossing expiry and release in worker and inline complete state', () => {
    const entry = pedestrianEntry(),
      worlds: LifeWorld[] = [];
    // eslint-disable-next-line @typescript-eslint/unbound-method -- apply below supplies the intercepted world.
    const sync = LifeWorld.prototype.sync;
    const intercept = vi.spyOn(LifeWorld.prototype, 'sync').mockImplementation(function (
      this: LifeWorld,
      ...args
    ) {
      sync.apply(this, args);
      if (!worlds.includes(this) && args[0].some((entry) => entry.key === 'pedestrian-crossing')) {
        worlds.push(this);
        seedPedestrians(this, 1.75);
      }
    });
    try {
      const direct = new LifeWorld();
      direct.sync([entry]);
      const api = createLifeWorkerApi();
      api.init({ processions: [] });
      api.sync([structuredClone(entry)]);
      expect(worlds).toHaveLength(2);
      const fixtures = worlds.map((world) => {
        const life = worldTiles(world).get(entry.key)!;
        return { car: life.movers[0]!, human: life.movers[1]! };
      });
      const center = tileToLngLat(entry.tile, { x: 2000, y: 2000 });
      let braked = false,
        held = false,
        expired = false,
        released = false;
      for (let frame = 0; frame < 300; frame++) {
        const input: FrameInput = {
          gust: {
            camera: { lng: center[0], lat: center[1], zoom: 18 },
            size: { width: 800, height: 600 },
            cssCell: { w: 5, h: 7.5 },
            time: frame / 10,
            wind: { dir: [1, 0], strength: 0 },
          },
          step: {
            dt: 0.1,
            zoom: 18,
            bounds: undefined,
            wind: undefined,
            weather: { rain: 0 },
            cellMeters: 0.9,
          },
          visible: [18, activityLevels(1), center],
        };
        expect(deliver(api.frame(input)).agents).toEqual(runLifeFrame(direct, input).agents);
        const car = fixtures[0]!.car;
        braked ||= car.v! < car.speed;
        held ||= !!car.pedestrianHolds?.length;
        expired ||= !!car.pedestrianHolds?.[0]?.expired;
        released ||= expired && fixtures.every(({ car }) => car.pedestrianHolds === undefined);
        if (frame === 220)
          for (const world of worlds) {
            const life = worldTiles(world).get(entry.key)!;
            life.movers.splice(1, 1);
          }
      }
      expect({ braked, held, expired, released }).toEqual({
        braked: true,
        held: true,
        expired: true,
        released: true,
      });
      for (const { car } of fixtures) expect(car.pedestrianHolds).toBeUndefined();
      expect(completeScenarioState(worlds[1]!)).toEqual(completeScenarioState(direct));
    } finally {
      intercept.mockRestore();
    }
  });
  it.each([false, true])(
    'transfers speech, poses and balls with inline parity (profiles=%s)',
    (profiles) => {
      const tile = { z: 16, x: 55192, y: 30266 };
      const geometry = new LifeBuilder();
      geometry.place({ x: 2000, y: 2000 }, 'monument', 2 / metersPerUnit(tile));
      geometry.place({ x: 2500, y: 2000 }, 'school', 8 / metersPerUnit(tile));
      geometry.place({ x: 2000, y: 2500 }, 'pitch', 14 / metersPerUnit(tile));
      const tiles = [{ key: 'speech-fixture', tile, life: geometry.finish() }];
      const center = tileToLngLat(tile, { x: 2000, y: 2000 });
      const dialogue: DialogueChoice[] = [
        { id: 'hello', kind: 'greet', period: 'afternoon', turns: 2 },
        { id: 'chat', kind: 'talk', turns: 3 },
        { id: 'play', kind: 'ball', turns: 2 },
        { id: 'look', kind: 'look', turns: 1 },
      ];
      if (profiles)
        for (const entry of dialogue) {
          entry.profile =
            entry.kind === 'greet'
              ? 'greeting'
              : entry.kind === 'talk'
                ? 'reunion'
                : entry.kind === 'ball'
                  ? 'play'
                  : 'place-reaction';
          entry.speakers = entry.turns === 1 ? [0] : entry.turns === 2 ? [0, 1] : [0, 1, 0];
        }
      const direct = new LifeWorld(undefined, undefined, { dialogue });
      direct.sync(tiles);
      const api = createLifeWorkerApi();
      api.init({ processions: [], dialogue });
      api.sync(structuredClone(tiles));
      let spoken = 0,
        posed = false,
        ball = false;
      for (let frame = 0; frame < 120; frame++) {
        if (frame === 80) {
          direct.sync([]);
          api.sync([]);
        }
        if (frame === 81) {
          direct.sync(tiles);
          api.sync(structuredClone(tiles));
        }
        const input: FrameInput = {
          gust: {
            camera: { lng: center[0], lat: center[1], zoom: 21 },
            size: { width: 800, height: 600 },
            cssCell: { w: 5, h: 7.5 },
            time: frame / 10,
            wind: { dir: [1, 0], strength: 0 },
          },
          step: {
            dt: 0.1,
            zoom: 21,
            bounds: undefined,
            wind: undefined,
            weather: { rain: frame >= 40 && frame < 50 ? 1 : 0, minutes: 720 },
            cellMeters: 0.2,
          },
          visible: [21, activityLevels(1), center],
        };
        const inline = runLifeFrame(direct, input),
          remote = deliver(api.frame(input));
        expect(remote.agents).toEqual(inline.agents);
        spoken += remote.agents.filter((agent) => agent.speech).length;
        posed ||= remote.agents.some((agent) => agent.people?.some((person) => person.pose));
        ball ||= remote.agents.some((agent) => agent.prop === 'ball');
        if (frame === 40 || frame === 80)
          expect(remote.agents.some((agent) => agent.speech || agent.prop)).toBe(false);
        expect(structuredClone(remote.agents)).toEqual(remote.agents);
      }
      expect(spoken).toBeGreaterThan(0);
      expect(posed).toBe(true);
      expect(ball).toBe(true);
    },
  );
  afterEach(() => vi.useRealTimers());
  it('transports the mouse equally to worker and inline worlds containing birds', async () => {
    vi.useFakeTimers();
    const builder = new LifeBuilder();
    builder.roost({ x: 2048, y: 2048 });
    builder.perch({ x: 2048, y: 2048 });
    const entry = { key: `${left.z}/${left.x}/${left.y}`, tile: left, life: builder.finish() };
    const center = tileToLngLat(left, { x: 2048, y: 2048 });
    const remote = new LifeWorld();
    const local = new LifeWorld();
    const api = createLifeWorkerApi(
      () => 0,
      () => remote,
    );
    api.init({ processions: [] });
    const inline = createInlineHost(local, undefined, () => 0);
    api.sync([structuredClone(entry)]);
    inline.sync([entry]);
    const input: FrameInput = {
      gust: {
        camera: { lng: center[0], lat: center[1], zoom: 19 },
        size: { width: 400, height: 300 },
        cssCell: { w: 5, h: 9 },
        time: 0,
        wind: { dir: [1, 0], strength: 0 },
      },
      step: {
        dt: 0.1,
        zoom: 19,
        bounds: undefined,
        wind: undefined,
        weather: undefined,
        cellMeters: 0.9,
      },
      visible: [19, 1, center],
    };
    deliver(api.frame(input));
    inline.request(input);
    await vi.runAllTimersAsync();
    deliver(api.frame(input));
    inline.request(input);
    expect(remote.resident(entry.key)!.flocks.length).toBeGreaterThan(0);
    expect(local.resident(entry.key)!.flocks.length).toBeGreaterThan(0);
    for (const world of [remote, local]) {
      const life = world.resident(entry.key)!;
      life.flocks.splice(1);
      Object.assign(life.flocks[0]!, {
        species: 'pigeon',
        x: 2048,
        y: 2048,
        rank: 0,
        perch: 0,
        perched: true,
        stay: 1000,
      });
    }
    const a = vi.spyOn(remote, 'step');
    const b = vi.spyOn(local, 'step');
    for (const pointer of [center, center, undefined]) {
      input.step.pointer = pointer;
      const actual = deliver(api.frame(structuredClone(input)));
      inline.request(input);
      expect(a.mock.calls.at(-1)![9]).toEqual(pointer);
      expect(b.mock.calls.at(-1)![9]).toEqual(pointer);
      expect(actual.agents).toEqual(inline.latest()!.agents);
      expect(remote.resident(entry.key)!.flocks[0]!.perched).toBe(false);
      expect(remote.resident(entry.key)!.flocks).toEqual(local.resident(entry.key)!.flocks);
    }
    inline.dispose();
  });
  it('publishes identical complete staged worker and inline frames through camera changes and cancellation', async () => {
    vi.useFakeTimers();
    const s = makeScenario('sparse', 1, false);
    const api = createLifeWorkerApi(() => 0);
    api.init({ processions: [], profiling: true });
    const inline = createInlineHost(new LifeWorld(), undefined, () => 0);
    const input: FrameInput = {
      gust: {
        camera: { lng: s.center[0], lat: s.center[1], zoom: 18 },
        size: { width: 390, height: 844 },
        cssCell: { w: 10, h: 18 },
        time: 0,
        wind: { dir: [1, 0], strength: 0 },
      },
      step: {
        dt: 0.1,
        zoom: 18,
        bounds: s.bounds,
        wind: undefined,
        weather: undefined,
        cellMeters: 0.9,
      },
      visible: [18, s.levels, s.center],
    };
    const view = { bounds: s.bounds, spawnMarginM: 12 };
    const a = continuityTile(parent),
      b = continuityTile(left),
      c = continuityTile(right);
    for (const entries of [[a], [a, b], [b, c], [a], [], [a]]) {
      api.sync(structuredClone(entries), s.center, view);
      inline.sync(entries, s.center, view);
      for (let frame = 0; frame < 6; frame++) {
        api.sync(
          entries.map(({ key, tile }) => ({ key, tile })),
          s.center,
          view,
        );
        inline.sync(entries, s.center, view);
        const actual = deliver(api.frame(input));
        inline.request(input);
        const expected = inline.latest()!;
        expect(actual.agents).toEqual(
          expected.agents.map(({ consist: _consist, ...agent }) => agent),
        );
        expect(actual.signalClock).toBe(expected.signalClock);
        await vi.runAllTimersAsync();
      }
    }
    api.clearTiles();
    inline.clearTiles();
    expect(deliver(api.frame(input)).agents).toEqual([]);
    inline.request(input);
    expect(inline.latest()!.agents).toEqual([]);
    inline.dispose();
  });
  // eslint-disable-next-line no-restricted-syntax -- slow before the time-limit ban; tracked by the CI file budget
  it('matches a direct world over 120 frames, weather changes, eviction and reload', () => {
    const scenario = makeScenario('rain', 2, false);
    // Buffered commerce must survive cloning, repeated sync and eviction on both paths.
    for (const tile of scenario.tiles)
      tile.life.commerce = new Float32Array([1000, 2100, 2000, 2100, 3000, 2100]);
    const traffic = { road_major: { jeepney: 1 } };
    const direct = new LifeWorld(traffic);
    const route: ProcessionRoute = {
      id: 'test',
      title: { en: 'Test' },
      status: 'draft',
      kind: 'fluvial',
      route: [
        [0, 0],
        [0.001, 0],
      ],
      length_m: 111,
      schedule: {
        month: 9,
        weekday: 0,
        nth: 3,
        offset_days: 0,
        start: '15:00',
        duration_min: 60,
        timezone: 'UTC',
      },
    };
    direct.setProcessions([route]);
    direct.sync(scenario.tiles);
    const api = createLifeWorkerApi();
    api.init({ traffic, processions: [], profiling: true });
    api.setProcessions([route]);
    api.sync(structuredClone(scenario.tiles));
    for (let frame = 0; frame < 120; frame++) {
      if (frame === 20) expect(api.play('test')).toBe(direct.play('test'));
      if (frame === 60) {
        api.setLive('test', 0.5);
        direct.setLive('test', 0.5);
      }
      if (frame === 70) {
        api.stop();
        direct.stop();
      }
      if (frame === 90) {
        api.setLive(undefined);
        direct.setLive(undefined);
      }
      if (frame === 40) {
        direct.sync(scenario.tiles.slice(1));
        api.sync(scenario.tiles.slice(1).map(({ key, tile }) => ({ key, tile })));
      }
      if (frame === 80) {
        direct.sync([]);
        api.sync([]);
      }
      if (frame === 81) {
        direct.sync(scenario.tiles);
        api.sync(structuredClone(scenario.tiles));
      }
      const input: FrameInput = {
        gust: {
          camera: { lng: scenario.center[0], lat: scenario.center[1], zoom: 18 },
          size: { width: 1920, height: 1080 },
          cssCell: { w: 10, h: 18 },
          time: frame / 30,
          wind: { dir: [1, 0], strength: 0.8 },
        },
        step: {
          dt: 1 / 30,
          zoom: 18,
          bounds: scenario.bounds,
          wind: { dir: [1, 0], strength: 0.2 },
          weather: scenario.environment(frame),
          cellMeters: 0.9,
        },
        visible: [
          18,
          scenario.levels,
          scenario.center,
          { rain: scenario.environment(frame).rain, sunAltitude: 40 },
          scenario.bounds,
        ],
      };
      const { gust, step } = input;
      direct.setEmojiView(input.visible);
      const { grid, toCell } = placeGrid(
        { camera: gust.camera, dpr: 1, ...gust.size },
        gust.cssCell,
        1,
        1,
      );
      direct.step(
        step.dt,
        (lng, lat) => {
          const [col, row] = toCell(lng, lat);
          return (
            gust.wind.strength *
            treeGust(
              grid.originCol + Math.floor(col),
              grid.originRow + Math.floor(row),
              gust.time,
              gust.wind.dir,
            )
          );
        },
        step.zoom,
        step.bounds,
        step.wind,
        step.weather,
        step.cellMeters,
      );
      const agents = direct.visible(...input.visible).map((agent) => {
        const plain = { ...agent };
        delete plain.consist;
        return plain;
      });
      const result = deliver(api.frame(input));
      expect(result.agents).toEqual(agents);
      expect(result.procession).toEqual(direct.procession());
      expect(result.signalClock).toBe(direct.signalClock);
      expect(result.profile?.ms.step).toBeGreaterThanOrEqual(0);
      expect(result.profile?.ms.replyClone).toBeGreaterThanOrEqual(0);
      if (frame === 0 || frame === 40 || frame === 81) expect(result.terrain).toBeTruthy();
      else if (frame === 80) expect(result.terrain).toBeNull();
      else expect(result).not.toHaveProperty('terrain');
      if (frame === 0) expect(result.profile?.ms.sync).toBeGreaterThanOrEqual(0);
    }
  }, 10000);

  it('rejects missing geometry instead of silently losing a tile', () => {
    const api = createLifeWorkerApi();
    api.init({ processions: [], profiling: false });
    expect(() => api.sync([{ key: 'missing', tile: { x: 0, y: 0, z: 16 } }])).toThrow('geometry');
  });

  it('clones identical brake, hazard and exhaust frames through the worker protocol', () => {
    const tile = continuityTile(left);
    const center = tileToLngLat(left, { x: 1200, y: 2000 });
    const build = () => {
      const world = new LifeWorld();
      world.sync([tile]);
      const life = [...worldTiles(world).values()][0]!;
      life.movers.length = life.parked.length = life.flocks.length = life.stalls.length = 0;
      const bus = continuityMover(life, 1000),
        car = continuityMover(life, 1500);
      bus.vehicle = 'bus';
      bus.v = car.v = 0;
      car.pause = 10;
      life.movers.push(bus, car);
      life.scenes.services.set(bus, {
        time: 20,
        boarded: 0,
        arriving: false,
        site: {
          x: bus.x,
          y: bus.y,
          kind: 'terminal',
          modes: 3,
          covered: false,
          queue: [],
          capacity: 3,
          hx: 1,
          hy: 0,
          road: 0,
          roadWidth: 12,
          direction: 1,
        },
      });
      const state = ensureVehicleEffects(bus);
      state.exhaust = emitter(42, 0);
      state.exhaust.stoppedSince = 0;
      state.exhaust.nextIdle = 0.2;
      ensureVehicleEffects(car).brake = BRAKE.hold;
      return world;
    };
    const direct = build(),
      api = createLifeWorkerApi(undefined, build);
    api.init({ processions: [] });
    api.sync([structuredClone(tile)]);
    const input: FrameInput = {
      gust: {
        camera: { lng: center[0], lat: center[1], zoom: 20 },
        size: { width: 640, height: 480 },
        cssCell: { w: 6, h: 11 },
        time: 0,
        wind: { dir: [1, 0], strength: 0.2 },
      },
      step: {
        dt: 0.1,
        zoom: 20,
        bounds: undefined,
        wind: { dir: [1, 0], strength: 0.2 },
        weather: { minutes: 720, rain: 0 },
        cellMeters: 0,
      },
      visible: [20, 1, center],
    };
    const seen = { brake: false, hazard: false, puff: false };
    for (let frame = 0; frame < 20; frame++) {
      input.gust.time = frame / 10;
      const expected = runLifeFrame(direct, input);
      for (const agent of expected.agents) delete agent.consist;
      const actual = deliver(api.frame(input));
      expect(actual.agents).toEqual(expected.agents);
      expect(Buffer.from(actual.puffs.buffer).equals(Buffer.from(expected.puffs.buffer))).toBe(
        true,
      );
      if (actual.puffs.length) {
        const delivered = structuredClone(actual, {
          transfer: [actual.puffs.buffer as ArrayBuffer],
        });
        expect(actual.puffs.byteLength).toBe(0);
        expect(delivered.puffs.length).toBe(expected.puffs.length);
        seen.puff = true;
      }
      expect(actual.signalClock).toBe(expected.signalClock);
      for (const agent of actual.agents) {
        seen.brake ||= agent.lamps?.kind === 'brake';
        seen.hazard ||= agent.lamps?.kind === 'hazard';
      }
      if (seen.brake && seen.hazard && seen.puff) break;
    }
    expect(seen).toEqual({ brake: true, hazard: true, puff: true });
    const nextExpected = runLifeFrame(direct, input),
      nextActual = deliver(api.frame(input));
    expect(nextActual.agents).toEqual(nextExpected.agents);
    expect(
      Buffer.from(nextActual.puffs.buffer).equals(Buffer.from(nextExpected.puffs.buffer)),
    ).toBe(true);
  });

  it('matches inline zoom ownership, cloned revival and hard clearing', () => {
    const scenario = makeScenario('sparse', 1, false);
    const input: FrameInput = {
      gust: {
        camera: { lng: scenario.center[0], lat: scenario.center[1], zoom: 18 },
        size: { width: 1920, height: 1080 },
        cssCell: { w: 10, h: 18 },
        time: 0,
        wind: { dir: [1, 0], strength: 0 },
      },
      step: {
        dt: 0.1,
        zoom: 18,
        bounds: undefined,
        wind: undefined,
        weather: undefined,
        cellMeters: 0,
      },
      visible: [18, scenario.levels, scenario.center],
    };
    const direct = new LifeWorld(),
      api = createLifeWorkerApi();
    api.init({ processions: [], profiling: false });
    const coarse = continuityTile(parent),
      a = continuityTile(left),
      b = continuityTile(right);
    for (const tiles of [[coarse], [coarse, a], [a], [a, b], [coarse, a], [coarse], [], [coarse]]) {
      direct.sync(tiles, scenario.center);
      api.sync(structuredClone(tiles), scenario.center);
      for (let frame = 0; frame < 4; frame++) {
        const expected = runLifeFrame(direct, input);
        for (const agent of expected.agents) delete agent.consist;
        const actual = deliver(api.frame(input));
        expect(actual.agents).toEqual(expected.agents);
        expect(Buffer.from(actual.puffs.buffer).equals(Buffer.from(expected.puffs.buffer))).toBe(
          true,
        );
        expect(actual.signalClock).toBe(expected.signalClock);
      }
    }
    direct.clearTiles();
    api.clearTiles();
    expect(() => api.sync([{ key: coarse.key, tile: coarse.tile }])).toThrow('geometry');
    direct.sync([coarse]);
    api.sync([structuredClone(coarse)]);
    const expected = runLifeFrame(direct, input);
    for (const agent of expected.agents) delete agent.consist;
    expect(deliver(api.frame(input)).agents).toEqual(expected.agents);
  });
});

it('returns worker and inline frames before running private preparation', async () => {
  vi.useFakeTimers();
  const scenario = makeScenario('sparse', 1, false);
  const api = createLifeWorkerApi(() => 0);
  api.init({ processions: [] });
  const inline = createInlineHost(new LifeWorld(), undefined, () => 0);
  const input: FrameInput = {
    gust: {
      camera: { lng: scenario.center[0], lat: scenario.center[1], zoom: 18 },
      size: { width: 640, height: 480 },
      cssCell: { w: 10, h: 18 },
      time: 0,
      wind: { dir: [1, 0], strength: 0 },
    },
    step: {
      dt: 0.1,
      zoom: 18,
      bounds: scenario.bounds,
      wind: undefined,
      weather: undefined,
      cellMeters: 0.9,
    },
    visible: [18, scenario.levels, scenario.center],
  };
  const view = { bounds: scenario.bounds, spawnMarginM: 12 };
  const slice = vi.spyOn(LifePreparation.prototype, 'slice');
  try {
    api.sync(scenario.tiles, scenario.center, view);
    inline.sync(scenario.tiles, scenario.center, view);
    expect(deliver(api.frame(input)).agents).toEqual([]);
    inline.request(input);
    expect(slice).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(slice).toHaveBeenCalled();
    // Background turns prepare privately, without changing the last published frame.
    expect(inline.latest()!.agents).toEqual([]);
    deliver(api.frame(input));
    inline.request(input);
    expect(inline.latest()!.agents.length).toBeGreaterThan(0);
  } finally {
    api.clearTiles();
    inline.dispose();
    slice.mockRestore();
    vi.useRealTimers();
  }
});

describe('packed Life frames', () => {
  const heading = (lng: number, lat: number): [number, number] => [lng + 1e-9 / 3, lat - 1e-12];
  const agents = (): VisibleAgent[] => [
    {
      kind: 'vehicle',
      lng: 123.18512345678901,
      lat: 13.624012345678912,
      ahead: heading(123.18512345678901, 13.624012345678912),
      side: [123.185123, 13.6240123],
      vehicle: 'car',
      paint: 3,
      parked: false,
      flap: 0,
      lamps: { kind: 'hazard', on: true },
      turnSignal: { side: 'left', on: false },
      beacon: { half: 1, colors: [0, 2] },
    },
    {
      kind: 'person',
      lng: -0,
      lat: Number.MIN_VALUE,
      flap: 1,
      candle: true,
      effectClock: -2.5,
      candleSeed: 31,
      inspectionId: 7,
      people: [{ figure: 'adult', paint: 2, lateral: 0.5, back: -0.25, flap: 1 }],
      speech: { id: 's', exchangeId: 'e', line: 2, member: 0 },
      emoji: { id: 'x', subject: 'person', mood: 'wave' },
      event: true,
      eventGround: 'plaza',
      eventRole: 'seated',
      eventFootprint: { length: 1, width: 0.5 },
      mappedPersonMover: true,
      covered: false,
      glyph: '',
    },
    { kind: 'bird', lng: 1, lat: 2, flap: 0, bird: { species: 'egret', pose: 1 } },
    {
      kind: 'boat',
      lng: 3,
      lat: 4,
      flap: 0,
      aboard: true,
      stroke: 1,
      line: { points: [[3, 4]], paints: [1], tip: { glyph: '*', paint: 0 } },
      prop: 'event',
      eventScenery: true,
    },
    // A present-but-undefined optional field stays present, and absent ones stay absent.
    { kind: 'dog', lng: 5, lat: 6, flap: 0, speech: undefined },
  ];

  it('round-trips every field exactly, through a transfer', () => {
    const original = agents();
    const packed = packAgents(original);
    const delivered = structuredClone(packed, { transfer: packedTransferables(packed) });
    expect(packed.numbers.byteLength).toBe(0);
    const decoded = unpackAgents(delivered);
    expect(decoded).toStrictEqual(original);
    expect(Object.is(decoded[1]!.lng, -0)).toBe(true);
    expect(decoded[0]!.ahead![0]).toBe(original[0]!.ahead![0]);
    expect('speech' in decoded[4]!).toBe(true);
    expect('candle' in decoded[0]!).toBe(false);
    // Fresh objects each decode: an accepted frame is never shared with the next.
    expect(unpackAgents(packAgents(original))[0]).not.toBe(decoded[0]);
  });

  it('transfers the packed columns and decodes to the inline frame', () => {
    const tile = continuityTile(left);
    const center = tileToLngLat(left, { x: 1200, y: 2000 });
    const direct = new LifeWorld();
    direct.sync([tile]);
    const api = createLifeWorkerApi();
    api.init({ processions: [] });
    api.sync([structuredClone(tile)]);
    const input: FrameInput = {
      gust: {
        camera: { lng: center[0], lat: center[1], zoom: 19 },
        size: { width: 640, height: 480 },
        cssCell: { w: 6, h: 11 },
        time: 0,
        wind: { dir: [1, 0], strength: 0 },
      },
      step: {
        dt: 0.1,
        zoom: 19,
        bounds: undefined,
        wind: undefined,
        weather: { minutes: 720, rain: 0 },
        cellMeters: 0,
      },
      visible: [19, activityLevels(1), center],
    };
    for (let frame = 0; frame < 5; frame++) {
      input.gust.time = frame / 10;
      const expected = runLifeFrame(direct, input);
      for (const agent of expected.agents) delete agent.consist;
      const reply = api.frame(input);
      for (const buffer of packedTransferables(reply.packed))
        expect(transfers.last).toContain(buffer);
      expect(deliver(reply).agents).toEqual(expected.agents);
    }
    expect(runLifeFrame(direct, input).agents.length).toBeGreaterThan(0);
  });
});

describe('retained worker geometry', () => {
  it('resolves returning tiles by key exactly while the host still holds them', () => {
    const base = continuityTile(left);
    const api = createLifeWorkerApi();
    api.init({ processions: [] });
    const host = new RecentKeys();
    const tile = (i: number) => ({ key: `k${i}`, tile: base.tile, life: base.life });
    // What the host sends: geometry only for a key the worker doesn't hold.
    const send = (tiles: ReturnType<typeof tile>[]) => {
      const payload = tiles.map((t) => (host.has(t.key) ? { key: t.key, tile: t.tile } : t));
      host.touch(tiles.map((t) => t.key));
      api.sync(payload);
      return payload;
    };
    send([tile(0)]);
    send([tile(1)]);
    const back = send([tile(0)]);
    expect(back[0]).not.toHaveProperty('life');
    for (let i = 2; i < 2 + RETAINED_LIFE_TILES + 2; i++) send([tile(i)]);
    expect(host.has('k0')).toBe(false);
    expect(host.has(`k${RETAINED_LIFE_TILES}`)).toBe(true);
    // The worker dropped what the host dropped, and kept what it kept.
    expect(() => api.sync([{ key: 'k0', tile: base.tile }])).toThrow('Missing Life geometry');
    expect(() => api.sync([{ key: `k${RETAINED_LIFE_TILES}`, tile: base.tile }])).not.toThrow();
  });
});
