import type { CameraState } from '@atlas/shared';
import { describe, expect, it, vi } from 'vitest';
import { project, TILE_SIZE, viewportFor } from './camera';
import {
  ancestorAt,
  boundsTiles,
  findAncestor,
  LruCache,
  parentOf,
  RequestQueue,
  tileKey,
  tileZoom,
  viewTiles,
  type TileHeader,
} from './tiles';

const header: TileHeader = { minZoom: 12, maxZoom: 16, bounds: [123.1, 13.5, 123.4, 13.8] };
const size = { width: 1280, height: 800 };
const at = (zoom: number): CameraState => ({ lat: 13.62, lng: 123.19, zoom, pitch: 0, bearing: 0 });

describe('tileZoom', () => {
  it('uses the archive level for the zoom, overzooming past max and underzooming below min', () => {
    expect(tileZoom(14.7, header)).toBe(14);
    expect(tileZoom(18.2, header)).toBe(16);
    expect(tileZoom(8, header)).toBe(12);
  });
});

describe('viewTiles', () => {
  it('covers the view plus a margin, nearest to the center first', () => {
    const camera = at(14.5);
    const tiles = viewTiles(camera, size, header);
    const tileSize = TILE_SIZE * 2 ** (camera.zoom - 14);
    const across = Math.ceil(size.width / tileSize) + 2;
    expect(tiles.every((t) => t.z === 14)).toBe(true);
    expect(tiles.length).toBeGreaterThanOrEqual(across);
    const [cx, cy] = project(camera.lng, camera.lat, camera.zoom);
    expect(tiles[0]).toEqual({ z: 14, x: Math.floor(cx / tileSize), y: Math.floor(cy / tileSize) });
  });

  it('overzooms: z18 still asks for z16 tiles, a handful of them', () => {
    const tiles = viewTiles(at(18), size, header);
    expect(tiles.every((t) => t.z === 16)).toBe(true);
    expect(tiles.length).toBeLessThanOrEqual(16);
  });

  it('only asks for tiles where the archive has data', () => {
    // At zoom 8 the view spans far more than the data; only the data's z12 tiles are asked for.
    const tiles = viewTiles(at(8), size, header);
    const [x0, y0] = project(123.1, 13.8, 12).map((v) => Math.floor(v / TILE_SIZE));
    const [x1, y1] = project(123.4, 13.5, 12).map((v) => Math.floor(v / TILE_SIZE));
    expect(tiles.length).toBe((x1! - x0! + 1) * (y1! - y0! + 1));
    for (const t of tiles) {
      expect(t.x).toBeGreaterThanOrEqual(x0!);
      expect(t.x).toBeLessThanOrEqual(x1!);
      expect(t.y).toBeGreaterThanOrEqual(y0!);
      expect(t.y).toBeLessThanOrEqual(y1!);
    }
  });

  it('returns nothing when the view is away from the data', () => {
    expect(viewTiles({ ...at(15), lng: 0, lat: 0 }, size, header)).toEqual([]);
  });
});

describe('tile fallback', () => {
  it('finds the nearest cached ancestor', () => {
    const tile = { z: 16, x: 55201, y: 30251 };
    expect(parentOf(tile)).toEqual({ z: 15, x: 27600, y: 15125 });
    const cached = new Set([tileKey({ z: 13, x: 6900, y: 3781 })]);
    expect(findAncestor(tile, 12, (k) => cached.has(k))).toEqual({ z: 13, x: 6900, y: 3781 });
    expect(findAncestor(tile, 14, (k) => cached.has(k))).toBeNull();
  });
});

describe('LruCache', () => {
  it('evicts the least recently used entry and releases it', () => {
    const evicted = vi.fn();
    const cache = new LruCache<string>(2, evicted);
    cache.set('a', 'A');
    cache.set('b', 'B');
    cache.get('a');
    cache.set('c', 'C');
    expect(evicted).toHaveBeenCalledWith('B');
    expect(cache.has('a') && cache.has('c') && !cache.has('b')).toBe(true);
    cache.clear();
    expect(evicted).toHaveBeenCalledTimes(3);
    expect(cache.size).toBe(0);
  });

  it('releases a replaced value', () => {
    const evicted = vi.fn();
    const cache = new LruCache<string>(2, evicted);
    cache.set('a', 'A1');
    cache.set('a', 'A2');
    expect(evicted).toHaveBeenCalledWith('A1');
    expect(cache.get('a')).toBe('A2');
  });
});

describe('boundsTiles (tilted views)', () => {
  it('covers a tilted view, which reaches farther than the flat one', () => {
    const flat = viewTiles(at(15), size, header);
    const tilted = { ...at(15), pitch: 55 };
    const [[w, s], [e, n]] = viewportFor(tilted, size).getBounds() as [
      [number, number],
      [number, number],
    ];
    const [[, fs], [, fn]] = viewportFor(at(15), size).getBounds() as [
      [number, number],
      [number, number],
    ];
    expect(n - s).toBeGreaterThan(fn - fs); // the tilted view sees farther toward the horizon
    const tiles = boundsTiles([w, s, e, n], 15, header, [tilted.lng, tilted.lat]);
    expect(tiles.length).toBeGreaterThan(flat.length);
    // Nearest to the center first.
    const [cx, cy] = project(tilted.lng, tilted.lat, 15).map((v) => Math.floor(v / TILE_SIZE));
    expect(tiles[0]).toEqual({ z: 15, x: cx, y: cy });
  });

  it('stays within the archive data and the cap', () => {
    expect(boundsTiles([0, 0, 1, 1], 14, header, [0.5, 0.5])).toEqual([]);
    expect(boundsTiles([-180, -85, 180, 85], 14, header, [123.2, 13.6], 10)).toHaveLength(10);
  });
});

describe('ancestorAt', () => {
  it('finds the tile at a coarser zoom that contains a tile', () => {
    expect(ancestorAt({ z: 16, x: 55_247, y: 30_252 }, 11)).toEqual({ z: 11, x: 1726, y: 945 });
    expect(ancestorAt({ z: 3, x: 5, y: 2 }, 3)).toEqual({ z: 3, x: 5, y: 2 });
    expect(ancestorAt({ z: 9, x: 431, y: 236 }, 11)).toEqual({ z: 9, x: 431, y: 236 });
  });
});

describe('RequestQueue', () => {
  const tile = (x: number, z = 16) => ({ z, x, y: 0 });
  const setUp = () => {
    const sent: string[] = [];
    const queue = new RequestQueue((_, key) => sent.push(key), 2);
    return { queue, sent };
  };

  it('sends at most a few at once, in the order wanted, and the next as each is answered', () => {
    const { queue, sent } = setUp();
    queue.want([tile(1), tile(2), tile(3), tile(4)], 'view');
    expect(sent).toEqual(['16/1/0', '16/2/0']);
    expect(queue.size).toBe(4);
    expect(queue.has('16/3/0')).toBe(true);
    queue.done('16/1/0');
    expect(sent).toEqual(['16/1/0', '16/2/0', '16/3/0']);
    // An answer for a tile it never sent changes nothing.
    queue.done('16/9/0');
    expect(sent).toHaveLength(3);
  });

  it('drops queued tiles the view no longer wants, and puts the region first', () => {
    const { queue, sent } = setUp();
    queue.want([tile(1), tile(2), tile(3), tile(4)], 'view');
    // The view moved on (a fly-to): only the new tiles wait, and those sent aren't sent again.
    queue.want([tile(2), tile(10), tile(11)], 'view');
    expect(queue.has('16/3/0')).toBe(false);
    queue.want([tile(0, 11)], 'region');
    queue.done('16/1/0');
    queue.done('16/2/0');
    expect(sent).toEqual(['16/1/0', '16/2/0', '11/0/0', '16/10/0']);
    expect(queue.size).toBe(3);
  });
});
