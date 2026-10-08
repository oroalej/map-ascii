import { afterEach, expect, it, vi } from 'vitest';
import type { PeddlerConfig } from '@atlas/shared';
import { LifeWorld } from './simulate';
import { configureLifeWorld, createLifeWorkerApi } from './worker-api';
import { createConfiguredInlineHost } from './inline-host';
import { peddlerGeometry, peddlerTile, peddlerCenter, peddlerConfig } from './testing/peddlers';
import type { FrameInput } from './worker-api';

afterEach(() => vi.restoreAllMocks());
const peddlers: PeddlerConfig[] = [
  {
    id: 'sample',
    label: 'Sample vendor',
    prop: 'basket',
    hours: { from: 5, to: 11 },
    lines: ['path'],
    perTile: 1,
    source: [{ title: 'Illustrative' }],
  },
];
it('threads opt-in configuration through worker and configured inline initialization', () => {
  const setter = vi.spyOn(LifeWorld.prototype, 'setPeddlers');
  const api = createLifeWorkerApi();
  api.init({ processions: [], peddlers });
  const inline = createConfiguredInlineHost({ cityLife: { source: 'Test', peddlers } }, []);
  expect(setter.mock.calls).toEqual([[peddlers], [peddlers]]);
  inline.dispose();
  api.clearTiles();
});
it('omitted configuration initializes an empty population', () => {
  const setter = vi.spyOn(LifeWorld.prototype, 'setPeddlers');
  configureLifeWorld(new LifeWorld(), { processions: [] });
  expect(setter).toHaveBeenCalledWith(undefined);
});
it('configured worker and inline frames produce identical active peddlers', () => {
  const config = [{ ...peddlerConfig, perTile: 1 as const }];
  const tiles = [{ key: 'peddler-host', tile: peddlerTile, life: peddlerGeometry() }];
  const api = createLifeWorkerApi();
  api.init({ processions: [], peddlers: config });
  const host = createConfiguredInlineHost({ cityLife: { source: 'Test', peddlers: config } }, []);
  api.sync(tiles);
  host.sync(tiles);
  const input: FrameInput = {
    gust: {
      camera: { lng: peddlerCenter[0], lat: peddlerCenter[1], zoom: 19 },
      size: { width: 500, height: 500 },
      cssCell: { w: 10, h: 18 },
      time: 0,
      wind: { dir: [1, 0], strength: 0 },
    },
    step: {
      dt: 0.1,
      zoom: 19,
      bounds: undefined,
      wind: undefined,
      weather: { minutes: 480, rain: 0, sunAltitude: 20 },
      cellMeters: 1,
    },
    visible: [19, 0, peddlerCenter, { rain: 0, sunAltitude: 20 }],
  };
  for (let i = 0; i < 3; i++) {
    const result = api.frame(input);
    host.request(input);
    expect(result.agents).toEqual(host.latest()!.agents);
    expect(result.agents.some((a) => a.peddler)).toBe(true);
  }
  host.dispose();
  api.clearTiles();
});
