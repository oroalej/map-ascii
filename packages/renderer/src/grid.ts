import type { CameraState } from '@atlas/shared';
import type { TileId } from './tiles';
import { project, unproject, TILE_SIZE } from './camera';
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
  /** Optional inverse for north-up crowd rasterization; forward-only placements omit it. */
  fromCell?: (col: number, row: number) => [number, number];
  /** Zoom-zero world pixels to cells, without repeating geographic projection. */
  world?: readonly [number, number, number, number];
  /** Tile units → cell-grid clip space. */
  tileMatrix: (tile: TileId) => number[];
  /** A point's position on the grid, in (fractional) cells. */
  toCell: (lng: number, lat: number) => [number, number];
};

/** Cells a window keeps beyond the viewport on each side (`windowMargin`). */
export type GridMargin = { cols: number; rows: number };
const NO_MARGIN: GridMargin = { cols: 0, rows: 0 };

/**
 * How far past the viewport the cell targets reach on each side, as a share of its size: a pan
 * inside it only moves the frozen window's offset, without drawing the cells again.
 */
export const PAN_MARGIN = 1 / 8;

/** A window's margin in cells for `view`. */
export const windowMargin = (
  view: Pick<View, 'width' | 'height'>,
  cellDev: { w: number; h: number },
): GridMargin => ({
  cols: Math.ceil((view.width * PAN_MARGIN) / cellDev.w),
  rows: Math.ceil((view.height * PAN_MARGIN) / cellDev.h),
});

/** Target size in cells: the viewport, a one-cell neighborhood, and the margin both sides. */
export function windowCells(
  view: Pick<View, 'width' | 'height'>,
  cellDev: { w: number; h: number },
): { cols: number; rows: number } {
  const margin = windowMargin(view, cellDev);
  return {
    cols: Math.ceil(view.width / cellDev.w) + 3 + 2 * margin.cols,
    rows: Math.ceil(view.height / cellDev.h) + 3 + 2 * margin.rows,
  };
}

/** The device-pixel top left of the screen for a camera, in world pixels at its zoom. */
function screenCorner(view: Pick<View, 'camera' | 'dpr' | 'width' | 'height'>) {
  const { camera, dpr, width: w, height: h } = view;
  const [cx, cy] = project(camera.lng, camera.lat, camera.zoom);
  return [Math.round(cx * dpr - w / 2), Math.round(cy * dpr - h / 2)] as const;
}

/**
 * The offset of `view`'s screen inside a frozen window: the window's origin stays, so its
 * texture, projection and caches stay valid; only where the screen sits in it moves.
 */
export function shiftGrid(
  view: Pick<View, 'camera' | 'dpr' | 'width' | 'height'>,
  cellDev: { w: number; h: number },
  grid: Grid,
): Grid {
  const [left, top] = screenCorner(view);
  return {
    originCol: grid.originCol,
    originRow: grid.originRow,
    shiftX: left - grid.originCol * cellDev.w,
    shiftY: top - grid.originRow * cellDev.h,
  };
}

/**
 * Whether the screen, and the one-cell neighborhood the select pass reads around it, lie inside
 * a `cols` × `rows` window: else the window has to be placed (and drawn) again.
 */
export function gridContains(
  grid: Grid,
  cellDev: { w: number; h: number },
  view: Pick<View, 'width' | 'height'>,
  cols: number,
  rows: number,
): boolean {
  return (
    grid.shiftX >= cellDev.w &&
    grid.shiftY >= cellDev.h &&
    grid.shiftX + view.width <= (cols - 1) * cellDev.w &&
    grid.shiftY + view.height <= (rows - 1) * cellDev.h
  );
}

/**
 * The fractional cell under a point `[x, y]` CSS pixels from the canvas's top left: the inverse
 * of the glyph pass, `cell = (screen + shift) / cell size`, whatever window the grid is in.
 * Everything mapping the screen to cells goes through it.
 */
export function cellAt(
  [x, y]: readonly [number, number],
  dpr: number,
  grid: { shiftX: number; shiftY: number; cellWidth: number; cellHeight: number },
): [number, number] {
  return [(x * dpr + grid.shiftX) / grid.cellWidth, (y * dpr + grid.shiftY) / grid.cellHeight];
}

/**
 * The cells the targets held before the pan margin: the viewport's cells and one more around
 * them (two on the right and bottom), in world cells. Crowd admission and its cap use them, so
 * margin cells never displace figures on screen.
 */
export function coreCells(
  grid: Grid,
  cellDev: { w: number; h: number },
  view: Pick<View, 'width' | 'height'>,
) {
  const left = Math.floor((grid.originCol * cellDev.w + grid.shiftX) / cellDev.w) - 1;
  const top = Math.floor((grid.originRow * cellDev.h + grid.shiftY) / cellDev.h) - 1;
  return {
    left,
    top,
    right: left + Math.ceil(view.width / cellDev.w) + 3,
    bottom: top + Math.ceil(view.height / cellDev.h) + 3,
  };
}

export function placeGrid(
  view: Pick<View, 'camera' | 'dpr' | 'width' | 'height'>,
  cellDev: { w: number; h: number },
  cols: number,
  rows: number,
  margin: GridMargin = NO_MARGIN,
): GridPlacement {
  const { camera, dpr } = view;
  // The map is flat and north-up (SPEC.md §3): the grid is anchored to the world, shifted by the
  // pan offset inside its window.
  const [left, top] = screenCorner(view);
  const originCol = Math.floor(left / cellDev.w) - 1 - margin.cols;
  const originRow = Math.floor(top / cellDev.h) - 1 - margin.rows;
  return {
    fromCell: (col, row) =>
      unproject(
        ((col + originCol) * cellDev.w) / dpr,
        ((row + originRow) * cellDev.h) / dpr,
        camera.zoom,
      ),
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
