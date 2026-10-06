import { activityLevels } from './config';
import { expect, it, vi } from 'vitest';
import { LifeWorld } from './simulate';
import { createLifeWorkerApi, runLifeFrame, type FrameInput } from './worker-api';
import { signalizedCrossingEntry, seedSignalizedCrossing } from './testing/signalized-crossing';
import { completeScenarioState } from './testing/scenarios';
import { tileToLngLat } from '../raster/geometry';
it('matches waiting reservations, phase release and geometry transfer in worker and inline worlds', () => {
  const worlds: LifeWorld[] = [];
  // eslint-disable-next-line @typescript-eslint/unbound-method -- apply supplies the intercepted instance.
  const sync = LifeWorld.prototype.sync;
  const intercept = vi.spyOn(LifeWorld.prototype, 'sync').mockImplementation(function (
    this: LifeWorld,
    ...args
  ) {
    sync.apply(this, args);
    if (!worlds.includes(this) && args[0].some((e) => e.key === 'signalized-crossing')) {
      worlds.push(this);
      seedSignalizedCrossing(this);
    }
  });
  try {
    const entry = signalizedCrossingEntry(),
      direct = new LifeWorld();
    direct.sync([entry]);
    const api = createLifeWorkerApi();
    api.init({ processions: [] });
    api.sync([structuredClone(entry)]);
    const center = tileToLngLat(entry.tile, { x: 2000, y: 2000 });
    for (let frame = 0; frame < 350; frame++) {
      const input: FrameInput = {
        gust: {
          camera: { lng: center[0], lat: center[1], zoom: 19 },
          size: { width: 800, height: 600 },
          cssCell: { w: 5, h: 7.5 },
          time: frame / 10,
          wind: { dir: [1, 0], strength: 0 },
        },
        step: {
          dt: 0.1,
          zoom: 19,
          bounds: undefined,
          wind: undefined,
          weather: { rain: 0 },
          cellMeters: 0.9,
        },
        visible: [19, activityLevels(1), center],
      };
      expect(api.frame(input).agents).toEqual(runLifeFrame(direct, input).agents);
    }
    expect(completeScenarioState(worlds[0]!)).toEqual(completeScenarioState(worlds[1]!));
    api.clearTiles();
  } finally {
    intercept.mockRestore();
  }
});
