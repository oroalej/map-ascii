import { expect, it } from 'vitest';
import { LifeWorld } from './simulate';
import { LifeBuilder } from './geometry';
import { metersPerUnit, tileToLngLat } from '../raster/geometry';
import type { JunctionTable } from './junctions';
import { priorityFixture } from './testing/intersection-priority';
import { completeScenarioState } from './testing/scenarios';
import { createLifeWorkerApi, runLifeFrame, type FrameInput } from './worker-api';

const direct = priorityFixture(LifeWorld, LifeBuilder, metersPerUnit, false, true);
const remote = priorityFixture(LifeWorld, LifeBuilder, metersPerUnit, false, true);
direct.world.setProcessions([]);
const api = createLifeWorkerApi(undefined, () => remote.world);
api.init({ processions: [] });
api.sync([structuredClone(remote.entry)]);
const center = tileToLngLat(direct.entry.tile, direct.center);
const table = (direct.world as unknown as { junctions: JunctionTable }).junctions;
let multiple = false,
  released = false,
  closed = false,
  reopened = false;
for (let section = 0; section < 4; section++)
  it(`matches priority worker/inline closure and close junction state through section ${section + 1}`, () => {
    for (let frame = section * 12 * 30; frame < (section + 1) * 12 * 30; frame++) {
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
      expect(api.frame(input).agents).toEqual(runLifeFrame(direct.world, input).agents);
      const car = direct.life.movers[0]!,
        records = [...table.holds(car)];
      multiple ||= records.length >= 2;
      released ||= multiple && records.length < 2;
      closed ||= frame > 12 * 30 && table.snapshot().some((r) => !r.ready);
      reopened ||= closed && table.snapshot().some((r) => r.ready && r.since !== undefined);
      if (frame % 30 === 0)
        expect(completeScenarioState(remote.world)).toEqual(completeScenarioState(direct.world));
    }
    if (section === 3)
      expect({ multiple, released, closed, reopened }).toEqual({
        multiple: true,
        released: true,
        closed: true,
        reopened: true,
      });
    expect(completeScenarioState(remote.world)).toEqual(completeScenarioState(direct.world));
  });
