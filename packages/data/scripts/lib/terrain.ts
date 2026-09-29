/**
 * Region-level terrain (SPEC.md §4: the `. : - = + * # %` ramp). The DEM is resampled onto a
 * regular lng/lat grid and cut into elevation bands; each band is a (multi)polygon of the
 * ground at or above its threshold, so the bands nest and the renderer draws the highest one.
 */
import type { BBox } from '@atlas/shared';
import { contours } from 'd3-contour';
import type { Feature, MultiPolygon } from 'geojson';
import { fromArrayBuffer } from 'geotiff';
import { readArrayBuffer } from './dem';

/** Band thresholds in meters; band i covers ground at or above `TERRAIN_THRESHOLDS[i]`. */
export const TERRAIN_THRESHOLDS = [1, 100, 250, 500, 800, 1200, 1600, 2000] as const;

/** About 180 m at the equator: plenty for the Region level, where a cell is over a kilometer. */
export const TERRAIN_STEP = 1 / 600;

/** Elevations on a lng/lat grid. Row 0 is the north edge; cell (i, j) spans one `step`. */
export type DemGrid = {
  values: Float32Array;
  width: number;
  height: number;
  west: number;
  north: number;
  step: number;
};

/** Resample DEM GeoTIFFs onto a grid covering `bbox`. Cells no tile covers are sea level. */
export async function readDemGrid(
  files: readonly string[],
  [west, south, east, north]: BBox,
  step = TERRAIN_STEP,
): Promise<DemGrid> {
  const width = Math.ceil((east - west) / step);
  const height = Math.ceil((north - south) / step);
  const values = new Float32Array(width * height);

  for (const file of files) {
    const image = await (await fromArrayBuffer(await readArrayBuffer(file))).getImage();
    const [bw, bs, be, bn] = image.getBoundingBox() as [number, number, number, number];
    // Read at about the grid's resolution, so large tiles are downsampled while decoding.
    const tw = Math.max(1, Math.round((be - bw) / step));
    const th = Math.max(1, Math.round((bn - bs) / step));
    const rasters = await image.readRasters({
      samples: [0],
      width: tw,
      height: th,
      resampleMethod: 'nearest',
    });
    const band = (rasters as unknown as ArrayLike<number>[])[0]!;

    const i0 = Math.max(0, Math.floor((bw - west) / step));
    const i1 = Math.min(width, Math.ceil((be - west) / step));
    const j0 = Math.max(0, Math.floor((north - bn) / step));
    const j1 = Math.min(height, Math.ceil((north - bs) / step));
    for (let j = j0; j < j1; j++) {
      const lat = north - (j + 0.5) * step;
      const ty = Math.floor(((bn - lat) / (bn - bs)) * th);
      if (ty < 0 || ty >= th) continue;
      for (let i = i0; i < i1; i++) {
        const lng = west + (i + 0.5) * step;
        const tx = Math.floor(((lng - bw) / (be - bw)) * tw);
        if (tx < 0 || tx >= tw) continue;
        const v = band[ty * tw + tx]!;
        // Voids and no-data (large negative values) count as sea level.
        values[j * width + i] = v > -1000 ? Math.max(0, v) : 0;
      }
    }
  }
  return { values, width, height, west, north, step };
}

export type TerrainProperties = { band: number; elevation_min: number };

const round = (n: number) => Math.round(n * 1e5) / 1e5;

/** One feature per non-empty band, from lowest to highest, in lng/lat. */
export function terrainBands(
  grid: DemGrid,
  thresholds: readonly number[] = TERRAIN_THRESHOLDS,
): Feature<MultiPolygon, TerrainProperties>[] {
  const bands = contours()
    .size([grid.width, grid.height])
    .thresholds([...thresholds])(Array.from(grid.values));
  const toLngLat = ([x, y]: number[]): [number, number] => [
    round(grid.west + x! * grid.step),
    round(grid.north - y! * grid.step),
  ];
  return bands
    .map((band, i) => ({
      type: 'Feature' as const,
      geometry: {
        type: 'MultiPolygon' as const,
        coordinates: band.coordinates.map((polygon) => polygon.map((ring) => ring.map(toLngLat))),
      },
      properties: { band: i + 1, elevation_min: thresholds[i]! },
    }))
    .filter((f) => f.geometry.coordinates.length > 0);
}
