import { afterEach, describe, expect, it, vi } from 'vitest';
import { LifeWorld } from './simulate';
import { makeScenario } from './testing/scenarios';
import { createLifeWorkerApi, runLifeFrame, type FrameInput } from './worker-api';
import { continuityTile, left, parent, right } from './testing/continuity';
import { placeGrid } from '../grid';
import { treeGust } from '../glyphs/select';
import type { ProcessionRoute } from '@atlas/shared';
import { createInlineHost } from './host';
import { LifePreparation } from './preparation';

describe('life worker protocol', () => {
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

  it('clones identical brake, hazard and exhaust frames through the worker protocol', () => {
    const scenario = makeScenario('transit', 1);
    const traffic = { road_major: { jeepney: 1 } };
    const direct = new LifeWorld(traffic),
      api = createLifeWorkerApi();
    direct.sync(scenario.tiles);
    api.init({ traffic, processions: [] });
    api.sync(structuredClone(scenario.tiles));
    const input: FrameInput = {
      gust: {
        camera: { lng: scenario.center[0], lat: scenario.center[1], zoom: 20 },
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
      visible: [20, 1, scenario.center],
    };
    const seen = { brake: false, hazard: false, puff: false };
    for (let frame = 0; frame < 100; frame++) {
      input.gust.time = frame / 10;
      const expected = runLifeFrame(direct, input);
      for (const agent of expected.agents) delete agent.consist;
      const actual = api.frame(input);
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
      nextActual = api.frame(input);
    expect(nextActual.agents).toEqual(nextExpected.agents);
    expect(
      Buffer.from(nextActual.puffs.buffer).equals(Buffer.from(nextExpected.puffs.buffer)),
    ).toBe(true);
  }, 10000);

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
