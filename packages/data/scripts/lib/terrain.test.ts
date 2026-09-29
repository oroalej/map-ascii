import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import turfBbox from '@turf/bbox';
import { writeArrayBuffer } from 'geotiff';
import { describe, expect, it } from 'vitest';
import { demCells, demTileName } from './dem';
import { readDemGrid, terrainBands, type DemGrid } from './terrain';

/** A cone 1000 m high in the middle of a 40 × 40 grid over [0, 0, 0.4, 0.4]. */
function cone(): DemGrid {
  const width = 40;
  const values = new Float32Array(width * width);
  for (let j = 0; j < width; j++) {
    for (let i = 0; i < width; i++) {
      const d = Math.hypot(i + 0.5 - 20, j + 0.5 - 20);
      values[j * width + i] = Math.max(0, 1000 - d * 80);
    }
  }
  return { values, width, height: width, west: 0, north: 0.4, step: 0.01 };
}

describe('terrainBands', () => {
  it('cuts nested bands, higher ones inside lower ones', () => {
    const bands = terrainBands(cone(), [1, 500, 2000]);
    expect(bands.map((b) => b.properties)).toEqual([
      { band: 1, elevation_min: 1 },
      { band: 2, elevation_min: 500 },
    ]);
    const [low, high] = bands.map((b) => turfBbox(b));
    expect(high![0]).toBeGreaterThan(low![0]);
    expect(high![2]).toBeLessThan(low![2]);
    // Centered on the cone's peak.
    expect((high![0] + high![2]) / 2).toBeCloseTo(0.2, 2);
    expect((high![1] + high![3]) / 2).toBeCloseTo(0.2, 2);
  });
});

describe('DEM tiles', () => {
  it('names GLO-90 tiles by their south-west corner', () => {
    expect(demTileName(123, 13)).toBe('Copernicus_DSM_COG_30_N13_00_E123_00_DEM');
    expect(demTileName(-5, -1)).toBe('Copernicus_DSM_COG_30_S01_00_W005_00_DEM');
    expect(demCells([122.3, 11.5, 124.6, 12.2])).toEqual([
      [122, 11],
      [123, 11],
      [124, 11],
      [122, 12],
      [123, 12],
      [124, 12],
    ]);
  });

  it('resamples a GeoTIFF onto the grid', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atlas-dem-'));
    try {
      // 10 × 10 pixels over [0, 0, 1, 1]: 100 m in the west half, 200 m in the east half.
      const values = Uint8Array.from({ length: 100 }, (_, i) => (i % 10 < 5 ? 100 : 200));
      const tiff = writeArrayBuffer(values, {
        width: 10,
        height: 10,
        ModelPixelScale: [0.1, 0.1, 0],
        ModelTiepoint: [0, 0, 0, 0, 1, 0],
        GeographicTypeGeoKey: 4326,
        GTModelTypeGeoKey: 2,
      });
      const file = join(dir, 'dem.tif');
      await writeFile(file, new Uint8Array(tiff));
      const grid = await readDemGrid([file], [0, 0, 2, 1], 0.25);
      expect(grid.width).toBe(8);
      expect(grid.height).toBe(4);
      expect(Array.from(grid.values.slice(0, 8))).toEqual([100, 100, 200, 200, 0, 0, 0, 0]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
