import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { GL } from './gpu';
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

const camera = { lat: 13.62, lng: 123.19, zoom: 14.5, pitch: 0, bearing: 0 };
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
