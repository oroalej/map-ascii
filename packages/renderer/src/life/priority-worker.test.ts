import { afterAll, beforeAll, expect, it } from 'vitest';
import { LifeWorld } from './simulate';
import { LifeBuilder } from './geometry';
import { metersPerUnit, tileToLngLat } from '../raster/geometry';
import type { JunctionTable } from './junctions';
import { priorityFixture } from './testing/intersection-priority';
import { completeScenarioState } from './testing/scenarios';
import {
  preparePriorityTransitions,
  observePriorityTransitions,
} from './testing/priority-transitions';
import { createLifeWorkerApi, runLifeFrame, type FrameInput } from './worker-api';
import { deliver } from './testing/worker-reply';

const direct = priorityFixture(LifeWorld, LifeBuilder, metersPerUnit, false, true);
const remote = priorityFixture(LifeWorld, LifeBuilder, metersPerUnit, false, true);
for (const f of [direct, remote]) preparePriorityTransitions(f, 12);
direct.world.setProcessions([]);
const api = createLifeWorkerApi(undefined, () => remote.world);
api.init({ processions: [] });
api.sync([structuredClone(remote.entry)]);
const center = tileToLngLat(direct.entry.tile, direct.center);
const table = (direct.world as unknown as { junctions: JunctionTable }).junctions;
const transitions = observePriorityTransitions(direct);
let multiple = false,
  released = false;
const checkpoints: {
  direct: ReturnType<typeof completeScenarioState>;
  remote: ReturnType<typeof completeScenarioState>;
  multiple: boolean;
  released: boolean;
  transitions: typeof transitions.state;
}[] = [];
afterAll(() => transitions.restore());
for (let section = 0; section < 4; section++) {
  beforeAll(() => {
    for (let frame = section * 12 * 30; frame < (section + 1) * 12 * 30; frame++) {
      transitions.beforeStep();
      if (frame === 30 * 30)
        for (const f of [direct, remote])
          for (const m of f.life.movers) if (m.kind === 'vehicle') m.speed = 8 * f.life.perMeter;
      direct.beforeStep();
      remote.beforeStep();
      const input: FrameInput = {
        gust: {
          camera: { lng: center[0], lat: center[1], zoom: 18 },
          size: { width: 800, height: 600 },
          cssCell: { w: 5, h: 7.5 },
          time: frame / 30,
          wind: { dir: [1, 0], strength: 0 },
        },
        step: {
          dt: 1 / 30,
          zoom: 18,
          bounds: undefined,
          wind: undefined,
          weather: { rain: 0, minutes: 720 },
          cellMeters: 0.9,
        },
        visible: [18, 1, center],
      };
      expect(deliver(api.frame(input)).agents).toEqual(runLifeFrame(direct.world, input).agents);
      const car = direct.life.movers[0]!,
        records = [...table.holds(car)];
      multiple ||= records.length >= 2;
      released ||= multiple && records.length < 2;
      transitions.afterStep();
      if (frame % 30 === 0)
        expect(completeScenarioState(remote.world)).toEqual(completeScenarioState(direct.world));
    }
    checkpoints.push({
      direct: completeScenarioState(direct.world),
      remote: completeScenarioState(remote.world),
      multiple,
      released,
      transitions: { ...transitions.state },
    });
  });
  it(`matches priority worker/inline closure and close junction state through section ${section + 1}`, () => {
    const checkpoint = checkpoints[section]!;
    expect(checkpoint.remote).toEqual(checkpoint.direct);
    if (section === 3) {
      expect({ multiple: checkpoint.multiple, released: checkpoint.released }).toEqual({
        multiple: true,
        released: true,
      });
      expect(checkpoint.transitions).toMatchObject({
        overWait: true,
        closed: true,
        revoked: true,
        reopened: true,
      });
    }
  });
}
