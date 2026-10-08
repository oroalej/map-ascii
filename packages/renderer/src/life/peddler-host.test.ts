import { afterEach, expect, it, vi } from 'vitest';
import type { PeddlerConfig } from '@atlas/shared';
import { LifeWorld } from './simulate';
import { configureLifeWorld, createLifeWorkerApi } from './worker-api';
import { createConfiguredInlineHost } from './inline-host';

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
