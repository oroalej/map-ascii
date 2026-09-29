import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GL } from './gpu';
import type * as tiles from './tiles';
import { tileKey, type TileId, type TileSourceHandlers } from './tiles';

// The tile worker doesn't run under jsdom: stand in for the source, and for the GPU uploads.
const sources: { handlers: TileSourceHandlers; request: ReturnType<typeof vi.fn> }[] = [];
vi.mock('./tiles', async (importOriginal) => {
  const actual = await importOriginal<typeof tiles>();
  class FakeSource {
    request = vi.fn();
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

const { TileCache } = await import('./tile-cache');

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
    const requested = source.request.mock.calls.map(([t]) => t as TileId);
    expect(requested.length).toBeGreaterThan(0);
    expect(requested.every((t) => t.z === 14)).toBe(true);
    const first = requested[0]!;
    source.handlers.tile(tileKey(first), geometry);
    expect(cache.tilesToDraw(camera, size)).toContainEqual(first);
  });

  it('after a lost context, forgets its meshes without deleting them and asks again', () => {
    const { cache, source } = setup();
    cache.tilesToDraw(camera, size);
    const tile = source.request.mock.calls[0]![0] as TileId;
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
});
