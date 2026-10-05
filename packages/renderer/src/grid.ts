import type { CameraState } from '@atlas/shared';
import type { TileId } from './tiles';
import { project, TILE_SIZE } from './camera';
import { EXTENT, MERCATOR_METERS } from './raster/geometry';

/** Meters per CSS pixel at the camera's center. */
export const metersPerCssPx = (camera: CameraState) =>
  (MERCATOR_METERS * Math.cos((camera.lat * Math.PI) / 180)) / (TILE_SIZE * 2 ** camera.zoom);

/** What the passes need to know about the view. */
export type View = {
  camera: CameraState;
  dpr: number;
  /** Map cell size (density.ts: it shrinks as the camera zooms in). */
  cellDev: { w: number; h: number };
  /** Label cell size, fixed. */
  labelDev: { w: number; h: number };
  /**
   * The zoom cell-sized detail follows (density.ts `detailZoom`): outlines, road strips, and
   * roofs. What shows (class bands, labels) follows the camera zoom.
   */
  detailZoom: number;
  /** Canvas size in device pixels. */
  width: number;
  height: number;
};

/**
 * Where the cell grid sits: the world cell of texel (0, 0), and the device-pixel offset of the
 * screen's top-left corner inside the grid.
 */
export type Grid = { originCol: number; originRow: number; shiftX: number; shiftY: number };

/** Whole cells inside the viewport: inclusive left/top, exclusive right/bottom. */
export function screenArea(
  view: View,
  grid: Grid,
  cellDev = view.cellDev,
  out = { left: 0, top: 0, right: 0, bottom: 0 },
) {
  out.left = Math.ceil(grid.shiftX / cellDev.w);
  out.top = Math.ceil(grid.shiftY / cellDev.h);
  out.right = Math.floor((grid.shiftX + view.width) / cellDev.w);
  out.bottom = Math.floor((grid.shiftY + view.height) / cellDev.h);
  return out;
}

/** The grid for a view, and how tiles and points map onto it. */
export type GridPlacement = {
  grid: Grid;
  /** Zoom-zero world pixels to cells, without repeating geographic projection. */
  world?: readonly [number, number, number, number];
  /** Tile units → cell-grid clip space. */
  tileMatrix: (tile: TileId) => number[];
  /** A point's position on the grid, in (fractional) cells. */
  toCell: (lng: number, lat: number) => [number, number];
};

export function placeGrid(
  view: Pick<View, 'camera' | 'dpr' | 'width' | 'height'>,
  cellDev: { w: number; h: number },
  cols: number,
  rows: number,
): GridPlacement {
  const { camera, dpr, width: w, height: h } = view;
  // The map is flat and north-up (SPEC.md §3): the grid is anchored to the world, shifted by the
  // sub-cell pan offset.
  const [cx, cy] = project(camera.lng, camera.lat, camera.zoom);
  const left = Math.round(cx * dpr - w / 2);
  const top = Math.round(cy * dpr - h / 2);
  const originCol = Math.floor(left / cellDev.w) - 1;
  const originRow = Math.floor(top / cellDev.h) - 1;
  return {
    world: [
      (2 ** camera.zoom * dpr) / cellDev.w,
      (2 ** camera.zoom * dpr) / cellDev.h,
      originCol,
      originRow,
    ],
    grid: {
      originCol,
      originRow,
      shiftX: left - originCol * cellDev.w,
      shiftY: top - originRow * cellDev.h,
    },
    tileMatrix: (tile) => {
      const tileDev = TILE_SIZE * 2 ** (camera.zoom - tile.z) * dpr;
      // prettier-ignore
      return [
        ((tileDev / EXTENT / cellDev.w) * 2) / cols, 0, 0, 0,
        0, ((tileDev / EXTENT / cellDev.h) * 2) / rows, 0, 0,
        0, 0, 1, 0,
        ((tile.x * tileDev) / cellDev.w - originCol) * (2 / cols) - 1,
        ((tile.y * tileDev) / cellDev.h - originRow) * (2 / rows) - 1, 0, 1,
      ];
    },
    toCell: (lng, lat) => {
      const [x, y] = project(lng, lat, camera.zoom);
      return [(x * dpr) / cellDev.w - originCol, (y * dpr) / cellDev.h - originRow];
    },
  };
}
