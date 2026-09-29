import { describe, expect, it } from 'vitest';
import { FACADE_PERIOD, facadeFrame } from './passes';
import { WINDOW } from './life/config';
import { EXTENT } from './raster/geometry';

/** A tile-local point's position in window bays (the cell vertex shader's v_facade.xy). */
function bays(tile: { z: number; x: number; y: number }, px: number, py: number): [number, number] {
  const [ox, oy, scale] = facadeFrame(tile);
  return [ox + px * scale, oy + py * scale];
}

describe('facadeFrame', () => {
  const tile = { z: 16, x: 55_512, y: 30_471 };

  it('keeps the offset inside the period', () => {
    const [ox, oy] = facadeFrame(tile);
    for (const o of [ox, oy]) {
      expect(o).toBeGreaterThanOrEqual(0);
      expect(o).toBeLessThan(FACADE_PERIOD);
    }
  });

  it('lines up across neighboring tiles', () => {
    const [ex, ey] = bays(tile, EXTENT, EXTENT);
    const [nx] = bays({ ...tile, x: tile.x + 1 }, 0, EXTENT);
    const [, ny] = bays({ ...tile, y: tile.y + 1 }, EXTENT, 0);
    expect(nx % FACADE_PERIOD).toBeCloseTo(ex % FACADE_PERIOD, 6);
    expect(ny % FACADE_PERIOD).toBeCloseTo(ey % FACADE_PERIOD, 6);
  });

  it('puts a point in the same bay at every tile zoom', () => {
    // The same world point, inside a z16 tile and inside its z15 parent.
    const child = bays(tile, 1000, 3000);
    const parent = bays(
      { z: 15, x: tile.x >> 1, y: tile.y >> 1 },
      ((tile.x & 1) * EXTENT + 1000) / 2,
      ((tile.y & 1) * EXTENT + 3000) / 2,
    );
    expect(parent[0] % FACADE_PERIOD).toBeCloseTo(child[0] % FACADE_PERIOD, 6);
    expect(parent[1] % FACADE_PERIOD).toBeCloseTo(child[1] % FACADE_PERIOD, 6);
  });

  it('sizes a bay at the configured width in mercator meters', () => {
    const [, , scale] = facadeFrame(tile);
    const unitMeters = 40_075_016.686 / 2 ** tile.z / EXTENT;
    expect(unitMeters / scale).toBeCloseTo(WINDOW.bay, 9);
  });
});
