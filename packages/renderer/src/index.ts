import type { BBox, CameraState } from '@atlas/shared';
import * as twgl from 'twgl.js';
import {
  clampCamera,
  isTilted,
  MAX_ZOOM,
  MIN_ZOOM,
  multiply,
  orbitBy,
  panByView,
  project,
  TILE_SIZE,
  viewportFor,
  zoomAroundClamped,
  type CameraLimits,
} from './camera';
import { classDepths, classId, classMinZooms, MAX_CLASSES } from './classes';
import { buildGlyphAtlas, DEFAULT_FONT, type GlyphAtlas } from './glyphs/atlas';
import {
  buildGlyphTables,
  MAX_VARIANTS,
  roadMask,
  seeThroughMask,
  type GlyphTables,
} from './glyphs/select';
import {
  createCellTargets,
  createProgram,
  createTexture,
  deleteCellTargets,
  deleteTile,
  drawExtrusions,
  drawTile,
  uploadOverlay,
  uploadTile,
  type CellTargets,
  type TileMesh,
} from './gpu';
import { attachInput } from './input';
import {
  createOverlay,
  LABEL_MIN_ZOOM,
  packOverlay,
  placeLabels,
  type LabelCandidate,
} from './labels';
import { EXTENT, type TileLabel } from './raster/geometry';
import { cellFragment, cellVertex } from './shaders/cell';
import { fullscreenVertex } from './shaders/fullscreen';
import { glyphFragment } from './shaders/glyph';
import { selectFragment } from './shaders/select';
import { themeGlyphs, themes, type ThemeName } from './theme';
import {
  boundsTiles,
  findAncestor,
  LruCache,
  tileKey,
  TileSource,
  tileZoom,
  viewTiles,
  type TileHeader,
  type TileId,
} from './tiles';

export type { ThemeName } from './theme';

export type AtlasOptions = {
  tilesUrl: string;
  theme?: ThemeName;
  /** Cell size in CSS pixels (SPEC.md §2: fixed on screen; default 10×18). */
  cell?: { width: number; height: number };
  /** The camera is clamped to these [west, south, east, north] bounds (the city meta's `regionBounds`). */
  bounds: BBox;
  initialCamera: CameraState;
  year: number;
  /** Zoom limits (default 7–21, SPEC.md §2). */
  minZoom?: number;
  maxZoom?: number;
  /** Disables the water animation and the landmark pulse (`prefers-reduced-motion`). */
  reducedMotion?: boolean;
  /** CSS font family for non-box-drawing glyphs. */
  font?: string;
};

export type AtlasEventMap = {
  camerachange: CameraState;
  hover: { featureId: string | null };
  click: { featureId: string | null };
  flyend: CameraState;
};

export type AtlasEventName = keyof AtlasEventMap;

export type Atlas = {
  setCamera(partial: Partial<CameraState>, opts?: { animate?: boolean }): void;
  setYear(year: number, opts?: { animate?: boolean }): void;
  setTheme(theme: ThemeName): void;
  on<K extends AtlasEventName>(event: K, handler: (payload: AtlasEventMap[K]) => void): () => void;
  destroy(): void;
};

const DEFAULT_CELL = { width: 10, height: 18 };
const TILE_CACHE_SIZE = 256;
/** While idle, animation (water, landmark pulse) redraws at most this often. */
const IDLE_FRAME_MS = 1000 / 30;
/** How long after input the loop keeps drawing every frame. */
const ACTIVE_MS = 500;

/**
 * Create the ASCII atlas on a canvas (ARCHITECTURE.md §3). Each frame:
 * 1. choose the visible tiles and ask the worker for missing ones
 * 2. cell pass: rasterize tiles into one pixel per cell (class, attributes, feature id)
 * 3. select pass: pick each cell's glyph from its class and neighbors
 * 4. glyph pass: draw the glyphs at full resolution
 * Steps 1–2 run only when the camera or tiles change.
 */
export function createAtlas(canvas: HTMLCanvasElement, options: AtlasOptions): Atlas {
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false });
  if (!gl) {
    throw new Error('ASCII Atlas requires WebGL2, which this browser does not support.');
  }

  const cellCss = options.cell ?? DEFAULT_CELL;
  const limits: CameraLimits = {
    bounds: options.bounds,
    minZoom: options.minZoom ?? MIN_ZOOM,
    maxZoom: options.maxZoom ?? MAX_ZOOM,
  };
  const reducedMotion = options.reducedMotion ?? false;
  const font = options.font ?? DEFAULT_FONT;
  let camera = clampCamera({ ...options.initialCamera }, limits);
  let theme = themes[options.theme ?? 'dark'];
  let destroyed = false;
  const listeners = new Map<AtlasEventName, Set<(payload: never) => void>>();

  const emit = <K extends AtlasEventName>(event: K, payload: AtlasEventMap[K]) => {
    for (const handler of listeners.get(event) ?? []) {
      (handler as (p: AtlasEventMap[K]) => void)(payload);
    }
  };

  // GPU programs
  const cellProgram = createProgram(gl, cellVertex, cellFragment);
  const selectProgram = createProgram(gl, fullscreenVertex, selectFragment);
  const glyphProgram = createProgram(gl, fullscreenVertex, glyphFragment);
  const emptyVao = gl.createVertexArray();
  const depths = classDepths();
  const minZooms = classMinZooms();
  const seeThrough = seeThroughMask();
  const roads = roadMask();

  // Frame state
  let cellDirty = true;
  let drawDirty = true;
  let lastDraw = -Infinity;
  let lastInput = -Infinity;
  const start = performance.now();

  // Theme resources depend on the device pixel ratio (glyph atlas resolution).
  let dpr = 0;
  let cellDev = { w: 1, h: 1 };
  let atlas: GlyphAtlas | undefined;
  let atlasTex: WebGLTexture | undefined;
  let tables: GlyphTables | undefined;
  let tableTex: WebGLTexture | undefined;

  const buildThemeResources = () => {
    if (atlasTex) gl.deleteTexture(atlasTex);
    if (tableTex) gl.deleteTexture(tableTex);
    cellDev = {
      w: Math.max(1, Math.round(cellCss.width * dpr)),
      h: Math.max(1, Math.round(cellCss.height * dpr)),
    };
    atlas = buildGlyphAtlas(themeGlyphs(theme), cellDev.w, cellDev.h, font);
    atlasTex = createTexture(gl, gl.R8, gl.RED, atlas.width, atlas.height, atlas.data);
    tables = buildGlyphTables(theme, atlas.index);
    tableTex = createTexture(gl, gl.R8, gl.RED, MAX_VARIANTS, MAX_CLASSES, tables.table);
    cellDirty = true;
  };

  // Render targets, sized to the cell grid plus a one-cell margin on every side.
  let targets: CellTargets | undefined;
  let grid = { originCol: 0, originRow: 0, shiftX: 0, shiftY: 0 };

  const resize = () => {
    const nextDpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(canvas.clientWidth * nextDpr));
    const height = Math.max(1, Math.round(canvas.clientHeight * nextDpr));
    if (nextDpr !== dpr) {
      dpr = nextDpr;
      buildThemeResources();
    }
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const cols = Math.ceil(width / cellDev.w) + 3;
    const rows = Math.ceil(height / cellDev.h) + 3;
    if (!targets || targets.cols !== cols || targets.rows !== rows) {
      if (targets) deleteCellTargets(gl, targets);
      targets = createCellTargets(gl, cols, rows);
    }
    cellDirty = true;
  };

  // Tiles
  let header: TileHeader | null = null;
  const failed = new Set<string>();
  /** Loaded tiles: their GPU mesh and label candidates (null = the archive has no tile). */
  const meshes = new LruCache<{ mesh: TileMesh; labels: TileLabel[] } | null>(
    TILE_CACHE_SIZE,
    (tile) => {
      if (tile) deleteTile(gl, tile.mesh);
    },
  );
  const source = new TileSource(new URL(options.tilesUrl, canvas.ownerDocument.baseURI).href, {
    header: (h) => {
      header = h;
      cellDirty = true;
    },
    tile: (key, geometry) => {
      if (destroyed) return;
      meshes.set(
        key,
        geometry ? { mesh: uploadTile(gl, geometry), labels: geometry.labels } : null,
      );
      cellDirty = true;
    },
    error: (message, key) => {
      if (key) failed.add(key);
      console.warn(`ASCII Atlas: ${key ? `tile ${key}: ` : ''}${message}`);
    },
  });

  const cssSize = () => ({ width: canvas.width / dpr, height: canvas.height / dpr });

  /** Tiles to draw for the view: loaded ones, else a loaded ancestor or loaded children. */
  const tilesToDraw = (): TileId[] => {
    if (!header) return [];
    const minZoom = header.minZoom;
    let view: TileId[];
    if (isTilted(camera)) {
      // The tilted view's ground footprint (the far edge is where the view reaches the ground).
      const [[west, south], [east, north]] = viewportFor(camera, cssSize()).getBounds() as [
        [number, number],
        [number, number],
      ];
      view = boundsTiles([west, south, east, north], tileZoom(camera.zoom, header), header, [
        camera.lng,
        camera.lat,
      ]);
    } else {
      view = viewTiles(camera, cssSize(), header);
    }
    const out = new Map<string, TileId>();
    for (const tile of view) {
      const key = tileKey(tile);
      if (meshes.has(key)) {
        out.set(key, tile);
        continue;
      }
      if (!failed.has(key)) source.request(tile);
      const ancestor = findAncestor(tile, minZoom, (k) => meshes.has(k));
      if (ancestor) {
        out.set(tileKey(ancestor), ancestor);
        continue;
      }
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const child = { z: tile.z + 1, x: tile.x * 2 + dx, y: tile.y * 2 + dy };
          if (meshes.has(tileKey(child))) out.set(tileKey(child), child);
        }
      }
    }
    // Coarser tiles first, so finer ones overwrite them where both exist.
    return [...out.values()].sort((a, b) => a.z - b.z);
  };

  /** Screen position (CSS px) of a point, for the overlay; set by each cell pass. */
  let screenOf: (lng: number, lat: number) => [number, number] = () => [0, 0];

  const cellPass = () => {
    if (!targets) return;
    const { cols, rows } = targets;
    const tilted = isTilted(camera);
    const view = viewportFor(camera, cssSize());
    screenOf = (lng, lat) => view.project([lng, lat]) as [number, number];

    /** Tile units and meters → cell-grid clip space, per tile. */
    let tileMatrix: (tile: TileId) => number[];
    if (tilted) {
      // Perspective: the grid is fixed to the screen, with a one-cell margin on each side.
      grid = { originCol: 0, originRow: 0, shiftX: cellDev.w, shiftY: cellDev.h };
      const [w, h] = [canvas.width, canvas.height];
      // prettier-ignore
      const screenToGrid = [
        w / (cellDev.w * cols), 0, 0, 0,
        0, -h / (cellDev.h * rows), 0, 0,
        0, 0, 1, 0,
        (w + 2 * cellDev.w) / (cellDev.w * cols) - 1, (h + 2 * cellDev.h) / (cellDev.h * rows) - 1, 0, 1,
      ];
      const toGrid = multiply(screenToGrid, view.viewProjectionMatrix);
      const unitsPerMeter = view.distanceScales.unitsPerMeter[2]!;
      tileMatrix = ({ z, x, y }) => {
        const size = TILE_SIZE / 2 ** z;
        // prettier-ignore
        return multiply(toGrid, [
          size / EXTENT, 0, 0, 0,
          0, -size / EXTENT, 0, 0,
          0, 0, unitsPerMeter, 0,
          x * size, TILE_SIZE - y * size, 0, 1,
        ]);
      };
    } else {
      // Flat north-up: the grid is anchored to the world, shifted by the sub-cell pan offset.
      const [cx, cy] = project(camera.lng, camera.lat, camera.zoom);
      const left = Math.round(cx * dpr - canvas.width / 2);
      const top = Math.round(cy * dpr - canvas.height / 2);
      const originCol = Math.floor(left / cellDev.w) - 1;
      const originRow = Math.floor(top / cellDev.h) - 1;
      grid = {
        originCol,
        originRow,
        shiftX: left - originCol * cellDev.w,
        shiftY: top - originRow * cellDev.h,
      };
      tileMatrix = (tile) => {
        const tileDev = TILE_SIZE * 2 ** (camera.zoom - tile.z) * dpr;
        // prettier-ignore
        return [
          ((tileDev / EXTENT / cellDev.w) * 2) / cols, 0, 0, 0,
          0, ((tileDev / EXTENT / cellDev.h) * 2) / rows, 0, 0,
          0, 0, 1, 0,
          ((tile.x * tileDev) / cellDev.w - originCol) * (2 / cols) - 1,
          ((tile.y * tileDev) / cellDev.h - originRow) * (2 / rows) - 1, 0, 1,
        ];
      };
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, targets.cellFbo);
    gl.viewport(0, 0, cols, rows);
    for (let i = 0; i < 3; i++) gl.clearBufferfv(gl.COLOR, i, [0, 0, 0, 0]);
    gl.clearBufferfi(gl.DEPTH_STENCIL, 0, 1, 0);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.useProgram(cellProgram.program);
    twgl.setUniforms(cellProgram, {
      u_depth: depths,
      u_minZoom: minZooms,
      u_zoom: camera.zoom,
      u_roadMask: roads,
    });

    const labels = new Map<number, TileLabel>();
    const drawn: { mesh: TileMesh; matrix: number[] }[] = [];
    for (const tile of tilesToDraw()) {
      const loaded = meshes.get(tileKey(tile));
      if (!loaded) continue;
      for (const label of loaded.labels) labels.set(label.id, label);
      const matrix = tileMatrix(tile);
      twgl.setUniforms(cellProgram, { u_matrix: matrix });
      drawTile(gl, loaded.mesh);
      drawn.push({ mesh: loaded.mesh, matrix });
    }
    // 3D buildings stand up only in the tilted view.
    if (tilted) {
      for (const { mesh, matrix } of drawn) {
        twgl.setUniforms(cellProgram, { u_matrix: matrix });
        drawExtrusions(gl, mesh);
      }
    }
    gl.bindVertexArray(null);
    gl.disable(gl.DEPTH_TEST);
    uploadOverlay(gl, targets, overlayTexels([...labels.values()]));
  };

  /** Place the names whose zoom band includes the camera zoom (labels.ts). */
  const overlayTexels = (labels: TileLabel[]): Uint8Array => {
    if (!targets || !atlas) return new Uint8Array(0);
    const overlay = createOverlay(targets.cols, targets.rows);
    const tilted = isTilted(camera);
    const toCell = (lng: number, lat: number): [number, number] => {
      if (tilted) {
        // The grid starts one cell above and left of the screen.
        const [x, y] = screenOf(lng, lat);
        return [(x * dpr) / cellDev.w + 1, (y * dpr) / cellDev.h + 1];
      }
      const [x, y] = project(lng, lat, camera.zoom);
      return [(x * dpr) / cellDev.w - grid.originCol, (y * dpr) / cellDev.h - grid.originRow];
    };
    // Only the cells actually on screen (the grid has a margin, and a sub-cell pan shift).
    const area = {
      left: Math.ceil(grid.shiftX / cellDev.w),
      top: Math.ceil(grid.shiftY / cellDev.h),
      right: Math.floor((grid.shiftX + canvas.width) / cellDev.w),
      bottom: Math.floor((grid.shiftY + canvas.height) / cellDev.h),
    };
    const glyphs = atlas;
    const glyphIndex = (char: string) => {
      const index = glyphs.index(char);
      return index === 0 ? undefined : index;
    };

    const candidates: LabelCandidate[] = [];
    for (const label of labels) {
      if (camera.zoom < (LABEL_MIN_ZOOM[label.rank] ?? Infinity)) continue;
      const [col, row] = toCell(label.lng, label.lat);
      candidates.push({
        id: label.id,
        text: label.text,
        rank: label.rank,
        col: Math.floor(col),
        row: Math.floor(row),
      });
    }
    placeLabels(overlay, candidates, glyphIndex, area);
    return packOverlay(overlay);
  };

  const selectPass = (time: number) => {
    if (!targets || !tables) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, targets.glyphFbo);
    gl.viewport(0, 0, targets.cols, targets.rows);
    gl.useProgram(selectProgram.program);
    twgl.setUniforms(selectProgram, {
      u_class: targets.classTex,
      u_attr: targets.attrTex,
      u_id: targets.idTex,
      u_table: tableTex,
      u_kind: tables.kinds,
      u_count: tables.counts,
      u_connect: tables.connects,
      u_origin: [grid.originCol, grid.originRow],
      u_time: reducedMotion ? 0 : time,
      u_zoom: camera.zoom,
      u_seeThrough: seeThrough,
      u_roadMask: roads,
      u_tilted: isTilted(camera),
      u_cellAspect: cellDev.h / cellDev.w,
    });
    gl.bindVertexArray(emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  const glyphPass = (time: number) => {
    if (!targets || !tables || !atlas) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(glyphProgram.program);
    twgl.setUniforms(glyphProgram, {
      u_glyphs: targets.glyphTex,
      u_atlas: atlasTex,
      u_cell: [cellDev.w, cellDev.h],
      u_shift: [grid.shiftX, grid.shiftY],
      u_height: canvas.height,
      u_columns: atlas.columns,
      u_colors: tables.colors,
      u_background: theme.background.slice(0, 3),
      u_time: time,
      u_pulse: reducedMotion ? -1 : classId('marker_landmark'),
      u_overlay: targets.overlayTex,
      u_labelColor: [
        ((theme.label >> 16) & 0xff) / 255,
        ((theme.label >> 8) & 0xff) / 255,
        (theme.label & 0xff) / 255,
      ],
    });
    gl.bindVertexArray(emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  };

  let sizeDirty = true;
  const observer = new ResizeObserver(() => {
    sizeDirty = true;
  });
  observer.observe(canvas);

  let raf = 0;
  const frame = (now: number) => {
    if (destroyed) return;
    raf = requestAnimationFrame(frame);
    if (sizeDirty) {
      sizeDirty = false;
      resize();
    }
    const interval = now - lastInput < ACTIVE_MS ? 0 : IDLE_FRAME_MS;
    const animationDue = !reducedMotion && now - lastDraw >= interval;
    if (!cellDirty && !drawDirty && !animationDue) return;
    const time = (now - start) / 1000;
    if (cellDirty) {
      cellDirty = false;
      cellPass();
    }
    selectPass(time);
    glyphPass(time);
    drawDirty = false;
    lastDraw = now;
  };
  raf = requestAnimationFrame(frame);

  const applyCamera = (next: CameraState) => {
    camera = clampCamera(next, limits);
    cellDirty = true;
    lastInput = performance.now();
    emit('camerachange', { ...camera });
  };

  const detachInput = attachInput(canvas, {
    pan: (dx, dy) => applyCamera(panByView(camera, dx, dy, cssSize())),
    // Tilted views zoom around the center (the cursor anchor math is for flat views).
    zoom: (delta, anchor) =>
      applyCamera(
        zoomAroundClamped(camera, camera.zoom + delta, isTilted(camera) ? [0, 0] : anchor, limits),
      ),
    orbit: (dBearing, dPitch) => applyCamera(orbitBy(camera, dBearing, dPitch)),
  });

  return {
    setCamera(partial) {
      // Fly-to animation arrives in Phase 2.
      applyCamera({ ...camera, ...partial });
    },
    setYear() {
      // Phase 4: time filtering.
    },
    setTheme(name) {
      theme = themes[name];
      buildThemeResources();
      drawDirty = true;
    },
    on(event, handler) {
      const set = listeners.get(event) ?? new Set();
      set.add(handler);
      listeners.set(event, set);
      return () => {
        set.delete(handler);
      };
    },
    destroy() {
      destroyed = true;
      cancelAnimationFrame(raf);
      observer.disconnect();
      detachInput();
      source.destroy();
      meshes.clear();
      if (targets) deleteCellTargets(gl, targets);
      if (atlasTex) gl.deleteTexture(atlasTex);
      if (tableTex) gl.deleteTexture(tableTex);
      for (const p of [cellProgram, selectProgram, glyphProgram]) gl.deleteProgram(p.program);
      gl.deleteVertexArray(emptyVao);
      listeners.clear();
    },
  };
}
