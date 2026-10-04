import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as MomentsModule from './moments';
import { continuityTile, left, parent, right } from './testing/continuity';
import { createInlineHost } from './host';
import { LifePreparation } from './preparation';
import { LifeWorld } from './simulate';
import { completeScenarioState, makeScenario, worldTiles } from './testing/scenarios';
import { pedestrianEntry, seedPedestrians } from './testing/pedestrians';
import { createLifeWorkerApi, runLifeFrame, type FrameInput } from './worker-api';
import { placeGrid } from '../grid';
import { treeGust } from '../glyphs/select';
import type { DialogueChoice, ProcessionRoute } from '@atlas/shared';
import { LifeBuilder } from './geometry';
import { activityLevels } from './config';
import { metersPerUnit, tileToLngLat } from '../raster/geometry';

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
        expired = false;
      for (let frame = 0; frame < 240; frame++) {
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
        expect(api.frame(input).agents).toEqual(runLifeFrame(direct, input).agents);
        const car = fixtures[0]!.car;
        braked ||= car.v! < car.speed;
        held ||= !!car.pedestrianHolds?.length;
        expired ||= !!car.pedestrianHolds?.[0]?.expired;
        if (frame === 220)
          for (const world of worlds) {
            const life = worldTiles(world).get(entry.key)!;
            life.movers.splice(1, 1);
          }
      }
      expect({ braked, held, expired }).toEqual({ braked: true, held: true, expired: true });
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
          remote = api.frame(input);
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
        const actual = api.frame(input);
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
    expect(api.frame(input).agents).toEqual([]);
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
    api.init({ traffic, processions: [route], profiling: true });
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
      const result = api.frame(input);
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
        const actual = api.frame(input);
        expect(actual.agents).toEqual(expected.agents);
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
    expect(api.frame(input).agents).toEqual(expected.agents);
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
    expect(api.frame(input).agents).toEqual([]);
    inline.request(input);
    expect(slice).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(slice).toHaveBeenCalled();
    // Background turns prepare privately, without changing the last published frame.
    expect(inline.latest()!.agents).toEqual([]);
    api.frame(input);
    inline.request(input);
    expect(inline.latest()!.agents.length).toBeGreaterThan(0);
  } finally {
    api.clearTiles();
    inline.dispose();
    slice.mockRestore();
    vi.useRealTimers();
  }
});
