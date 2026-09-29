/**
 * The frame's passes (ARCHITECTURE.md §3): the cell pass rasterizes tiles into one pixel per
 * cell, the overlay places labels on the cell grid, the select pass picks each cell's glyph, and
 * the glyph pass draws the glyphs at full resolution.
 */
import type { CameraState } from '@atlas/shared';
import * as twgl from 'twgl.js';
import { isTilted, multiply, project, TILE_SIZE, viewportFor } from './camera';
import { classDepths, classId, classVisibility } from './classes';
import { roadMask, seeThroughMask } from './glyphs/select';
import type { CellSize, Programs, ThemeResources } from './gpu-context';
import {
  drawExtrusions,
  drawGround,
  uploadOverlay,
  type CellTargets,
  type GL,
  type TileMesh,
} from './gpu';
import {
  createOverlay,
  labelVisibility,
  packOverlay,
  placeLabels,
  TILT_LABEL_GAP,
  TILT_LABEL_PITCH,
  tiltedLabelShows,
  streetMode,
  type LabelCandidate,
} from './labels';
import { EXTENT, type TileLabel } from './raster/geometry';
import type { Theme } from './theme';
import type { TileId } from './tiles';

const depths = classDepths();
const seeThrough = seeThroughMask();
const roads = roadMask();

/** 0xRRGGBB → [r, g, b] in 0–1. */
const rgb = (hex: number): [number, number, number] => [
  ((hex >> 16) & 0xff) / 255,
  ((hex >> 8) & 0xff) / 255,
  (hex & 0xff) / 255,
];

/** What the passes need to know about the view. */
export type View = {
  camera: CameraState;
  dpr: number;
  cellDev: CellSize;
  /** Canvas size in device pixels. */
  width: number;
  height: number;
};

/**
 * Where the cell grid sits: the world cell of texel (0, 0) (flat views; 0 when tilted), and the
 * device-pixel offset of the screen's top-left corner inside the grid.
 */
export type Grid = { originCol: number; originRow: number; shiftX: number; shiftY: number };

/** The grid for a view, and how tiles and points map onto it. */
export type GridPlacement = {
  grid: Grid;
  /** Tile units and meters → cell-grid clip space. */
  tileMatrix: (tile: TileId) => number[];
  /** A point's position on the grid, in (fractional) cells. */
  toCell: (lng: number, lat: number) => [number, number];
};

export function placeGrid(view: View, targets: CellTargets): GridPlacement {
  const { camera, dpr, cellDev, width: w, height: h } = view;
  const { cols, rows } = targets;
  if (isTilted(camera)) {
    const viewport = viewportFor(camera, { width: w / dpr, height: h / dpr });
    // Perspective: the grid is fixed to the screen, with a one-cell margin on each side.
    // prettier-ignore
    const screenToGrid = [
      w / (cellDev.w * cols), 0, 0, 0,
      0, -h / (cellDev.h * rows), 0, 0,
      0, 0, 1, 0,
      (w + 2 * cellDev.w) / (cellDev.w * cols) - 1, (h + 2 * cellDev.h) / (cellDev.h * rows) - 1, 0, 1,
    ];
    const toGrid = multiply(screenToGrid, viewport.viewProjectionMatrix);
    const unitsPerMeter = viewport.distanceScales.unitsPerMeter[2]!;
    return {
      grid: { originCol: 0, originRow: 0, shiftX: cellDev.w, shiftY: cellDev.h },
      tileMatrix: ({ z, x, y }) => {
        const size = TILE_SIZE / 2 ** z;
        // prettier-ignore
        return multiply(toGrid, [
          size / EXTENT, 0, 0, 0,
          0, -size / EXTENT, 0, 0,
          0, 0, unitsPerMeter, 0,
          x * size, TILE_SIZE - y * size, 0, 1,
        ]);
      },
      toCell: (lng, lat) => {
        // The grid starts one cell above and left of the screen.
        const [x, y] = viewport.project([lng, lat]) as [number, number];
        return [(x * dpr) / cellDev.w + 1, (y * dpr) / cellDev.h + 1];
      },
    };
  }
  // Flat north-up: the grid is anchored to the world, shifted by the sub-cell pan offset.
  const [cx, cy] = project(camera.lng, camera.lat, camera.zoom);
  const left = Math.round(cx * dpr - w / 2);
  const top = Math.round(cy * dpr - h / 2);
  const originCol = Math.floor(left / cellDev.w) - 1;
  const originRow = Math.floor(top / cellDev.h) - 1;
  return {
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

/**
 * The grid cells actually on screen (the grid has a margin, and a sub-cell pan shift):
 * [left, top] inclusive to [right, bottom] exclusive.
 */
export function screenArea(view: View, grid: Grid) {
  const { cellDev } = view;
  return {
    left: Math.ceil(grid.shiftX / cellDev.w),
    top: Math.ceil(grid.shiftY / cellDev.h),
    right: Math.floor((grid.shiftX + view.width) / cellDev.w),
    bottom: Math.floor((grid.shiftY + view.height) / cellDev.h),
  };
}

/** A tile to draw and its mesh. */
export type TileDraw = { tile: TileId; mesh: TileMesh };

/**
 * Rasterize the region's own features (from their coarser tiles) and then the view's tiles into
 * the cell targets; 3D buildings stand up only in the tilted view.
 */
export function cellPass(
  gl: GL,
  programs: Programs,
  targets: CellTargets,
  view: View,
  placement: GridPlacement,
  layers: { region: readonly TileDraw[]; tiles: readonly TileDraw[] },
) {
  const { cols, rows } = targets;
  const { camera } = view;
  const program = programs.cell;
  gl.bindFramebuffer(gl.FRAMEBUFFER, targets.cellFbo);
  gl.viewport(0, 0, cols, rows);
  for (let i = 0; i < 3; i++) gl.clearBufferfv(gl.COLOR, i, [0, 0, 0, 0]);
  gl.clearBufferfi(gl.DEPTH_STENCIL, 0, 1, 0);
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LESS);
  gl.useProgram(program.program);
  twgl.setUniforms(program, {
    u_depth: depths,
    u_vis: classVisibility(camera.zoom),
    u_zoom: camera.zoom,
    u_roadMask: roads,
    u_origin: [placement.grid.originCol, placement.grid.originRow],
  });
  for (const { tile, mesh } of layers.region) {
    twgl.setUniforms(program, { u_matrix: placement.tileMatrix(tile) });
    drawGround(gl, mesh.region);
  }
  const matrices = layers.tiles.map(({ tile }) => placement.tileMatrix(tile));
  layers.tiles.forEach(({ mesh }, i) => {
    twgl.setUniforms(program, { u_matrix: matrices[i]! });
    drawGround(gl, mesh);
  });
  if (isTilted(camera)) {
    layers.tiles.forEach(({ mesh }, i) => {
      twgl.setUniforms(program, { u_matrix: matrices[i]! });
      drawExtrusions(gl, mesh);
    });
  }
  gl.bindVertexArray(null);
  gl.disable(gl.DEPTH_TEST);
}

/**
 * Place the names whose zoom band reaches the camera zoom (labels.ts) and upload them to the
 * overlay texture. Returns the labels placed.
 */
export function overlayPass(
  gl: GL,
  targets: CellTargets,
  themeRes: ThemeResources,
  view: View,
  placement: GridPlacement,
  labels: Iterable<TileLabel>,
): LabelCandidate[] {
  const { camera } = view;
  const { toCell } = placement;
  const overlay = createOverlay(targets.cols, targets.rows);
  const tilted = isTilted(camera);
  const area = screenArea(view, placement.grid);
  const glyphs = themeRes.atlas;
  const glyphIndex = (char: string) => {
    const index = glyphs.index(char);
    return index === 0 ? undefined : index;
  };

  const candidates: LabelCandidate[] = [];
  for (const label of labels) {
    const vis = labelVisibility(label.band, camera.zoom);
    if (vis <= 0) continue;
    const [col, row] = toCell(label.lng, label.lat);
    if (tilted && !tiltedLabelShows(label.rank, row, targets.rows, camera.pitch)) continue;
    candidates.push({
      id: label.id,
      text: label.text,
      rank: label.rank,
      vis,
      col: Math.floor(col),
      row: Math.floor(row),
      // Street names follow the street in flat views; tilted ones keep them beside it.
      mode: label.angle !== undefined && !tilted ? streetMode(label.angle) : 'beside',
    });
  }
  const gap = camera.pitch > TILT_LABEL_PITCH ? TILT_LABEL_GAP : 0;
  const placed = placeLabels(overlay, candidates, glyphIndex, area, gap);
  uploadOverlay(gl, targets, packOverlay(overlay));
  return placed;
}

/** Highlight state for the select pass, as id-buffer indices (0 = none). */
export type Highlights = {
  hover: number;
  selected: number;
  highlight: Uint32Array;
  highlightCount: number;
};

/** Pick each cell's glyph from its class and neighbors. */
export function selectPass(
  gl: GL,
  programs: Programs,
  targets: CellTargets,
  themeRes: ThemeResources,
  view: View,
  grid: Grid,
  time: number,
  highlights: Highlights,
) {
  const { tables } = themeRes;
  gl.bindFramebuffer(gl.FRAMEBUFFER, targets.glyphFbo);
  gl.viewport(0, 0, targets.cols, targets.rows);
  gl.useProgram(programs.select.program);
  twgl.setUniforms(programs.select, {
    u_class: targets.classTex,
    u_attr: targets.attrTex,
    u_id: targets.idTex,
    u_table: themeRes.tableTex,
    u_kind: tables.kinds,
    u_count: tables.counts,
    u_connect: tables.connects,
    u_origin: [grid.originCol, grid.originRow],
    u_time: time,
    u_zoom: view.camera.zoom,
    u_seeThrough: seeThrough,
    u_roadMask: roads,
    u_tilted: isTilted(view.camera),
    u_cellAspect: view.cellDev.h / view.cellDev.w,
    u_hover: highlights.hover,
    u_selected: highlights.selected,
    u_highlight: highlights.highlight,
    u_highlightCount: highlights.highlightCount,
  });
  gl.bindVertexArray(programs.emptyVao);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

/** Draw the glyphs at full resolution, with the overlay's labels on top. */
export function glyphPass(
  gl: GL,
  programs: Programs,
  targets: CellTargets,
  themeRes: ThemeResources,
  theme: Theme,
  view: View,
  grid: Grid,
  time: number,
  reducedMotion: boolean,
) {
  const { atlas, tables } = themeRes;
  const { cellDev } = view;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, view.width, view.height);
  gl.useProgram(programs.glyph.program);
  twgl.setUniforms(programs.glyph, {
    u_glyphs: targets.glyphTex,
    u_atlas: themeRes.atlasTex,
    u_cell: [cellDev.w, cellDev.h],
    u_shift: [grid.shiftX, grid.shiftY],
    u_height: view.height,
    u_columns: atlas.columns,
    u_colors: tables.colors,
    u_background: theme.background.slice(0, 3),
    u_time: time,
    u_pulse: reducedMotion ? -1 : classId('marker_landmark'),
    u_overlay: targets.overlayTex,
    u_labelColor: rgb(theme.label),
    u_accent: rgb(theme.accent),
    u_shimmer: !reducedMotion,
  });
  gl.bindVertexArray(programs.emptyVao);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.bindVertexArray(null);
}
