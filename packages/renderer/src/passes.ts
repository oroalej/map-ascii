import { project } from './camera';
/**
 * The frame's passes (ARCHITECTURE.md §3): the cell pass rasterizes tiles into one pixel per
 * cell, the overlay places labels on the cell grid, the select pass picks each cell's glyph, and
 * the glyph pass draws the glyphs at full resolution. The life pass puts the life layer's agents
 * on the grid every frame.
 */
import { metersPerCssPx, type View, type Grid, type GridPlacement } from './grid';
export { placeGrid, metersPerCssPx, type View, type Grid, type GridPlacement } from './grid';
import * as twgl from 'twgl.js';
import {
  classDepths,
  classId,
  classVisibility,
  crownSurfaces,
  groundClasses,
  groundDepth,
  TIER_STEP,
} from './classes';
import { roadMask, seeThroughMask, SUB, subcellAreas } from './glyphs/select';
import type { CellSize, Programs, ThemeResources } from './gpu-context';
import {
  copyRaster,
  drawCrowns,
  drawGround,
  uploadLife,
  uploadFixtures,
  uploadSignalLights,
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
  resetOverlay,
  placeLabels,
  rotatedLabelVertices,
  type LabelCandidate,
  type Overlay,
} from './labels';
import { cellBits } from './life/config';
import {
  createUtilityPackingScratch,
  utilityViewportVisibility,
  type UtilityPackingScratch,
} from './life/utilities';
import { packLife, type LifeGrid } from './life/draw';
import type { FrameProfiler } from './profile';
import { packBeams, packCandles, packLights, type VisibleLamp } from './life/lights';
import type { VisibleAgent } from './life/simulate';
import type { Sun } from './life/sun';
import { rainGlyphIndex, type WindNow } from './life/wind';
import { buntingWindResponse } from './life/bunting-motion';
import { type TileLabel } from './raster/geometry';
import { rainGlyphs, type Theme } from './theme';
import {
  packFixtures,
  createFixturePackingScratch,
  type FixturePackingScratch,
  packSignalLights,
  updateFixtureSignals,
  updateFixtureFlags,
  type FixtureMotion,
  type PackedFixtures,
  type StreetFixture,
  type FixtureVisibility,
} from './life/fixtures';
import type { TileId } from './tiles';

const depths = classDepths();
const grounds = groundClasses.reduce((mask, cls) => mask | (1 << classId(cls)), 0);
const groundsDepth = groundDepth();
const crownClass = classId('tree_crown');
const crownSurfaceClasses = crownSurfaces();
const crownOverDepth = depths[classId('road_major')]! - TIER_STEP * 0.05;
/** The water fish swim in: rivers and ponds. */
const fishWater = [classId('water_river'), classId('water_area')];
const seeThrough = seeThroughMask();
const roads = roadMask();
const areas = subcellAreas();
const lifeCellBits = cellBits();
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

type CrownDraw = { mesh: TileMesh; matrix: number[] };
/** The crowns to draw for a tile array, and the matrix inputs they were worked out for. */
const crownsOf = new WeakMap<readonly TileDraw[], { key: number[]; drawn: CrownDraw[] }>();

/** Matrices don't change for a sub-cell shift. Tile arrays are replaced when meshes change. */
export function prepareCrowns(
  tiles: readonly TileDraw[],
  view: View,
  placement: GridPlacement,
  cols: number,
  rows: number,
) {
  const { grid } = placement;
  const key = [
    view.camera.zoom,
    view.dpr,
    grid.originCol,
    grid.originRow,
    view.cellDev.w,
    view.cellDev.h,
    cols,
    rows,
  ];
  const old = crownsOf.get(tiles);
  if (old && key.every((k, i) => k === old.key[i])) return old.drawn;
  const drawn = tiles
    .filter(({ mesh }) => mesh.crowns.count > 0)
    .map(({ tile, mesh }) => ({ mesh, matrix: placement.tileMatrix(tile) }));
  crownsOf.set(tiles, { key, drawn });
  return drawn;
}

const overlays = new WeakMap<CellTargets, { overlay: Overlay; packed: Uint8Array }>();
function overlayBuffers(targets: CellTargets) {
  let buffers = overlays.get(targets);
  if (!buffers) {
    const overlay = createOverlay(targets.labelCols, targets.labelRows);
    buffers = { overlay, packed: new Uint8Array(overlay.glyphs.length * 4) };
    overlays.set(targets, buffers);
  }
  resetOverlay(buffers.overlay);
  return buffers;
}

/**
 * Rasterize the region's own features (from their coarser tiles) and then the view's tiles into
 * the cell targets, once per cell and once at `SUB` samples per cell.
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
    // Bind separate cached textures even during the base draw: no framebuffer feedback.
    u_crownBaseClass: targets.classTex,
    u_crownBaseAttr: targets.attrTex,
  });
  const matrices = layers.tiles.map(({ tile }) => placement.tileMatrix(tile));
  const regionMatrices = layers.region.map(({ tile }) => placement.tileMatrix(tile));
  const drawFlat = () => {
    layers.region.forEach(({ mesh }, i) => {
      twgl.setUniforms(program, {
        u_matrix: regionMatrices[i]!,
        u_surfaceScale:
          mesh.region.fills.surfaceScale !== undefined
            ? [mesh.region.fills.surfaceScale, 1 / 32767]
            : [1, 1],
      });
      drawGround(gl, mesh.region);
    });
    layers.tiles.forEach(({ mesh }, i) => {
      twgl.setUniforms(program, {
        u_matrix: matrices[i]!,
        u_surfaceScale:
          mesh.fills.surfaceScale !== undefined ? [mesh.fills.surfaceScale, 1 / 32767] : [1, 1],
      });
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
  // The same ground again at SUB samples per cell, for sub-cell edges (select pass).
  const { subBase } = targets;
  begin(subBase.fbo, subBase.width, subBase.height, [SUB.cols, SUB.rows]);
  drawFlat();
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
  const program = programs.cell;
  copyRaster(gl, base.fbo, targets.cellFbo, cols, rows);
  copyRaster(gl, subBase.fbo, sub.fbo, sub.width, sub.height);
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
    u_crownSurfaces: crownSurfaceClasses,
    u_crownOverDepth: crownOverDepth,
    u_wind: wind.strength,
    u_windDir: wind.dir,
    u_grid: [cols, rows],
  });
  // Only the tiles with crowns are drawn, and their matrices are worked out once for both grids.
  const drawn = prepareCrowns(tiles, view, placement, cols, rows);
  const draw = (fbo: WebGLFramebuffer, width: number, height: number, sample: [number, number]) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, width, height);
    const underlying = fbo === targets.cellFbo ? base : subBase;
    twgl.setUniforms(program, {
      u_sub: sample,
      u_crownBaseClass: underlying.classTex,
      u_crownBaseAttr: underlying.attrTex,
    });
    for (const { mesh, matrix } of drawn) {
      twgl.setUniforms(program, { u_matrix: matrix });
      drawCrowns(gl, mesh);
    }
  };
  draw(targets.cellFbo, cols, rows, [1, 1]);
  draw(sub.fbo, sub.width, sub.height, [SUB.cols, SUB.rows]);
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
  { streetText }: Programs,
): LabelCandidate[] {
  const { camera, labelDev } = view;
  const { toCell } = placement;
  /** A street run's length in label cells across, which a rotated name must fit. */
  const runCells = ([from, to]: NonNullable<TileLabel['run']>) => {
    const a = toCell(...from),
      b = toCell(...to);
    return Math.hypot((b[0] - a[0]) * labelDev.w, (b[1] - a[1]) * labelDev.h) / labelDev.w;
  };
  const { overlay, packed } = overlayBuffers(targets);
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
    candidates.push({
      id: label.id,
      text: label.text,
      rank: label.rank,
      vis,
      col: Math.floor(col),
      row: Math.floor(row),
      // Street names follow the street.
      mode: label.angle !== undefined ? 'rotated' : 'beside',
      angle: label.angle,
      runCells: label.run && runCells(label.run),
    });
  }
  const placed = placeLabels(overlay, candidates, glyphIndex, area, labelDev.h / labelDev.w);
  uploadOverlay(gl, targets, packOverlay(overlay, packed));
  // Most views have no rotated names, before or after: nothing to upload.
  if (overlay.rotated.length > 0 || streetText.count > 0) {
    const vertices = rotatedLabelVertices(overlay.rotated, labelDev.w, labelDev.h);
    streetText.count = vertices.length / 5;
    gl.bindBuffer(gl.ARRAY_BUFFER, streetText.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW);
  }
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
  shadows = true,
  awnings = true,
) {
  const { tables } = themeRes.map;
  gl.bindFramebuffer(gl.FRAMEBUFFER, targets.glyphFbo);
  gl.viewport(0, 0, targets.cols, targets.rows);
  gl.useProgram(programs.select.program);
  twgl.setUniforms(programs.select, {
    u_class: targets.classTex,
    u_baseClass: targets.base.classTex,
    u_baseAttr: targets.base.attrTex,
    u_baseId: targets.base.idTex,
    u_shadows: shadows,
    u_awnings: awnings,
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
    u_cellAspect: view.cellDev.h / view.cellDev.w,
    u_hover: highlights.hover,
    u_selected: highlights.selected,
    u_highlight: highlights.highlight,
    u_highlightCount: highlights.highlightCount,
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
  const { cellDev, dpr } = view;
  const metersPerPx = metersPerCssPx(view.camera);
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
  profiler?: FrameProfiler,
  allowsGroundCell?: LifeGrid['allowsGroundCell'],
): number {
  const { cols, rows } = targets;
  const lifeTexels = texels(targets).life;
  const packStart = profiler?.time();
  const drawn = packLife(
    lifeTexels,
    {
      cols,
      rows,
      cellWidth: view.cellDev.w,
      cellHeight: view.cellDev.h,
      toCell: placement.toCell,
      allowsGroundCell,
    },
    agents,
    theme,
    (glyph) => themeRes.map.atlas.index(glyph),
    // Birds' shadows (like the map's, glyphs/select.ts inShadow).
    sun,
    themeRes.map.lifeGlyphs,
  );
  if (packStart !== undefined) profiler!.add('pack', profiler!.time() - packStart);
  const uploadStart = profiler?.time();
  uploadLife(gl, targets, lifeTexels);
  if (uploadStart !== undefined) profiler!.add('upload', profiler!.time() - uploadStart);
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
export type Weather = { rain: number; wind: WindNow | null; fish?: boolean; detail?: boolean };

const fixturesOf = new WeakMap<
  CellTargets,
  {
    packed: PackedFixtures;
    fixtures: readonly StreetFixture[];
    atlas: ThemeResources['map']['atlas'];
    zoom: number;
    dpr: number;
    cellWidth: number;
    cellHeight: number;
    lightTexels: Uint8Array;
    lightScores: Float32Array;
    utilityScratch: UtilityPackingScratch;
    fixtureScratch: FixturePackingScratch;
    viewport: ReturnType<typeof screenArea>;
  }
>();

/** Reproject hardware only when geometry/grid changes; upload phase changes independently. */
export function fixturePass(
  gl: GL,
  targets: CellTargets,
  resources: ThemeResources,
  view: View,
  placement: GridPlacement,
  fixtures: readonly StreetFixture[],
  clock: number,
  repack: boolean,
  motion: FixtureMotion = { time: 0, strength: 0 },
): FixtureVisibility {
  let cache = fixturesOf.get(targets);
  let changed = false;
  const viewport = screenArea(view, placement.grid, view.cellDev);
  if (
    repack ||
    !cache ||
    cache.packed.cloth.cols !== targets.cols ||
    cache.packed.cloth.rows !== targets.rows ||
    cache.fixtures !== fixtures ||
    cache.atlas !== resources.map.atlas ||
    cache.zoom !== view.camera.zoom ||
    cache.dpr !== view.dpr ||
    cache.cellWidth !== view.cellDev.w ||
    cache.cellHeight !== view.cellDev.h
  ) {
    const area = viewport;
    const utilityScratch = cache?.utilityScratch ?? createUtilityPackingScratch();
    const fixtureScratch = cache?.fixtureScratch ?? createFixturePackingScratch();
    const packed = packFixtures(
      cache?.packed.texels.length === targets.cols * targets.rows * 4
        ? cache.packed.texels
        : new Uint8Array(targets.cols * targets.rows * 4),
      {
        cols: targets.cols,
        rows: targets.rows,
        cellWidth: view.cellDev.w,
        cellHeight: view.cellDev.h,
        toCell: placement.toCell,
        buntingProjection: {
          scale: `${view.camera.zoom}/${view.dpr}/${view.cellDev.w}/${view.cellDev.h}`,
          toCell: (lng, lat) => {
            const [x, y] = project(lng, lat, view.camera.zoom);
            return [(x * view.dpr) / view.cellDev.w, (y * view.dpr) / view.cellDev.h];
          },
        },
        visible: (c, r) => c >= area.left && c <= area.right && r >= area.top && r <= area.bottom,
      },
      fixtures,
      view.camera.zoom,
      (glyph) => resources.map.atlas.index(glyph),
      clock,
      motion,
      utilityScratch,
      fixtureScratch,
    );
    cache = {
      packed,
      fixtures,
      atlas: resources.map.atlas,
      zoom: view.camera.zoom,
      dpr: view.dpr,
      cellWidth: view.cellDev.w,
      cellHeight: view.cellDev.h,
      lightTexels:
        cache?.lightTexels.length === targets.cols * targets.rows * 4
          ? cache.lightTexels
          : new Uint8Array(targets.cols * targets.rows * 4),
      lightScores:
        cache?.lightScores.length === targets.cols * targets.rows
          ? cache.lightScores
          : new Float32Array(targets.cols * targets.rows),
      utilityScratch,
      fixtureScratch,
      viewport,
    };
    fixturesOf.set(targets, cache);
    changed = true;
  } else {
    changed = updateFixtureSignals(cache.packed, clock);
  }
  const flagsChanged = updateFixtureFlags(cache.packed, motion);
  if (changed || flagsChanged) {
    uploadFixtures(gl, targets, cache.packed.texels);
  }
  if (changed) {
    packSignalLights(
      cache.lightTexels,
      cache.packed,
      {
        cols: targets.cols,
        rows: targets.rows,
        cellWidth: view.cellDev.w,
        cellHeight: view.cellDev.h,
        dpr: view.dpr,
      },
      cache.lightScores,
    );
    uploadSignalLights(gl, targets, cache.lightTexels);
  }
  if (
    viewport.left !== cache.viewport.left ||
    viewport.right !== cache.viewport.right ||
    viewport.top !== cache.viewport.top ||
    viewport.bottom !== cache.viewport.bottom
  ) {
    cache.packed.visibility.utilities = utilityViewportVisibility(
      cache.packed.utilityCells,
      targets.cols,
      (c, r) =>
        c >= viewport.left && c <= viewport.right && r >= viewport.top && r <= viewport.bottom,
    );
    cache.viewport = viewport;
  }
  return cache.packed.visibility;
}

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
  sun: Sun | null = null,
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
    u_fillColors: tables.fillColors,
    u_fills: tables.fills,
    u_background: theme.background.slice(0, 3),
    u_time: time,
    u_pulse: reducedMotion ? -1 : classId('marker_landmark'),
    u_overlay: targets.overlayTex,
    u_labelColor: themeRes.uniforms.label,
    u_accent: themeRes.uniforms.accent,
    u_shimmer: !reducedMotion,
    u_buntingWind: buntingWindResponse(weather.wind?.strength ?? 0, reducedMotion),
    u_buntingWindDir: weather.wind?.dir ?? [0, 0],
    u_waterDetail: !!weather.detail && !reducedMotion,
    u_fish: !!weather.fish && !reducedMotion,
    u_fishWater: fishWater,
    u_waterGlyphs: themeRes.map.waterGlyphs,
    u_life: targets.lifeTex,
    u_subClass: targets.sub.classTex,
    u_subAttr: targets.sub.attrTex,
    u_cellBits: lifeCellBits,
    u_origin: [grid.originCol, grid.originRow],
    u_attr: targets.attrTex,
    u_daylight: daylight,
    u_light: targets.lightTex,
    u_fixtures: targets.fixtureTex,
    u_fixturePaints: themeRes.uniforms.fixtures,
    u_signalGlow: (fixturesOf.get(targets)?.packed.signals.length ?? 0) > 0,
    u_signalLight: targets.signalLightTex,
    u_dpr: view.dpr,
    u_lampShow: lampShow,
    u_moon: moon,
    u_crownClass: classId('tree_crown'),
    u_crownSun:
      sun && sun.altitude > 0 ? sunUniforms(view, sun).u_sun : [-Math.SQRT1_2, -Math.SQRT1_2, 0.7],
    u_vehicle: classId('life_vehicle'),
    u_vehicleOccluders: [classId('tree'), classId('tree_crown'), classId('trees')],
    u_boat: classId('life_boat'),
    u_train: classId('life_train'),
    u_person: classId('life_person'),
    u_bird: classId('life_bird'),
    u_paints: themeRes.uniforms.paints,
    u_awningPaints: themeRes.uniforms.awnings,
    u_birdPaints: themeRes.uniforms.birds,
    u_rain: weather.rain,
    u_rainSlant: weather.wind?.dir[0] ?? 0,
    u_rainGlyph: atlas.index(rainGlyphs[weather.wind ? rainGlyphIndex(weather.wind.dir) : 0]!),
    // The label color, a little blue: pale drops on the dark theme, dark ones on the light.
    u_rainColor: themeRes.uniforms.rain,
  });
  gl.bindVertexArray(programs.emptyVao);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.bindVertexArray(null);
}

/** Whole street words rotate in pixels, over the map and its unrotated labels. */
export function streetTextPass(
  gl: GL,
  programs: Programs,
  themeRes: ThemeResources,
  theme: Theme,
  view: View,
  grid: Grid,
) {
  const { streetText } = programs;
  if (!streetText.count) return;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, view.width, view.height);
  gl.useProgram(programs.labels.program);
  twgl.setUniforms(programs.labels, {
    u_size: [view.width, view.height],
    u_shift: [grid.shiftX, grid.shiftY],
    u_cell: [themeRes.label.cellDev.w, themeRes.label.cellDev.h],
    u_columns: themeRes.label.atlas.columns,
    u_atlas: themeRes.label.atlasTex,
    u_color: themeRes.uniforms.label,
    u_background: theme.background.slice(0, 3),
  });
  gl.bindVertexArray(streetText.vao);
  gl.drawArrays(gl.TRIANGLES, 0, streetText.count);
  gl.bindVertexArray(null);
}
