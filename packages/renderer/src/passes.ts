import { throng, type ThrongFieldPool, type ThrongGuardFactory } from './life/throng';
import type { ProcessionRoute } from '@atlas/shared';
import { project } from './camera';
import { EMPTY_FOLKLORE, type FolklorePacket } from './life/folklore';
import type { cropTint } from './glyphs/select';

export type CropPass = { stage: number; progress: number } & ReturnType<typeof cropTint>;
/** Always write every crop uniform, including identity pigments after calendar removal. */
const cropUniforms = (crop: CropPass | null) => ({
  u_cropStage: crop?.stage ?? -1,
  u_cropProgress: crop?.progress ?? 0,
  u_cropTint: crop?.tint ?? [1, 1, 1],
  u_cropWaterTint: crop?.waterTint ?? [1, 1, 1],
  u_farmlandClass: classId('farmland'),
});
import { hauntUniforms, createHauntUniformScratch } from './folklore-pass';
/**
 * The frame's passes (ARCHITECTURE.md §3): the cell pass rasterizes tiles into one pixel per
 * cell, the overlay places labels on the cell grid, the select pass picks each cell's glyph, and
 * the glyph pass draws the glyphs at full resolution. The life pass puts the life layer's agents
 * on the grid every frame.
 */
import { screenArea, metersPerCssPx, type View, type Grid, type GridPlacement } from './grid';
import { normalizeFocus, type LifeFocus } from './focus';
import type { GridPlacement as PickingGrid } from './picking';
export { placeGrid, metersPerCssPx, type View, type Grid, type GridPlacement } from './grid';
import * as twgl from 'twgl.js';
import { bandVisibility, CLASS_ZOOM, SEASON_ZOOM, ZOOM_FADE } from '@atlas/shared';
import {
  classDepths,
  classId,
  classVisibility,
  crownSurfaces,
  groundFlags,
  groundDepth,
  TIER_STEP,
} from './classes';
import { roadMask, seeThroughMask, SUB, subcellAreas } from './glyphs/select';
import type { Programs, ThemeResources } from './gpu-context';
import { glyphProgram } from './gpu-context';
import {
  copyRaster,
  drawCrowns,
  drawGround,
  uploadLife,
  uploadCrowdMask,
  uploadEffectClocks,
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
  packOverlay,
  resetOverlay,
  placeLabels,
  rotatedLabelVertices,
  overlayCoversPoint,
  type LabelCandidate,
  type Overlay,
} from './labels';
import { labelScreenArea } from './label-candidates';
import { labelIntersectsArea, type Box, type LabelLayout } from './label-layout';
import type { LabelMemory, LabelMemoryEntry, LabelOrderKey } from './label-stability';
import { cellBits } from './life/config';
import { LIFE_OCCLUDERS } from './life/surface-visibility';
import {
  createUtilityPackingScratch,
  utilityViewportVisibility,
  type UtilityPackingScratch,
} from './life/utilities';
import { packLife, type LifeGrid } from './life/draw';
import { EffectClocks, ORDINARY_CLOCK, heldClock } from './life/effect-clocks';
import type { FrameProfiler } from './profile';
import {
  packBeams,
  packBrakeGlow,
  packCandles,
  packLights,
  createConePackingScratch,
  type ConePackingScratch,
  type VisibleLamp,
} from './life/lights';
import type { VisibleAgent } from './life/simulate';
import type { Sun } from './life/sun';
import { rainGlyphIndex, type WindNow } from './life/wind';
import { buntingWindResponse } from './life/bunting-motion';
import { rainGlyphs, type Theme } from './theme';
import {
  packFixtures,
  createFixturePackingScratch,
  type FixturePackingScratch,
  packSignalLights,
  updateFixtureSignals,
  FixtureSignalChange,
  updateFixtureFlags,
  type FixtureMotion,
  type PackedFixtures,
  type StreetFixture,
  updatePedestrianVisibility,
  type FixtureVisibility,
} from './life/fixtures';
import type { TileId } from './tiles';

const depths = classDepths();
const grounds = groundFlags();
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

const overlays = new WeakMap<
  CellTargets,
  {
    overlay: Overlay;
    packed: Uint8Array;
    memory: LabelMemory;
    rendered: Map<number, LabelLayout>;
    next: Map<number, LabelLayout>;
    changed: boolean;
    order: LabelOrderKey[];
  }
>();
function overlayBuffers(targets: CellTargets) {
  let buffers = overlays.get(targets);
  if (!buffers) {
    const overlay = createOverlay(targets.labelCols, targets.labelRows);
    buffers = {
      overlay,
      packed: new Uint8Array(overlay.glyphs.length * 4),
      memory: new Map(),
      rendered: new Map(),
      next: new Map(),
      changed: true,
      order: [],
    };
    overlays.set(targets, buffers);
  }
  resetOverlay(buffers.overlay);
  return buffers;
}

/** Read the previous acceptance without resetting its glyphs, collision boxes or slots. */
export const labelMemory = (
  targets: CellTargets,
): ReadonlyMap<number, LabelMemoryEntry> | undefined => overlays.get(targets)?.memory;

export const forgetLabelPlacement = (targets: CellTargets): void => {
  overlays.delete(targets);
};

/** Move durable acceptance only; replacement textures need fresh layout/upload state. */
export function transferLabelPlacement(from: CellTargets, to: CellTargets): void {
  const memory = labelMemory(from);
  if (memory) {
    const replacement = overlayBuffers(to).memory;
    for (const [id, entry] of memory) replacement.set(id, { ...entry });
  }
  forgetLabelPlacement(from);
}

/** Whether the latest overlay pass uploaded label geometry. */
export const labelOverlayChanged = (targets: CellTargets): boolean =>
  overlays.get(targets)?.changed ?? false;

const sameBox = (a: Box, b: Box) =>
  a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;

function sameLayout(a: LabelLayout, b: LabelLayout): boolean {
  return (
    a.slot === b.slot &&
    a.label.text === b.label.text &&
    a.label.col === b.label.col &&
    a.label.row === b.label.row &&
    a.label.vis === b.label.vis &&
    (a.slot !== -1 || (b.slot === -1 && a.angle === b.angle)) &&
    sameBox(a.box, b.box) &&
    sameBox(a.collision, b.collision) &&
    sameBox(a.textBounds, b.textBounds)
  );
}

/** Retained placements outside the viewport stay in memory but not the accessible list. */
export function labelsInView(
  targets: CellTargets,
  view: View,
  grid: Grid,
  placed: readonly LabelCandidate[],
  out: LabelCandidate[] = [],
): LabelCandidate[] {
  out.length = 0;
  const bounds = overlays.get(targets)?.overlay.placements;
  const area = labelScreenArea(view, grid);
  for (const label of placed) {
    const box = bounds?.get(label.id);
    if (box !== undefined && labelIntersectsArea(box, area)) out.push(label);
  }
  return out;
}

export function labelsCoverPoint(
  targets: CellTargets,
  point: readonly [number, number],
  dpr: number,
  grid: PickingGrid,
): boolean {
  const overlay = overlays.get(targets)?.overlay;
  return (
    !!overlay &&
    overlayCoversPoint(
      overlay,
      point[0] * dpr + grid.shiftX,
      point[1] * dpr + grid.shiftY,
      grid.cellWidth,
      grid.cellHeight,
    )
  );
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
    u_ground: grounds,
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
    u_ground: grounds,
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
 * Focus-only passes skip uploads when rendered IDs, slots and text geometry stay the same.
 */
export function overlayPass(
  gl: GL,
  targets: CellTargets,
  themeRes: ThemeResources,
  view: View,
  placement: GridPlacement,
  candidates: readonly LabelCandidate[],
  { streetText }: Programs,
  focus: readonly number[] = [],
  commitMemory = true,
): LabelCandidate[] {
  const { labelDev } = view;
  const buffers = overlayBuffers(targets);
  const { overlay, packed, memory, rendered, next } = buffers;
  const area = screenArea(view, placement.grid, view.labelDev);
  const glyphs = themeRes.label.atlas;
  const glyphIndex = (char: string) => {
    const index = glyphs.index(char);
    return index === 0 ? undefined : index;
  };

  const placed = placeLabels(
    overlay,
    candidates,
    glyphIndex,
    area,
    labelDev.h / labelDev.w,
    {
      memory,
      focus,
      commitMemory,
      screen: labelScreenArea(view, placement.grid),
      order: buffers.order,
    },
    next,
  );
  // Focus priority may change the iteration order while every rendered label stays put.
  // Keep this snapshot separate from durable memory, which focus never commits.
  buffers.changed = commitMemory || next.size !== rendered.size;
  if (!buffers.changed) {
    for (const [id, layout] of next) {
      const previous = rendered.get(id);
      if (!previous || !sameLayout(layout, previous)) {
        buffers.changed = true;
        break;
      }
    }
  }
  if (!buffers.changed) return placed;
  buffers.rendered = next;
  buffers.next = rendered;
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
  crop: CropPass | null = null,
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
    ...cropUniforms(crop),
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
    u_pavingVisible: bandVisibility(CLASS_ZOOM.paving, view.camera.zoom) > 0,
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
type Texels = {
  clocks?: EffectClocks;
  clockCells?: number[];
  clockUpload?: number;
  clockCandidates?: boolean;
  candles?: boolean;
  held?: { frame: object; inputs: readonly unknown[]; drawn: number };
  life: Uint8Array;
  crowdMask?: Uint32Array;
  crowdCells?: number[];
  crowdPending?: boolean;
  owners: Uint32Array;
  revision: number;
  light: Uint8Array;
  lamps: Uint8Array | null;
  stampedVehicles: Uint8Array;
  stampedAgents?: readonly VisibleAgent[];
  beamCones: ConePackingScratch;
  brakeCones: ConePackingScratch;
};
const texelsOf = new WeakMap<CellTargets, Texels>();
const texels = (targets: CellTargets): Texels => {
  let found = texelsOf.get(targets);
  if (!found) {
    const size = targets.cols * targets.rows * 4;
    found = {
      life: new Uint8Array(size),
      owners: new Uint32Array(size / 4),
      revision: 0,
      light: new Uint8Array(size),
      lamps: null,
      stampedVehicles: new Uint8Array(0),
      beamCones: createConePackingScratch(),
      brakeCones: createConePackingScratch(),
    };
    texelsOf.set(targets, found);
  }
  return found;
};

/** The CPU raster belonging to these targets, without allocating or resetting it. */
export const lifeRaster = (targets: CellTargets) => texelsOf.get(targets) ?? null;
export type LabelObstacle = { left: number; top: number; width: number; height: number };
/** Detached current collision footprints, including halos and rotated bounds. */
export function labelObstacles(
  targets: CellTargets | null | undefined,
  grid: Pick<Grid, 'shiftX' | 'shiftY'>,
  cell: { w: number; h: number },
  dpr: number,
): LabelObstacle[] {
  if (!targets || dpr <= 0) return [];
  return (overlays.get(targets)?.overlay.taken ?? []).map((b) => ({
    left: (b.left * cell.w - grid.shiftX) / dpr,
    top: (b.top * cell.h - grid.shiftY) / dpr,
    width: (b.width * cell.w) / dpr,
    height: (b.height * cell.h) / dpr,
  }));
}
/** A conservative label/halo guard, including rotated labels' collision bounds. */
export function labelCovers(targets: CellTargets, col: number, row: number): boolean {
  const overlay = overlays.get(targets)?.overlay;
  if (!overlay) return false;
  return overlay.taken.some(
    (box) =>
      col >= box.left && col < box.left + box.width && row >= box.top && row < box.top + box.height,
  );
}

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
  focus?: ReadonlySet<LifeFocus>,
  /** Immutable paired agent/terrain frame; unchanged accepted worker frames may reuse it. */
  heldFrame?: object,
  speakers?: LifeGrid['speakers'],
  puffs?: Float64Array,
  crowd?: {
    event: ProcessionRoute;
    progress: number;
    quality: number;
    clock?: number;
    guardFor?: ThrongGuardFactory;
    pool?: ThrongFieldPool;
  },
): number {
  const { cols, rows } = targets;
  const buffers = texels(targets);
  // Target identity owns this cache. Placement and the paired frame own the ground
  // guard, whose wrapper may be newly allocated even when its terrain is unchanged.
  const inputs = heldFrame
    ? [
        themeRes,
        theme,
        placement,
        view.camera,
        view.dpr,
        view.cellDev.w,
        view.cellDev.h,
        agents,
        sun,
        focus,
        speakers,
        crowd?.event,
        crowd?.progress,
        crowd?.quality,
      ]
    : undefined;
  if (
    heldFrame &&
    !buffers.crowdPending &&
    buffers.held?.frame === heldFrame &&
    inputs!.every((value, i) => value === buffers.held!.inputs[i])
  )
    return buffers.held.drawn;
  buffers.held = undefined;
  const lifeTexels = buffers.life;
  const crowdPayload = crowd
    ? throng(
        crowd.event,
        crowd.progress,
        placement,
        cols,
        rows,
        view.camera.zoom,
        crowd.quality,
        crowd.guardFor,
        undefined,
        crowd.pool,
      )
    : undefined;
  buffers.crowdPending = crowdPayload?.pending;
  if (crowdPayload?.cells.length) {
    buffers.crowdMask ??= new Uint32Array(cols * rows * 8);
    buffers.crowdCells ??= [];
  }

  if (buffers.stampedVehicles.length < agents.length)
    buffers.stampedVehicles = new Uint8Array(agents.length);
  const packStart = profiler?.time();
  buffers.candles = buffers.clockCandidates = !!crowdPayload?.cells.some((c) => c.agent.candle);
  for (const agent of agents) {
    if (!agent.candle) continue;
    buffers.candles = true;
    if (agent.effectClock !== undefined) {
      buffers.clockCandidates = true;
      break;
    }
  }
  if (buffers.clockCandidates) {
    buffers.clocks ??= new EffectClocks(cols * rows);
    buffers.clockCells ??= [];
  }
  const drawn = packLife(
    lifeTexels,
    {
      cols,
      rows,
      cellWidth: view.cellDev.w,
      cellHeight: view.cellDev.h,
      toCell: placement.toCell,
      allowsGroundCell,
      speakers,
      stampedVehicles: buffers.stampedVehicles,
    },
    agents,
    theme,
    (glyph) => themeRes.map.atlas.index(glyph),
    // Birds' shadows (like the map's, glyphs/select.ts inShadow).
    sun,
    themeRes.map.lifeGlyphs,
    {
      owners: buffers.owners,
      focus,
      clockCells: buffers.clockCells,
      throng: crowdPayload,
      throngMask: buffers.crowdMask,
      throngCells: buffers.crowdCells,
    },
    puffs,
  );
  buffers.crowdPending = !!(crowdPayload?.pending || crowdPayload?.stampPending);
  // Birds may overwrite crowd texels; their real owner clears the crowd permission mask.
  if (buffers.crowdMask)
    for (const i of buffers.crowdCells ?? [])
      if (buffers.owners[i]) buffers.crowdMask.fill(0, i * 8, i * 8 + 8);
  buffers.stampedAgents = agents;
  buffers.revision++;
  if (buffers.clocks) {
    buffers.clocks.begin(0);
    for (const cell of buffers.clockCells!) {
      const agent = agents[buffers.owners[cell]! - 1];
      if (agent?.candle) buffers.clocks.set(0, cell, agent.effectClock ?? ORDINARY_CLOCK);
    }
    for (const cell of buffers.crowdCells ?? [])
      if (!buffers.owners[cell] && lifeTexels[cell * 4 + 3]! & 128)
        buffers.clocks.set(0, cell, heldClock(crowd?.clock ?? 0));
    buffers.clocks.finish(0);
  }
  if (packStart !== undefined) profiler!.add('pack', profiler!.time() - packStart);
  const uploadStart = profiler?.time();
  let crowdFirst = rows,
    crowdEnd = 0;
  for (const cell of buffers.crowdCells ?? []) {
    const row = Math.floor(cell / cols);
    crowdFirst = Math.min(crowdFirst, row);
    crowdEnd = Math.max(crowdEnd, row + 1);
  }
  uploadCrowdMask(gl, targets, crowdEnd ? buffers.crowdMask : undefined, [crowdFirst, crowdEnd]);
  uploadLife(gl, targets, lifeTexels);
  if (heldFrame) buffers.held = { frame: heldFrame, inputs: inputs!, drawn };
  if (uploadStart !== undefined) profiler!.add('upload', profiler!.time() - uploadStart);
  return drawn;
}

/**
 * Put the streetlights and floodlights, the moving vehicles' headlight beams and brake glow, and the candles
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
  const grid = { cols, rows, toCell: placement.toCell, world: placement.world };
  const buffers = texels(targets);
  const lightTexels = buffers.light;
  if (!buffers.lamps) {
    buffers.lamps = new Uint8Array(cols * rows * 4);
    repack = true;
  }
  const lampTexels = buffers.lamps;
  if (repack) packLights(lampTexels, grid, lamps);
  lightTexels.set(lampTexels);
  packBeams(lightTexels, grid, agents, buffers.beamCones);
  if (buffers.stampedAgents === agents)
    packBrakeGlow(lightTexels, grid, agents, buffers.stampedVehicles, buffers.brakeCones);
  // A cell's size in meters at the view's center sizes the candles.
  const [cellMeters] = sunUniforms(view, null).u_cellMeters;
  const clocks = buffers.clocks;
  clocks?.begin(1);
  packCandles(lightTexels, grid, agents, 1 / cellMeters!, clocks?.pool);
  clocks?.finish(1);
  uploadLights(gl, targets, lightTexels);
  effectClockPass(gl, targets);
}

/** Also called in daylight when lighting is idle. Raster changes alone cause no upload. */
export function effectClockPass(gl: GL, targets: CellTargets) {
  const buffers = texelsOf.get(targets);
  const clocks = buffers?.clocks;
  if (clocks?.active) {
    if (!targets.effectClockTex || buffers!.clockUpload !== clocks.revision) {
      uploadEffectClocks(gl, targets, clocks.values);
      buffers!.clockUpload = clocks.revision;
    }
  } else {
    if (targets.effectClockTex) uploadEffectClocks(gl, targets, undefined);
    if (buffers && !buffers.clockCandidates) {
      buffers.clocks = undefined;
      buffers.clockCells = undefined;
      buffers.clockUpload = undefined;
    }
  }
}

/** The weather over the map: how hard it rains (0–1), in which wind. */
export type Weather = {
  rain: number;
  wind: WindNow | null;
  fish?: boolean;
  detail?: boolean;
  cloudCover?: number;
  cloudSeed?: number;
  cloudDetail?: boolean;
  meterOrigin?: readonly [number, number];
  meterStep?: readonly [number, number];
  cloudOffset?: readonly [number, number];
};

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
    seasonal: boolean;
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
  let lightsChanged = false;
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
          base: {
            key: `${view.dpr}/${view.cellDev.w}/${view.cellDev.h}`,
            scale: 2 ** (view.camera.zoom - (SEASON_ZOOM.bunting.min - ZOOM_FADE)),
            toCell: (lng, lat) => {
              const [x, y] = project(lng, lat, SEASON_ZOOM.bunting.min - ZOOM_FADE);
              return [(x * view.dpr) / view.cellDev.w, (y * view.dpr) / view.cellDev.h];
            },
          },
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
      seasonal: (packed.seasonalCells ?? 0) > 0,
      viewport,
    };
    fixturesOf.set(targets, cache);
    changed = true;
    lightsChanged = true;
  } else {
    const phases = updateFixtureSignals(cache.packed, clock);
    changed = phases !== 0;
    lightsChanged = (phases & FixtureSignalChange.vehicle) !== 0;
  }
  const flagsChanged = updateFixtureFlags(cache.packed, motion);
  if (changed || flagsChanged) {
    uploadFixtures(gl, targets, cache.packed.texels);
  }
  if (lightsChanged) {
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
    updatePedestrianVisibility(
      cache.packed,
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
  focus = normalizeFocus(null),
  lifeTime = time,
  folklore: FolklorePacket = EMPTY_FOLKLORE,
  crop: CropPass | null = null,
) {
  const { atlas, tables } = themeRes.map;
  const label = themeRes.label;
  const { cellDev } = view;
  const focused =
    focus.folklore || focus.mask[0] !== 0 || focus.mask[1] !== 0 || focus.life.size > 0;
  const hasEffectClocks = targets.effectClockTex !== undefined;
  const program = glyphProgram(
    gl,
    programs,
    focused,
    hasEffectClocks,
    fixturesOf.get(targets)?.seasonal === true,
  );
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, view.width, view.height);
  gl.useProgram(program.program);
  twgl.setUniforms(program, {
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
    ...cropUniforms(crop),
    u_fillColors: tables.fillColors,
    u_fills: tables.fills,
    u_background: theme.background.slice(0, 3),
    u_time: time,
    u_pulse: reducedMotion ? [-1, -1] : [classId('marker_landmark'), classId('marker_heritage')],
    u_lifeTime: lifeTime,
    ...hauntUniforms(
      folklore,
      view,
      grid,
      !reducedMotion,
      (programs.folkloreUniforms ??= createHauntUniformScratch()),
    ),
    u_overlay: targets.overlayTex,
    u_labelColor: themeRes.uniforms.label,
    u_accent: themeRes.uniforms.accent,
    u_shimmer: !reducedMotion,
    u_buntingWind: buntingWindResponse(weather.wind?.strength ?? 0, reducedMotion),
    u_buntingWindDir: weather.wind?.dir ?? [0, 0],
    u_focus: focused,
    u_focusLife: focus.life.size > 0,
    u_focusClasses: focus.mask,
    u_waterDetail: !!weather.detail && !reducedMotion,
    u_fish: !!weather.fish && !reducedMotion,
    u_fishWater: fishWater,
    u_waterGlyphs: themeRes.map.waterGlyphs,
    u_life: targets.lifeTex,
    u_crowdMask: targets.crowdMaskTex,
    u_hasCrowdMask: !!targets.crowdMaskActive,
    u_effectClocks: targets.effectClockTex ?? targets.lifeTex,
    u_hasEffectClocks: hasEffectClocks,
    u_subClass: targets.sub.classTex,
    u_subAttr: targets.sub.attrTex,
    u_cellBits: lifeCellBits,
    u_origin: [grid.originCol, grid.originRow],
    u_attr: targets.attrTex,
    u_daylight: daylight,
    u_cloudCover: weather.cloudCover ?? 0,
    u_cloudSeed: weather.cloudSeed ?? 0,
    u_cloudDetail: weather.cloudDetail ?? false,
    u_meterOrigin: weather.meterOrigin ?? [0, 0],
    u_meterStep: weather.meterStep ?? [0, 0],
    u_cloudOffset: weather.cloudOffset ?? [0, 0],
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
    u_vehicleOccluders: LIFE_OCCLUDERS,
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
