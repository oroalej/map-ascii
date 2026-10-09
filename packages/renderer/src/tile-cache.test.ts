import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { GL } from './gpu';
import { FrameProfiler } from './profile';
import type * as tiles from './tiles';
import { tileKey, type TileId, type TileSourceHandlers } from './tiles';

// The tile worker doesn't run under jsdom: stand in for the source, and for the GPU uploads.
const sources: { handlers: TileSourceHandlers; request: Mock<(tile: TileId) => void> }[] = [];
vi.mock('./tiles', async (importOriginal) => {
  const actual = await importOriginal<typeof tiles>();
  class FakeSource {
    /** Each tile wanted, one call per tile, in the order wanted. */
    request = vi.fn<(tile: TileId) => void>();
    want = vi.fn((wanted: readonly TileId[]) => wanted.forEach((t) => this.request(t)));
    destroy = vi.fn();
    setFireworksActive = vi.fn();
    constructor(_url: string, handlers: TileSourceHandlers) {
      sources.push({ handlers, request: this.request });
    }
  }
  return { ...actual, TileSource: FakeSource };
});
const deleteTile = vi.fn<(...args: unknown[]) => void>();
vi.mock('./gpu', () => ({
  uploadTile: vi.fn(() => ({ mesh: true })),
  deleteTile: (...args: unknown[]) => {
    deleteTile(...args);
  },
}));

const { RETRY_MS, TileCache } = await import('./tile-cache');

const camera = { lat: 13.62, lng: 123.19, zoom: 14.5 };
const size = { width: 400, height: 300 };
const header = { minZoom: 7, maxZoom: 16, bounds: [123, 13.5, 123.4, 13.8] as const };
const geometry = { labels: [] } as never;

beforeEach(() => {
  sources.length = 0;
  deleteTile.mockClear();
});

function setup() {
  const onChange = vi.fn();
  const cache = new TileCache({} as GL, 'https://example.test/x.pmtiles', onChange);
  const source = sources[0]!;
  source.handlers.header({ ...header, bounds: [...header.bounds] });
  return { cache, source, onChange };
}

describe('TileCache', () => {
  it('resolves view membership without changing what the view wants', () => {
    const { cache, source } = setup();
    expect(cache.tilesToDraw(camera, size, false)).toEqual([]);
    expect(source.request).not.toHaveBeenCalled();
    cache.tilesToDraw(camera, size);
    expect(source.request).toHaveBeenCalled();
    const fine = source.request.mock.calls[0]![0];
    source.handlers.tile(tileKey(fine), geometry);
    source.request.mockClear();
    expect(cache.tilesToDraw(camera, size, false)).toContainEqual(fine);
    expect(source.request).not.toHaveBeenCalled();
  });
  it('requests coarse coverage before fine tiles and draws it while they load', () => {
    const { cache, source } = setup();
    expect(cache.regionTilesForView(camera, size)).toEqual([]);
    const coarse = source.request.mock.calls[0]![0];
    expect(coarse.z).toBeLessThan(camera.zoom);
    const coarseRequests = source.request.mock.calls.length;
    expect(cache.tilesToDraw(camera, size)).toEqual([]);
    expect(source.request.mock.calls[coarseRequests]![0].z).toBeGreaterThan(coarse.z);
    source.handlers.tile(tileKey(coarse), geometry);
    expect(cache.regionTilesForView(camera, size)).toContainEqual(coarse);
    expect(cache.tilesToDraw(camera, size)).toContainEqual(coarse);
    cache.suspend();
    source.request.mockClear();
    expect(cache.regionTilesForView(camera, size)).toEqual([]);
    expect(source.request).not.toHaveBeenCalled();
    cache.resume();
    expect(cache.regionTilesForView(camera, size)).toEqual([]);
    expect(source.request).toHaveBeenCalled();
  });

  it('does not request coarse coverage before the archive header arrives', () => {
    const cache = new TileCache({} as GL, 'https://example.test/x.pmtiles', vi.fn());
    expect(cache.regionTilesForView(camera, size)).toEqual([]);
    expect(sources[0]!.request).not.toHaveBeenCalled();
  });

  it('keeps loaded region children visible while a zoomed-out tile loads', () => {
    const { cache, source } = setup();
    cache.regionTilesForView(camera, size);
    const child = source.request.mock.calls[0]![0];
    expect(child.z).toBe(11);
    const absentChild = { ...child, x: child.x ^ 1 };
    source.handlers.tile(tileKey(child), geometry);
    source.handlers.tile(tileKey(absentChild), null);
    source.request.mockClear();
    const zoomedOut = { ...camera, zoom: 10.5 };
    expect(cache.regionTilesForView(zoomedOut, size)).toContainEqual(child);
    expect(cache.regionTilesForView(zoomedOut, size)).not.toContainEqual(absentChild);
    expect(source.request.mock.calls.every(([tile]) => tile.z === 10)).toBe(true);
    expect(cache.tilesToDraw(zoomedOut, size)).toContainEqual(child);
  });

  it.each([false, true])(
    'draws a loaded grandparent through a null parent and view absence=%s',
    (absent) => {
      const { cache, source } = setup();
      cache.tilesToDraw(camera, size);
      const tile = source.request.mock.calls[0]![0];
      const parent = { z: tile.z - 1, x: Math.floor(tile.x / 2), y: Math.floor(tile.y / 2) };
      const grandparent = { z: tile.z - 2, x: Math.floor(tile.x / 4), y: Math.floor(tile.y / 4) };
      source.handlers.tile(tileKey(parent), null);
      source.handlers.tile(tileKey(grandparent), geometry);
      if (absent) source.handlers.tile(tileKey(tile), null);
      source.request.mockClear();
      expect(cache.tilesToDraw(camera, size)).toContainEqual(grandparent);
      expect(cache.tilesToDraw(camera, size)).not.toContainEqual(parent);
      expect(cache.tilesToDraw(camera, size)).not.toContainEqual(tile);
      expect(
        source.request.mock.calls.some(([requested]) => tileKey(requested) === tileKey(tile)),
      ).toBe(!absent);
    },
  );
  it('excludes null children from fallback', () => {
    const { cache, source } = setup();
    cache.tilesToDraw(camera, size);
    const tile = source.request.mock.calls[0]![0];
    const child = { z: tile.z + 1, x: tile.x * 2, y: tile.y * 2 };
    source.handlers.tile(tileKey(child), null);
    expect(cache.tilesToDraw(camera, size)).not.toContainEqual(child);
  });
  it('backfills detailed tiles loaded before activation and remembers computed-empty sites', () => {
    const { cache, source } = setup();
    const tile = { z: 16, x: 55193, y: 30261 };
    source.handlers.tile(tileKey(tile), geometry);
    expect(cache.get(tile)?.residential).toBeUndefined();
    expect(cache.residentialSitesFor(camera, size, false, [tile])).toEqual([]);
    expect(source.request).not.toHaveBeenCalled();
    expect(cache.residentialSitesFor(camera, size, true, [tile])).toEqual([]);
    expect(source.request).toHaveBeenCalledExactlyOnceWith(tile);
    const sites = new Float64Array();
    source.handlers.residential!(`residential/${tileKey(tile)}`, sites);
    expect(cache.get(tile)?.residential).toBe(sites);
    source.request.mockClear();
    expect(cache.residentialSitesFor(camera, size, true, [tile])).toEqual([{ tile, sites }]);
    expect(source.request).not.toHaveBeenCalled();
    expect(cache.residentialSitesFor(camera, size, false, [tile])).toEqual([]);
    expect(cache.residentialSitesFor(camera, size, true, [tile])).toEqual([{ tile, sites }]);
    expect(source.request).not.toHaveBeenCalled();
  });
  it('retains decoded residential anchors separately from the GPU and Life data', () => {
    const { cache, source } = setup();
    const tile = { z: 16, x: 55193, y: 30261 };
    const residential = new Float64Array([1, 1500, 2000]);
    source.handlers.tile(tileKey(tile), { labels: [], residential } as never);
    expect(cache.get(tile)?.residential).toBe(residential);
  });
  it('requests bounded cold coarse coverage only when selected and never uploads hidden meshes', () => {
    const { cache, source } = setup();
    const camera = { lat: 13.62, lng: 123.19, zoom: 8 };
    expect(cache.residentialSitesFor(camera, size, false)).toEqual([]);
    expect(source.request).not.toHaveBeenCalled();
    expect(cache.residentialSitesFor(camera, size, true)).toEqual([]);
    const requested = source.request.mock.calls.map(([tile]) => tile);
    expect(requested.length).toBeGreaterThan(0);
    expect(requested.length).toBeLessThanOrEqual(16);
    expect(requested.every((tile) => tile.z === 12)).toBe(true);
    const tile = requested[0]!,
      sites = new Float64Array([1, 1500, 2000]);
    source.handlers.residential!(`residential/${tileKey(tile)}`, sites);
    expect(cache.size).toBe(0);
    expect(cache.residentialSitesFor(camera, size, true)).toContainEqual({ tile, sites });
    expect(cache.residentialSitesFor(camera, size, false)).toEqual([]);
    cache.destroy();
  });
  it('retains upload timings between callbacks, including context restoration', () => {
    let now = 0;
    const profiler = new FrameProfiler(() => now++);
    const cache = new TileCache({} as GL, 'https://example.test/x.pmtiles', () => {}, profiler);
    const { handlers } = sources[0]!;
    handlers.tile('16/1/1', geometry);
    profiler.begin(1);
    profiler.end();
    expect(profiler.snapshot().stages.tileUpload).toMatchObject({ count: 1, medianMs: 1 });
    profiler.reset();
    cache.suspend();
    handlers.tile('16/1/1', geometry);
    cache.resume();
    handlers.tile('16/1/1', geometry);
    handlers.tile('16/1/2', null);
    profiler.begin(2);
    profiler.end();
    expect(profiler.snapshot().stages.tileUpload).toMatchObject({ count: 1, medianMs: 1 });
    cache.destroy();
  });
  it('requests the view’s tiles and draws them once loaded', () => {
    const { cache, source } = setup();
    expect(cache.tilesToDraw(camera, size)).toEqual([]);
    const requested = source.request.mock.calls.map(([t]) => t);
    expect(requested.length).toBeGreaterThan(0);
    expect(requested.every((t) => t.z === 14)).toBe(true);
    const first = requested[0]!;
    source.handlers.tile(tileKey(first), geometry);
    expect(cache.tilesToDraw(camera, size)).toContainEqual(first);
  });

  it('after a lost context, forgets its meshes without deleting them and asks again', () => {
    const { cache, source } = setup();
    cache.tilesToDraw(camera, size);
    const tile = source.request.mock.calls[0]![0];
    const key = tileKey(tile);
    source.handlers.tile(key, geometry);
    expect(cache.size).toBe(1);

    cache.suspend();
    expect(cache.size).toBe(0);
    expect(deleteTile).not.toHaveBeenCalled();
    // Tiles that arrive while the context is lost are dropped, and nothing is drawn.
    source.handlers.tile(key, geometry);
    expect(cache.size).toBe(0);
    source.request.mockClear();
    expect(cache.tilesToDraw(camera, size)).toEqual([]);
    expect(source.request).not.toHaveBeenCalled();

    cache.resume();
    cache.tilesToDraw(camera, size);
    expect(source.request).toHaveBeenCalledWith(tile);
  });

  it('asks again for a tile that failed, backing off, until it loads', () => {
    vi.useFakeTimers();
    try {
      const { cache, source, onChange } = setup();
      cache.tilesToDraw(camera, size);
      const tile = source.request.mock.calls[0]![0];
      const key = tileKey(tile);
      const asked = () => source.request.mock.calls.some(([t]) => tileKey(t) === key);
      const fail = () => source.handlers.error('network', key);
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      fail();
      source.request.mockClear();
      onChange.mockClear();
      cache.tilesToDraw(camera, size);
      expect(asked()).toBe(false);
      // When the retry is due, the view is told to redraw, and asks again.
      vi.advanceTimersByTime(RETRY_MS);
      expect(onChange).toHaveBeenCalled();
      cache.tilesToDraw(camera, size);
      expect(asked()).toBe(true);

      // A second failure waits twice as long.
      fail();
      source.request.mockClear();
      vi.advanceTimersByTime(RETRY_MS);
      cache.tilesToDraw(camera, size);
      expect(asked()).toBe(false);
      vi.advanceTimersByTime(RETRY_MS);
      cache.tilesToDraw(camera, size);
      expect(asked()).toBe(true);

      // Loaded, it is drawn, and a later failure starts the backoff over.
      source.handlers.tile(key, geometry);
      expect(cache.tilesToDraw(camera, size)).toContainEqual(tile);
      cache.destroy();
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });
});
