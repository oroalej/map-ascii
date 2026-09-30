/**
 * The frame's passes (ARCHITECTURE.md §3): the cell pass rasterizes tiles into one pixel per
 * cell, the overlay places labels on the cell grid, the select pass picks each cell's glyph, and
 * the glyph pass draws the glyphs at full resolution. The life pass puts the life layer's agents
 * on the grid every frame.
 */
import type { CameraState } from '@atlas/shared';
import * as twgl from 'twgl.js';
import { isTilted, multiply, project, TILE_SIZE, viewportFor } from './camera';
import { classDepths, classId, classVisibility, groundClasses, groundDepth } from './classes';
import { roadMask, seeThroughMask, SUB, subcellAreas } from './glyphs/select';
import type { CellSize, Programs, ThemeResources } from './gpu-context';
import {
  copyRaster,
  drawCrowns,
  drawExtrusions,
  drawGround,
  uploadLife,
  uploadLights,
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
import { cellBits, WINDOW } from './life/config';
import { packLife } from './life/draw';
import { packBeams, packCandles, packLights, type VisibleLamp } from './life/lights';
import type { VisibleAgent } from './life/simulate';
import type { Sun } from './life/sun';
import { rainGlyphIndex, type WindNow } from './life/wind';
import { EXTENT, type TileLabel } from './raster/geometry';
import { rainGlyphs, streetlightGlyph, type Theme } from './theme';
import type { TileId } from './tiles';

const depths = classDepths();
const grounds = groundClasses.reduce((mask, cls) => mask | (1 << classId(cls)), 0);
const groundsDepth = groundDepth();
const crownClass = classId('tree_crown');
const seeThrough = seeThroughMask();
const roads = roadMask();
const areas = subcellAreas();
const lifeCellBits = cellBits();
/** The world's width in mercator meters. */
const MERCATOR_METERS = 40_075_016.686;

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
  /** Map cell size (density.ts: it shrinks as the camera zooms in). */
  cellDev: CellSize;
  /** Label cell size, fixed. */
  labelDev: CellSize;
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

export function placeGrid(
  view: View,
  cellDev: CellSize,
  cols: number,
  rows: number,
): GridPlacement {
  const { camera, dpr, width: w, height: h } = view;
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
export function screenArea(view: View, grid: Grid, cellDev: CellSize = view.cellDev) {
  return {
    left: Math.ceil(grid.shiftX / cellDev.w),
    top: Math.ceil(grid.shiftY / cellDev.h),
    right: Math.floor((grid.shiftX + view.width) / cellDev.w),
    bottom: Math.floor((grid.shiftY + view.height) / cellDev.h),
  };
}

/** A tile to draw and its mesh. */
export type TileDraw = { tile: TileId; mesh: TileMesh };

/** Window bays repeat after this many, so the tile offsets stay exact in float32. */
export const FACADE_PERIOD = 4096;

/**
 * Tile units → window bays (life/config.ts `WINDOW`) for the cell pass's `u_facade`: the tile's
 * origin in bays (modulo `FACADE_PERIOD`, taken here in doubles) and bays per tile unit. Bays
 * are in mercator meters, so they line up across tiles of every zoom and never move.
 */
export function facadeFrame({ z, x, y }: TileId): [number, number, number] {
  const scale = MERCATOR_METERS / 2 ** z / EXTENT / WINDOW.bay;
  const wrap = (n: number) =>
    (((n * EXTENT * scale) % FACADE_PERIOD) + FACADE_PERIOD) % FACADE_PERIOD;
  return [wrap(x), wrap(y), scale];
}

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
  const tilted = isTilted(camera);
  const program = programs.cell;
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LESS);
  gl.useProgram(program.program);
  twgl.setUniforms(program, {
    u_depth: depths,
    u_groundMask: grounds,
    u_groundDepth: groundsDepth,
    u_vis: classVisibility(camera.zoom),
    u_zoom: view.detailZoom,
    u_roadMask: roads,
    u_origin: [placement.grid.originCol, placement.grid.originRow],
    u_crownClass: crownClass,
    u_wind: 0,
  });
  const matrices = layers.tiles.map(({ tile }) => placement.tileMatrix(tile));
  const regionMatrices = layers.region.map(({ tile }) => placement.tileMatrix(tile));
  const drawFlat = () => {
    layers.region.forEach(({ mesh }, i) => {
      twgl.setUniforms(program, { u_matrix: regionMatrices[i]! });
      drawGround(gl, mesh.region);
    });
    layers.tiles.forEach(({ mesh }, i) => {
      twgl.setUniforms(program, { u_matrix: matrices[i]! });
      drawGround(gl, mesh);
    });
  };
  const begin = (fbo: WebGLFramebuffer, width: number, height: number, sub: [number, number]) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, width, height);
    for (let i = 0; i < 3; i++) gl.clearBufferfv(gl.COLOR, i, [0, 0, 0, 0]);
    gl.clearBufferfi(gl.DEPTH_STENCIL, 0, 1, 0);
    twgl.setUniforms(program, { u_sub: sub });
  };

  // Everything but the tree crowns, which the crown pass adds (and moves) over this base.
  begin(targets.base.fbo, cols, rows, [1, 1]);
  drawFlat();
  if (tilted) {
    layers.tiles.forEach(({ tile, mesh }, i) => {
      twgl.setUniforms(program, { u_matrix: matrices[i]!, u_facade: facadeFrame(tile) });
      drawExtrusions(gl, mesh);
    });
  } else {
    // The same ground again at SUB samples per cell, for sub-cell edges (select pass).
    const { subBase } = targets;
    begin(subBase.fbo, subBase.width, subBase.height, [SUB.cols, SUB.rows]);
    drawFlat();
  }
  gl.bindVertexArray(null);
  gl.disable(gl.DEPTH_TEST);
}

/**
 * Draw the tree crowns over the cell pass (kept in `targets.base` and `subBase`, without them):
 * copy the base into the live targets and draw each tile's crowns on top, swaying in the wind
 * at `time` in the `wind` (the cell shader; its strength is 0 with reduced motion). It runs after every cell pass
 * and, while the wind blows through crowns on screen, every animated frame; where a crown has
 * swung away, the base shows what is under it.
 */
export function crownPass(
  gl: GL,
  programs: Programs,
  targets: CellTargets,
  view: View,
  placement: GridPlacement,
  tiles: readonly TileDraw[],
  time: number,
  wind: WindNow,
) {
  const { cols, rows, base, subBase, sub } = targets;
  const tilted = isTilted(view.camera);
  const program = programs.cell;
  copyRaster(gl, base.fbo, targets.cellFbo, cols, rows);
  if (!tilted) copyRaster(gl, subBase.fbo, sub.fbo, sub.width, sub.height);
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LESS);
  gl.useProgram(program.program);
  twgl.setUniforms(program, {
    u_depth: depths,
    u_groundMask: grounds,
    u_groundDepth: groundsDepth,
    u_vis: classVisibility(view.camera.zoom),
    u_zoom: view.detailZoom,
    u_roadMask: roads,
    u_origin: [placement.grid.originCol, placement.grid.originRow],
    u_crownClass: crownClass,
    u_time: time,
    u_wind: wind.strength,
    u_windDir: wind.dir,
    u_grid: [cols, rows],
  });
  // Only the tiles with crowns are drawn, and their matrices are worked out once for both grids.
  const drawn = tiles
    .filter(({ mesh }) => (tilted ? mesh.standingCrowns : mesh.crowns).count > 0)
    .map(({ tile, mesh }) => ({ mesh, matrix: placement.tileMatrix(tile) }));
  const draw = (fbo: WebGLFramebuffer, width: number, height: number, sample: [number, number]) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, width, height);
    twgl.setUniforms(program, { u_sub: sample });
    for (const { mesh, matrix } of drawn) {
      twgl.setUniforms(program, { u_matrix: matrix });
      drawCrowns(gl, mesh, tilted);
    }
  };
  draw(targets.cellFbo, cols, rows, [1, 1]);
  if (!tilted) draw(sub.fbo, sub.width, sub.height, [SUB.cols, SUB.rows]);
  gl.bindVertexArray(null);
  gl.disable(gl.DEPTH_TEST);
}

/** Whether any of `tiles` has tree crowns to sway. */
export const hasCrowns = (tiles: readonly TileDraw[]): boolean =>
  tiles.some(({ mesh }) => mesh.crowns.count > 0);

/**
 * Place the names whose zoom band reaches the camera zoom (labels.ts) on the label grid
 * (`placement`) and upload them to the overlay texture. Returns the labels placed.
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
  const overlay = createOverlay(targets.labelCols, targets.labelRows);
  const tilted = isTilted(camera);
  const area = screenArea(view, placement.grid, view.labelDev);
  const glyphs = themeRes.label.atlas;
  const glyphIndex = (char: string) => {
    const index = glyphs.index(char);
    return index === 0 ? undefined : index;
  };

  const candidates: LabelCandidate[] = [];
  for (const label of labels) {
    const vis = labelVisibility(label.band, camera.zoom);
    if (vis <= 0) continue;
    const [col, row] = toCell(label.lng, label.lat);
    // No box of a label's (none wider or taller than its text, a few cells from its anchor)
    // reaches the area from further out.
    const reach = label.text.length + 3;
    if (
      col < area.left - reach ||
      col >= area.right + reach ||
      row < area.top - reach ||
      row >= area.bottom + reach
    ) {
      continue;
    }
    if (tilted && !tiltedLabelShows(label.rank, row, targets.labelRows, camera.pitch)) continue;
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

/**
 * Pick each cell's glyph from its class and neighbors. `wind` blows over the grass, trees, and
 * water (its strength is 0 with reduced motion).
 */
export function selectPass(
  gl: GL,
  programs: Programs,
  targets: CellTargets,
  themeRes: ThemeResources,
  view: View,
  grid: Grid,
  time: number,
  highlights: Highlights,
  wind: WindNow,
  sun: Sun | null = null,
) {
  const { tables } = themeRes.map;
  gl.bindFramebuffer(gl.FRAMEBUFFER, targets.glyphFbo);
  gl.viewport(0, 0, targets.cols, targets.rows);
  gl.useProgram(programs.select.program);
  twgl.setUniforms(programs.select, {
    u_class: targets.classTex,
    u_attr: targets.attrTex,
    u_id: targets.idTex,
    u_table: themeRes.map.tableTex,
    u_kind: tables.kinds,
    u_count: tables.counts,
    u_connect: tables.connects,
    u_origin: [grid.originCol, grid.originRow],
    u_time: time,
    u_wind: wind.strength,
    u_windDir: wind.dir,
    u_zoom: view.detailZoom,
    u_seeThrough: seeThrough,
    u_roadMask: roads,
    u_tilted: isTilted(view.camera),
    u_cellAspect: view.cellDev.h / view.cellDev.w,
    u_hover: highlights.hover,
    u_selected: highlights.selected,
    u_highlight: highlights.highlight,
    u_highlightCount: highlights.highlightCount,
    u_subcell: !isTilted(view.camera),
    u_subClass: targets.sub.classTex,
    u_subAttr: targets.sub.attrTex,
    u_subId: targets.sub.idTex,
    u_area: areas,
    ...sunUniforms(view, sun),
  });
  gl.bindVertexArray(programs.emptyVao);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

/**
 * The select pass's sun (glyphs/select.ts inShadow): the way toward it in world cells' axes
 * (x east, y south) and the tangent of its altitude (0: no sun), and a cell's size in meters at
 * the view's center.
 */
function sunUniforms(view: View, sun: Sun | null) {
  const { camera, cellDev, dpr } = view;
  const metersPerPx =
    (MERCATOR_METERS * Math.cos((camera.lat * Math.PI) / 180)) / (TILE_SIZE * 2 ** camera.zoom);
  const az = ((sun?.azimuth ?? 0) * Math.PI) / 180;
  const tan = sun ? Math.tan((Math.max(sun.altitude, 1) * Math.PI) / 180) : 0;
  return {
    u_sun: [Math.sin(az), -Math.cos(az), tan],
    u_cellMeters: [(cellDev.w / dpr) * metersPerPx, (cellDev.h / dpr) * metersPerPx],
  };
}

/**
 * Each grid's texel buffers, reused between frames: the agents; the lights; and the streetlights
 * alone, kept while the grid stands still (beams go over a copy each frame). Kept per targets,
 * so they are the grid's size and never shared between two maps.
 */
type Texels = { life: Uint8Array; light: Uint8Array; lamps: Uint8Array | null };
const texelsOf = new WeakMap<CellTargets, Texels>();
const texels = (targets: CellTargets): Texels => {
  let found = texelsOf.get(targets);
  if (!found) {
    const size = targets.cols * targets.rows * 4;
    found = { life: new Uint8Array(size), light: new Uint8Array(size), lamps: null };
    texelsOf.set(targets, found);
  }
  return found;
};

/**
 * Put the agents on the cell grid (life/draw.ts), with the flying birds' shadows while the `sun`
 * is up, and upload them to the life texture. Returns how many landed on the grid.
 */
export function lifePass(
  gl: GL,
  targets: CellTargets,
  themeRes: ThemeResources,
  theme: Theme,
  view: View,
  placement: GridPlacement,
  agents: readonly VisibleAgent[],
  sun?: Sun | null,
): number {
  const { cols, rows } = targets;
  const lifeTexels = texels(targets).life;
  const drawn = packLife(
    lifeTexels,
    { cols, rows, cellWidth: view.cellDev.w, cellHeight: view.cellDev.h, toCell: placement.toCell },
    agents,
    theme,
    (glyph) => themeRes.map.atlas.index(glyph),
    // Birds' shadows, flat views only (like the map's, glyphs/select.ts inShadow).
    isTilted(view.camera) ? null : sun,
  );
  uploadLife(gl, targets, lifeTexels);
  return drawn;
}

/**
 * Put the streetlights and floodlights, the moving vehicles' headlight beams, and the candles
 * people carry on the cell grid (life/lights.ts) and upload them to the light texture. The lamps
 * are packed again only with `repack` (the grid moved, or they came on or went) or when the
 * grid's size changed.
 */
export function lightPass(
  gl: GL,
  targets: CellTargets,
  view: View,
  placement: GridPlacement,
  lamps: readonly VisibleLamp[],
  agents: readonly VisibleAgent[],
  repack: boolean,
) {
  const { cols, rows } = targets;
  const grid = { cols, rows, toCell: placement.toCell };
  const buffers = texels(targets);
  const lightTexels = buffers.light;
  if (!buffers.lamps) {
    buffers.lamps = new Uint8Array(cols * rows * 4);
    repack = true;
  }
  const lampTexels = buffers.lamps;
  if (repack) packLights(lampTexels, grid, lamps);
  lightTexels.set(lampTexels);
  packBeams(lightTexels, grid, agents);
  // A cell's size in meters at the view's center sizes the candles.
  const [cellMeters] = sunUniforms(view, null).u_cellMeters;
  packCandles(lightTexels, grid, agents, 1 / cellMeters!);
  uploadLights(gl, targets, lightTexels);
}

/** The weather over the map: how hard it rains (0–1), in which wind. */
export type Weather = { rain: number; wind: WindNow | null };

/**
 * Draw the glyphs at full resolution: the map, the life layer's agents over it, and the
 * overlay's labels on top, all lit for the time of day (`daylight`, 0 night – 1 day).
 * `lampShow` is how far the streetlights (`lightPass`) have faded in at this zoom, 0–1.
 */
export function glyphPass(
  gl: GL,
  programs: Programs,
  targets: CellTargets,
  themeRes: ThemeResources,
  theme: Theme,
  view: View,
  grid: Grid,
  labelGrid: Grid,
  time: number,
  reducedMotion: boolean,
  daylight: number,
  weather: Weather = { rain: 0, wind: null },
  lampShow = 0,
  moon = 0,
) {
  const { atlas, tables } = themeRes.map;
  const label = themeRes.label;
  const { cellDev } = view;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, view.width, view.height);
  gl.useProgram(programs.glyph.program);
  twgl.setUniforms(programs.glyph, {
    u_glyphs: targets.glyphTex,
    u_atlas: themeRes.map.atlasTex,
    u_cell: [cellDev.w, cellDev.h],
    u_shift: [grid.shiftX, grid.shiftY],
    u_height: view.height,
    u_columns: atlas.columns,
    u_labelAtlas: label.atlasTex,
    u_labelCell: [label.cellDev.w, label.cellDev.h],
    u_labelShift: [labelGrid.shiftX, labelGrid.shiftY],
    u_labelColumns: label.atlas.columns,
    u_colors: tables.colors,
    u_fills: tables.fills,
    u_background: theme.background.slice(0, 3),
    u_time: time,
    u_pulse: reducedMotion ? -1 : classId('marker_landmark'),
    u_overlay: targets.overlayTex,
    u_labelColor: rgb(theme.label),
    u_accent: rgb(theme.accent),
    u_shimmer: !reducedMotion,
    u_life: targets.lifeTex,
    u_cellBits: lifeCellBits,
    u_origin: [grid.originCol, grid.originRow],
    u_attr: targets.attrTex,
    u_tilted: isTilted(view.camera),
    u_daylight: daylight,
    u_light: targets.lightTex,
    u_lampShow: lampShow,
    u_moon: moon,
    u_lampGlyph: atlas.index(streetlightGlyph),
    u_vehicle: classId('life_vehicle'),
    u_boat: classId('life_boat'),
    u_train: classId('life_train'),
    u_person: classId('life_person'),
    u_bird: classId('life_bird'),
    u_paints: theme.vehiclePaints.flatMap((paint) => rgb(paint)),
    u_birdPaints: theme.birdPaints.flatMap((pair) => pair.flatMap((paint) => rgb(paint))),
    u_rain: weather.rain,
    u_rainSlant: weather.wind?.dir[0] ?? 0,
    u_rainGlyph: atlas.index(rainGlyphs[weather.wind ? rainGlyphIndex(weather.wind.dir) : 0]!),
    // The label color, a little blue: pale drops on the dark theme, dark ones on the light.
    u_rainColor: rgb(theme.label).map((c, i) => c * [0.82, 0.9, 1][i]!),
  });
  gl.bindVertexArray(programs.emptyVao);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.bindVertexArray(null);
}
