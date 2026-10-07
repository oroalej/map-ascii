import { MessageChannel } from 'node:worker_threads';
import { expose, wrap, releaseProxy } from 'comlink';
import nodeEndpoint from 'comlink/dist/umd/node-adapter.js';
import { expect, it } from 'vitest';
import { LifeWorld } from './simulate';
import { makeScenario } from './testing/scenarios';
import {
  createLifeWorkerApi,
  runLifeFrame,
  type FrameInput,
  type LifeWorkerApi,
} from './worker-api';

it.each([false, true])(
  'preserves person provenance through real Comlink messages (inspection/profiling %s)',
  async (enabled) => {
    const { port1, port2 } = new MessageChannel();
    const api = createLifeWorkerApi(() => 0);
    expose(api, nodeEndpoint(port1));
    const remote = wrap<LifeWorkerApi>(nodeEndpoint(port2));
    const scenario = makeScenario('rain', 1, false);
    const direct = new LifeWorld(undefined, undefined, undefined, enabled);
    const input: FrameInput = {
      gust: {
        camera: { lng: scenario.center[0], lat: scenario.center[1], zoom: 18 },
        size: { width: 1920, height: 1080 },
        cssCell: { w: 10, h: 18 },
        time: 0,
        wind: { dir: [1, 0], strength: 0 },
      },
      step: {
        dt: 0,
        zoom: 18,
        bounds: scenario.bounds,
        wind: undefined,
        weather: undefined,
        cellMeters: 0.9,
      },
      visible: [18, scenario.levels, scenario.center],
    };
    try {
      await remote.init({ processions: [], itemInspection: enabled, profiling: enabled });
      direct.sync(scenario.tiles);
      await remote.sync(scenario.tiles);
      for (let frame = 0; frame < 6; frame++) {
        if (frame === 2) {
          input.step.zoom = 16;
          input.visible[0] = 16;
        }
        if (frame === 3) {
          direct.clearTiles();
          await remote.clearTiles();
        }
        if (frame === 4) {
          direct.sync(scenario.tiles);
          await remote.sync(scenario.tiles);
          input.step.zoom = 18;
          input.visible[0] = 18;
          delete input.inspection;
        }
        input.gust.time = frame / 30;
        const inline = runLifeFrame(direct, input);
        const reply = await remote.frame(input);
        expect(reply.agents).toEqual(inline.agents);
        expect(structuredClone(reply.agents)).toEqual(reply.agents);
        if ([0, 1, 4, 5].includes(frame))
          expect(reply.agents.some((agent) => agent.mappedPersonMover)).toBe(true);
        else expect(reply.agents.some((agent) => agent.mappedPersonMover)).toBe(false);
        if (frame === 0 && enabled) {
          const actor = reply.agents.find((agent) => agent.mappedPersonMover)!;
          input.inspection = { id: actor.inspectionId!, revision: 1, time: 0 };
        }
      }
    } finally {
      api.clearTiles();
      remote[releaseProxy]();
      port1.close();
      port2.close();
    }
  },
);
