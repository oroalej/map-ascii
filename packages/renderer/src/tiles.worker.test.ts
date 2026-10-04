import { afterEach, expect, it, vi } from 'vitest';
import type { WorkerRequest } from './tiles';

vi.mock('pmtiles', () => ({
  PMTiles: class {
    getHeader() {
      return Promise.resolve({
        minZoom: 7,
        maxZoom: 16,
        minLon: 123,
        minLat: 13,
        maxLon: 124,
        maxLat: 14,
      });
    }
    getZxy() {
      return Promise.reject(new Error('network failure'));
    }
  },
}));

afterEach(() => vi.unstubAllGlobals());

it('identifies failed drawable and residential requests so their queue slots can be released', async () => {
  const scope = {
    postMessage: vi.fn(),
    onmessage: null as ((event: MessageEvent<WorkerRequest>) => void) | null,
  };
  vi.stubGlobal('self', scope);
  await import('./tiles.worker');
  scope.onmessage!({
    data: { type: 'init', url: '/test.pmtiles', fireworks: true },
  } as MessageEvent<WorkerRequest>);
  await vi.waitFor(() =>
    expect(scope.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'header' })),
  );
  for (const type of ['tile', 'residential'] as const) {
    const key = `${type}/12/1/2`;
    scope.onmessage!({ data: { type, key, z: 12, x: 1, y: 2 } } as MessageEvent<WorkerRequest>);
    await vi.waitFor(() =>
      expect(scope.postMessage).toHaveBeenCalledWith({
        type: 'error',
        key,
        message: 'network failure',
      }),
    );
  }
});
