import { describe, expect, it } from 'vitest';
import { LifeWorld } from './simulate';
import { makeScenario } from './testing/scenarios';
import { createLifeWorkerApi, runLifeFrame, type FrameInput } from './worker-api';
import { placeGrid } from '../grid';
import { treeGust } from '../glyphs/select';
import type { DialogueChoice, ProcessionRoute } from '@atlas/shared';
import { LifeBuilder } from './geometry';
import { activityLevels } from './config';
import { metersPerUnit, tileToLngLat } from '../raster/geometry';

describe('life worker protocol', () => {
  it('transfers real speech cues with exact inline parity through eviction and reload', () => {
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
    const direct = new LifeWorld(undefined, undefined, { dialogue });
    direct.sync(tiles);
    const api = createLifeWorkerApi();
    api.init({ processions: [], dialogue });
    api.sync(structuredClone(tiles));
    let spoken = 0;
    for (let frame = 0; frame < 600; frame++) {
      if (frame === 120) {
        direct.sync([]);
        api.sync([]);
      }
      if (frame === 121) {
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
          weather: { rain: 0, minutes: 720 },
          cellMeters: 0.2,
        },
        visible: [21, activityLevels(1), center],
      };
      const inline = runLifeFrame(direct, input),
        remote = api.frame(input);
      expect(remote.agents).toEqual(inline.agents);
      spoken += remote.agents.filter((agent) => agent.speech).length;
      expect(structuredClone(remote.agents)).toEqual(remote.agents);
    }
    expect(spoken).toBeGreaterThan(0);
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
  });

  it('rejects missing geometry instead of silently losing a tile', () => {
    const api = createLifeWorkerApi();
    api.init({ processions: [], profiling: false });
    expect(() => api.sync([{ key: 'missing', tile: { x: 0, y: 0, z: 16 } }])).toThrow('geometry');
  });
});
