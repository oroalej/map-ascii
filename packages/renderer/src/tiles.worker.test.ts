import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { WorkerRequest } from './tiles';
const fixtures = vi.hoisted(() => ({
  fetch: vi.fn(),
  geometry: vi.fn(),
  sites: vi.fn(() => new Float64Array([1, 100, 200])),
  memorials: vi.fn(),
}));

vi.mock('./life/seasonal-candles', () => ({ prepareMemorialSites: fixtures.memorials }));

vi.mock('@mapbox/vector-tile', () => ({
  VectorTile: class {
    layers = {};
  },
}));
vi.mock('./raster/geometry', () => ({
  buildTileGeometry: fixtures.geometry,
  buildResidentialSites: fixtures.sites,
  createIdRegistry: () => ({ takeNew: () => [] }),
  transferables: () => [],
}));

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
    getZxy = fixtures.fetch;
  },
}));

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  fixtures.fetch.mockRejectedValue(new Error('network failure'));
  fixtures.geometry.mockImplementation((_layers, _registry, _tile, _zoom, active) =>
    active ? { residential: new Float64Array() } : {},
  );
});

it('extracts drawable sites only when active, while finishing queued supplemental work across deactivation', async () => {
  fixtures.fetch.mockResolvedValue({ data: new Uint8Array() });
  const scope = {
    postMessage: vi.fn(),
    onmessage: null as ((event: MessageEvent<WorkerRequest>) => void) | null,
  };
  vi.stubGlobal('self', scope);
  await import('./tiles.worker');
  const send = (data: WorkerRequest) => scope.onmessage!({ data } as MessageEvent<WorkerRequest>);
  send({ type: 'init', url: '/test.pmtiles', fireworks: true, fireworksActive: false });
  await vi.waitFor(() => expect(scope.postMessage).toHaveBeenCalledTimes(1));
  for (const [n, active] of [false, true, false].entries()) {
    send({ type: 'fireworks', active });
    send({ type: 'tile', key: `12/${n}/2`, z: 12, x: n, y: 2 });
    await vi.waitFor(() => expect(fixtures.geometry).toHaveBeenCalledTimes(n + 1));
    expect(fixtures.geometry).toHaveBeenLastCalledWith(
      {},
      expect.anything(),
      { z: 12, x: n, y: 2 },
      16,
      active,
    );
  }
  send({ type: 'residential', key: 'residential/12/1/2', z: 12, x: 1, y: 2 });
  await vi.waitFor(() => expect(fixtures.sites).toHaveBeenCalledTimes(1));
  expect(scope.postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({ type: 'residential', sites: new Float64Array([1, 100, 200]) }),
    expect.any(Array),
  );
});

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

it('prepares memorial sites once at archive maximum zoom for capable packs before any preview', async () => {
  fixtures.fetch.mockResolvedValue({ data: new Uint8Array() });
  const life = {};
  fixtures.geometry.mockReturnValue({ life });
  const scope = {
    postMessage: vi.fn(),
    onmessage: null as ((event: MessageEvent<WorkerRequest>) => void) | null,
  };
  vi.stubGlobal('self', scope);
  await import('./tiles.worker');
  const send = (data: WorkerRequest) => scope.onmessage!({ data } as MessageEvent<WorkerRequest>);
  send({ type: 'init', url: '/test.pmtiles', memorials: false });
  await vi.waitFor(() => expect(scope.postMessage).toHaveBeenCalledTimes(1));
  send({ type: 'tile', key: '16/1/2', z: 16, x: 1, y: 2 });
  await vi.waitFor(() => expect(scope.postMessage).toHaveBeenCalledTimes(2));
  expect(fixtures.memorials).not.toHaveBeenCalled();
  send({ type: 'init', url: '/test.pmtiles', memorials: true });
  await vi.waitFor(() => expect(scope.postMessage).toHaveBeenCalledTimes(3));
  send({ type: 'tile', key: '15/1/2', z: 15, x: 1, y: 2 });
  await vi.waitFor(() => expect(scope.postMessage).toHaveBeenCalledTimes(4));
  expect(fixtures.memorials).not.toHaveBeenCalled();
  send({ type: 'tile', key: '16/1/3', z: 16, x: 1, y: 3 });
  await vi.waitFor(() => expect(fixtures.memorials).toHaveBeenCalledOnce());
  expect(fixtures.memorials).toHaveBeenCalledWith({ z: 16, x: 1, y: 3 }, life);
});
