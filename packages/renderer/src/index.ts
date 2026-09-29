import type { BBox, CameraState } from '@atlas/shared';
import {
  clampCamera,
  fitZoom,
  isTilted,
  MAX_ZOOM,
  MIN_ZOOM,
  orbitBy,
  panByView,
  viewportFor,
  zoomAround,
  type CameraLimits,
} from './camera';
import { classesIn, type RenderClass } from './classes';
import { DEFAULT_FONT } from './glyphs/atlas';
import { createCellTargets, deleteCellTargets, type CellTargets } from './gpu';
import {
  createPrograms,
  createThemeResources,
  deletePrograms,
  deleteThemeResources,
  type Programs,
  type ThemeResources,
} from './gpu-context';
import { startFlight, stepFlight, type Flight } from './flight';
import { attachInput } from './input';
import {
  cellPass,
  glyphPass,
  lifePass,
  overlayPass,
  placeGrid,
  screenArea,
  selectPass,
  type Grid,
  type GridPlacement,
  type TileDraw,
  type View,
} from './passes';
import { LabelRank } from './labels';
import { LifeWorld, type LifeTile, type VisibleAgent } from './life/simulate';
import { daylight as daylightAt, solarAltitude } from './life/sun';
import { MAX_HIGHLIGHT, Picker, type PickResult } from './picking';
import type { FeatureInfo, TileLabel } from './raster/geometry';
import { Readback } from './readback';
import { themes, type ThemeName } from './theme';
import { TileCache } from './tile-cache';
import { tileKey, type TileId } from './tiles';

export { CLASS_LABELS, type ThemeName } from './theme';
export { legendEntries, type LegendEntry } from './legend';
export type { FeatureInfo } from './raster/geometry';
export type { RenderClass } from './classes';

/**
 * The life layer (SPEC.md §4 "Life layer"): simulated traffic, people, boats, and birds, and
 * the time of day the map is lit for.
 */
export type LifeSettings = {
  /** Show the agents (never with reduced motion, which keeps the map still). */
  enabled: boolean;
  /**
   * How much daylight the map is lit with: `'live'` for the real sun over the view now, else a
   * fixed amount from 0 (night) to 1 (day), e.g. 0.5 for dusk.
   */
  daylight: 'live' | number;
};

export type AtlasOptions = {
  tilesUrl: string;
  theme?: ThemeName;
  /** Cell size in CSS pixels (SPEC.md §2: fixed on screen; default 10×18). */
  cell?: { width: number; height: number };
  /** The camera is clamped to these [west, south, east, north] bounds (the city meta's `regionBounds`). */
  bounds: BBox;
  initialCamera: CameraState;
  year: number;
  /**
   * Zoom limits (default 7–21, SPEC.md §2). Zooming out also stops where the bounds fill the
   * view (SPEC.md §3), recomputed when the canvas resizes.
   */
  minZoom?: number;
  maxZoom?: number;
  /**
   * `prefers-reduced-motion`: no water animation, landmark pulse, or selection shimmer, and
   * flights are short.
   */
  reducedMotion?: boolean;
  /** CSS font family for non-box-drawing glyphs. */
  font?: string;
  /** Default: enabled, live time of day. */
  life?: Partial<LifeSettings>;
  /** The clock for the live time of day (tests pin it). */
  now?: () => Date;
};

export type AtlasEventMap = {
  camerachange: CameraState;
  /** The feature under the mouse changed. `point` is in CSS px from the canvas's top left. */
  hover: {
    featureId: string | null;
    feature: FeatureInfo | null;
    point: [number, number] | null;
  };
  /** A click or tap, on a feature or on nothing. */
  click: {
    featureId: string | null;
    feature: FeatureInfo | null;
    point: [number, number];
    lngLat: [number, number];
  };
  /** A flight reached its target (not sent when input cancels it). */
  flyend: CameraState;
  /**
   * The visitor moved the camera (drag, wheel, pinch, orbit, or keys), which also ends any
   * flight. Clicks and hover don't count. A tour pauses on it.
   */
  input: CameraState;
  /** The browser took the WebGL context away (the map stops drawing until it is restored). */
  contextlost: undefined;
  /** The WebGL context is back and the map is being rebuilt. */
  contextrestored: undefined;
  /**
   * The classes drawn in at least one on-screen cell changed (for the legend, SPEC.md §5), in
   * class id order. Checked at most every 250 ms, a frame or two after drawing.
   */
  classeschange: RenderClass[];
  /**
   * The names of places, landmarks, and monuments on screen changed (street names aren't
   * included), in placement order: most important first. For a text alternative to the map.
   */
  labelschange: LabelInView[];
};

export type FlyOptions = {
  /** Flight duration in ms, instead of the 0.8–3 s rule. Reduced motion still caps it. */
  duration?: number;
};

export type AtlasEventName = keyof AtlasEventMap;

/** A place, landmark, or monument whose name is on screen (the `labelschange` event). */
export type LabelInView = {
  featureId: string;
  name: string;
  kind: 'place' | 'landmark' | 'monument';
  lngLat: [number, number];
};

/** Performance counters for the debug overlay (`?debug=1`, ARCHITECTURE.md §8). */
export type AtlasStats = {
  /** Frames drawn in the last second (idle frames that draw nothing don't count). */
  fps: number;
  /** Main-thread time of a drawn frame, smoothed, in ms (GPU time isn't included). */
  frameMs: number;
  /** Main-thread time of a cell pass (tiles, cells, labels), smoothed, in ms. */
  cellPassMs: number;
  tilesLoaded: number;
  tilesPending: number;
  /** Worker time to decode a tile, averaged over recent tiles, in ms. */
  decodeMs: number;
  /** Life layer agents on the grid in the last frame. */
  agents: number;
};

export type Atlas = {
  /** Move the camera, or fly there with `animate`. */
  setCamera(partial: Partial<CameraState>, opts?: { animate?: boolean } & FlyOptions): void;
  /** Fly to a camera (SPEC.md §3): zoom out, travel, zoom in. Any input cancels it. */
  flyTo(target: Partial<CameraState>, opts?: FlyOptions): void;
  getCamera(): CameraState;
  setYear(year: number, opts?: { animate?: boolean }): void;
  setTheme(theme: ThemeName): void;
  /** Select a feature by id (accent color and shimmer), or clear the selection. */
  setSelected(featureId: string | null): void;
  /** Highlight features by id (accent color), e.g. the ways of a street; at most 64. */
  setHighlighted(featureIds: readonly string[]): void;
  /** What the renderer knows about a feature, once a tile containing it has loaded. */
  getFeature(featureId: string): FeatureInfo | undefined;
  getStats(): AtlasStats;
  /** Turn the life layer on or off, or change the time of day. */
  setLife(settings: Partial<LifeSettings>): void;
  getLife(): LifeSettings;
  on<K extends AtlasEventName>(event: K, handler: (payload: AtlasEventMap[K]) => void): () => void;
  destroy(): void;
};

const DEFAULT_CELL = { width: 10, height: 18 };

const sameCamera = (a: CameraState, b: CameraState) =>
  a.lat === b.lat &&
  a.lng === b.lng &&
  a.zoom === b.zoom &&
  a.pitch === b.pitch &&
  a.bearing === b.bearing;
/** While idle, animation (water, landmark pulse) redraws at most this often. */
const IDLE_FRAME_MS = 1000 / 30;
/** How long after input the loop keeps drawing every frame. */
const ACTIVE_MS = 500;
/** The on-screen classes are read back at most this often. */
const CLASS_READ_MS = 250;
/** How often the sun's position is worked out again. */
const SUN_MS = 1000;
/** Life agents come from tiles at least this deep (the shallowest life zoom band is 13.5). */
const LIFE_TILE_MIN_ZOOM = 13;
/** Smoothing for the timing stats: each new sample's weight. */
const STATS_WEIGHT = 0.1;
const smooth = (average: number, sample: number) =>
  average === 0 ? sample : average + (sample - average) * STATS_WEIGHT;

/**
 * Create the ASCII atlas on a canvas (ARCHITECTURE.md §3). Each frame:
 * 1. choose the visible tiles and ask the worker for missing ones (tile-cache.ts)
 * 2. cell pass: rasterize tiles into one pixel per cell (class, attributes, feature id)
 * 3. overlay: place labels on the cell grid
 * 4. select pass: pick each cell's glyph from its class and neighbors
 * 5. glyph pass: draw the glyphs at full resolution
 * 6. picking: read the id buffer under the pointer back, asynchronously (picking.ts)
 * Steps 1–3 run only when the camera or tiles change (passes.ts has the passes).
 */
export function createAtlas(canvas: HTMLCanvasElement, options: AtlasOptions): Atlas {
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false });
  if (!gl) {
    throw new Error('ASCII Atlas requires WebGL2, which this browser does not support.');
  }

  const cellCss = options.cell ?? DEFAULT_CELL;
  const baseMinZoom = options.minZoom ?? MIN_ZOOM;
  const limits: CameraLimits = {
    bounds: options.bounds,
    minZoom: baseMinZoom,
    maxZoom: options.maxZoom ?? MAX_ZOOM,
  };
  const reducedMotion = options.reducedMotion ?? false;
  const font = options.font ?? DEFAULT_FONT;
  let camera = clampCamera({ ...options.initialCamera }, limits);
  let life: LifeSettings = { enabled: true, daylight: 'live', ...options.life };
  const now = options.now ?? (() => new Date());
  let theme = themes[options.theme ?? 'dark'];
  let destroyed = false;
  /** The WebGL context is lost: nothing draws, and no GPU handle is valid. */
  let lost = false;
  const listeners = new Map<AtlasEventName, Set<(payload: never) => void>>();

  const emit = <K extends AtlasEventName>(event: K, payload: AtlasEventMap[K]) => {
    for (const handler of listeners.get(event) ?? []) {
      (handler as (p: AtlasEventMap[K]) => void)(payload);
    }
  };

  // Frame state
  let cellDirty = true;
  let drawDirty = true;
  let lastDraw = -Infinity;
  let lastInput = -Infinity;
  const start = performance.now();
  /** Timing stats (`getStats`): when recent frames were drawn, and smoothed durations. */
  const drawTimes: number[] = [];
  let frameMs = 0;
  let cellPassMs = 0;

  // GPU resources (gpu-context.ts). Theme resources depend on the device pixel ratio (glyph
  // atlas resolution); the render targets are the cell grid plus a one-cell margin on every side.
  let programs: Programs | undefined = createPrograms(gl);
  let dpr = 0;
  let themeRes: ThemeResources | undefined;
  let targets: CellTargets | undefined;
  /** Bumped when the targets are recreated, so reads from the old ones are dropped. */
  let targetsGeneration = 0;
  let grid: Grid = { originCol: 0, originRow: 0, shiftX: 0, shiftY: 0 };
  let placement: GridPlacement | undefined;
  const readback = new Readback(gl);

  const cellDev = () => themeRes?.cellDev ?? { w: 1, h: 1 };
  const cssSize = () => ({ width: canvas.width / dpr, height: canvas.height / dpr });
  const view = (): View => ({
    camera,
    dpr,
    cellDev: cellDev(),
    width: canvas.width,
    height: canvas.height,
  });

  const buildThemeResources = () => {
    if (themeRes) deleteThemeResources(gl, themeRes);
    themeRes = createThemeResources(gl, theme, cellCss, dpr, font);
    cellDirty = true;
  };

  const resize = () => {
    const nextDpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(canvas.clientWidth * nextDpr));
    const height = Math.max(1, Math.round(canvas.clientHeight * nextDpr));
    if (nextDpr !== dpr || !themeRes) {
      dpr = nextDpr;
      buildThemeResources();
    }
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const cols = Math.ceil(width / cellDev().w) + 3;
    const rows = Math.ceil(height / cellDev().h) + 3;
    if (!targets || targets.cols !== cols || targets.rows !== rows) {
      if (targets) deleteCellTargets(gl, targets);
      targets = createCellTargets(gl, cols, rows);
      targetsGeneration++;
    }
    // Zooming out stops where the bounds fill the view (SPEC.md §3).
    const size = cssSize();
    limits.minZoom = Math.min(limits.maxZoom, Math.max(baseMinZoom, fitZoom(limits.bounds, size)));
    const clamped = clampCamera(camera, limits, size);
    if (!sameCamera(clamped, camera)) {
      camera = clamped;
      emit('camerachange', { ...camera });
    }
    cellDirty = true;
  };

  // Tiles
  const tileCache = new TileCache(
    gl,
    new URL(options.tilesUrl, canvas.ownerDocument.baseURI).href,
    () => {
      if (!destroyed) cellDirty = true;
    },
  );
  const { source } = tileCache;

  const drawCells = () => {
    if (!targets || !programs || !themeRes) return;
    const v = view();
    placement = placeGrid(v, targets);
    grid = placement.grid;
    const tiles = tileCache.tilesToDraw(camera, cssSize());
    syncLife(tiles);
    const labels = new Map<number, TileLabel>();
    const layer = (ids: readonly TileId[]): TileDraw[] => {
      const out: TileDraw[] = [];
      for (const tile of ids) {
        const loaded = tileCache.get(tile);
        if (!loaded) continue;
        for (const label of loaded.labels) labels.set(label.id, label);
        out.push({ tile, mesh: loaded.mesh });
      }
      return out;
    };
    // The region's own features first, from their coarser tiles (DATA.md §2 step 05).
    const region = layer(tileCache.regionTilesFor(tiles));
    cellPass(gl, programs, targets, v, placement, { region, tiles: layer(tiles) });
    const placed = overlayPass(gl, targets, themeRes, v, placement, labels.values());
    reportLabels(placed.flatMap((c) => labels.get(c.id) ?? []));
    classesStale = true;
  };

  /** The last `labelschange` payload's feature ids, to send it only on change. */
  let labelsKey = '';
  const reportLabels = (placed: readonly TileLabel[]) => {
    const inView: LabelInView[] = [];
    for (const label of placed) {
      const kind =
        label.rank === LabelRank.landmark
          ? 'landmark'
          : label.rank === LabelRank.monument
            ? 'monument'
            : label.rank === LabelRank.street ||
                label.rank === LabelRank.streetMinor ||
                label.rank === LabelRank.roadMajor
              ? null
              : 'place';
      const featureId = source.feature(label.id)?.id;
      if (!kind || !featureId) continue;
      inView.push({ featureId, name: label.text, kind, lngLat: [label.lng, label.lat] });
    }
    const key = inView.map((l) => l.featureId).join('|');
    if (key === labelsKey) return;
    labelsKey = key;
    emit('labelschange', inView);
  };

  // Which classes are on screen (the `classeschange` event): the on-screen part of the class
  // buffer is read back after cell passes, throttled, so the last one is always read.
  let classesStale = false;
  let lastClassRead = -Infinity;
  let presentKey = '';

  const readClasses = (now: number) => {
    if (!classesStale || !targets || now - lastClassRead < CLASS_READ_MS) return;
    classesStale = false;
    lastClassRead = now;
    const area = screenArea(view(), grid);
    const left = Math.max(0, area.left);
    const top = Math.max(0, area.top);
    const width = Math.min(targets.cols, area.right) - left;
    const height = Math.min(targets.rows, area.bottom) - top;
    if (width <= 0 || height <= 0) return;
    const generation = targetsGeneration;
    readback.request(
      targets.cellFbo,
      gl.COLOR_ATTACHMENT0,
      { x: left, y: top, width, height },
      (texels) => {
        if (generation !== targetsGeneration) {
          classesStale = true;
          return;
        }
        const classes = classesIn(texels);
        const key = classes.join(',');
        if (key === presentKey) return;
        presentKey = key;
        emit('classeschange', classes);
      },
    );
  };

  // The life layer (life/simulate.ts): agents for the tiles on screen, stepped every drawn frame.
  const world = new LifeWorld();
  const lifeActive = () => life.enabled && !reducedMotion;
  let lastLifeStep = -Infinity;
  /** Whether the life texture holds agents (so turning the layer off clears it once). */
  let lifeShown = false;
  let agentsDrawn = 0;

  const syncLife = (tiles: readonly TileId[]) => {
    const lifeTiles: LifeTile[] = [];
    if (lifeActive()) {
      for (const tile of tiles) {
        if (tile.z < LIFE_TILE_MIN_ZOOM) continue;
        const loaded = tileCache.get(tile);
        if (loaded) lifeTiles.push({ key: tileKey(tile), tile, life: loaded.life });
      }
    }
    world.sync(lifeTiles);
  };

  const drawLife = (at: number) => {
    if (!targets || !themeRes || !placement) return;
    let agents: VisibleAgent[] = [];
    if (lifeActive()) {
      world.step((at - lastLifeStep) / 1000);
      lastLifeStep = at;
      agents = world.visible(camera.zoom, daylight, [camera.lng, camera.lat]);
    } else if (!lifeShown) {
      return;
    }
    agentsDrawn = lifePass(gl, targets, themeRes, theme, view(), placement, agents);
    lifeShown = agents.length > 0;
  };

  // The time of day the map is lit for (life/sun.ts), worked out again every `SUN_MS`.
  let daylight = 1;
  let lastSun = -Infinity;
  const updateSun = (at: number) => {
    if (at - lastSun < SUN_MS) return;
    lastSun = at;
    const next =
      life.daylight === 'live'
        ? daylightAt(solarAltitude(now(), camera.lng, camera.lat))
        : Math.min(1, Math.max(0, life.daylight));
    if (Math.abs(next - daylight) > 0.001) {
      daylight = next;
      drawDirty = true;
    }
  };

  // Selection and highlights, by feature id; resolved to id-buffer indices each frame, since a
  // feature's index is only known once a tile containing it has loaded.
  let selectedId: string | null = null;
  let highlightedIds: readonly string[] = [];
  let hoverIndex = 0;
  const highlightIndices = new Uint32Array(MAX_HIGHLIGHT);

  const highlights = () => {
    let highlightCount = 0;
    for (const id of highlightedIds) {
      const index = source.indexOf(id);
      if (index > 0 && highlightCount < MAX_HIGHLIGHT) highlightIndices[highlightCount++] = index;
    }
    return {
      hover: hoverIndex,
      selected: selectedId ? source.indexOf(selectedId) : 0,
      highlight: highlightIndices,
      highlightCount,
    };
  };

  let sizeDirty = true;
  const observer = new ResizeObserver(() => {
    sizeDirty = true;
  });
  observer.observe(canvas);

  // Flights (SPEC.md §3 "Fly-to").
  let flight: Flight | null = null;

  const flyTo = (target: Partial<CameraState>, opts: FlyOptions = {}) => {
    const now = performance.now();
    flight = startFlight(camera, target, limits, cssSize(), {
      reducedMotion,
      duration: opts.duration,
      now,
    });
    lastInput = now;
  };

  const advanceFlight = (now: number) => {
    if (!flight) return;
    const step = stepFlight(flight, now, limits, cssSize());
    camera = step.camera;
    cellDirty = true;
    lastInput = now;
    emit('camerachange', { ...camera });
    if (step.done) {
      flight = null;
      emit('flyend', { ...camera });
    }
  };

  // Picking: at most one id-buffer read per frame, after drawing (ARCHITECTURE.md §3 step 7).
  /** Whether the mouse is over the canvas; a hover answered after it left is dropped. */
  let pointerOver = false;
  const picker = new Picker(
    readback,
    () => targetsGeneration,
    ({ point, click, index, camera: at, size }: PickResult) => {
      const feature = source.feature(index) ?? null;
      const featureId = feature?.id ?? null;
      if (click) {
        const [lng, lat] = viewportFor(at, size).unproject([...point]) as [number, number];
        emit('click', { featureId, feature, point, lngLat: [lng, lat] });
      } else if (pointerOver && index !== hoverIndex) {
        hoverIndex = index;
        drawDirty = true;
        emit('hover', { featureId, feature, point });
      }
    },
  );

  let raf = 0;
  const frame = (now: number) => {
    if (destroyed || lost) return;
    raf = requestAnimationFrame(frame);
    readback.poll();
    if (sizeDirty) {
      sizeDirty = false;
      resize();
    }
    advanceFlight(now);
    updateSun(now);
    if (!targets || !programs || !themeRes) return;
    const interval = now - lastInput < ACTIVE_MS ? 0 : IDLE_FRAME_MS;
    const animationDue = !reducedMotion && now - lastDraw >= interval;
    if (cellDirty || drawDirty || animationDue) {
      const time = (now - start) / 1000;
      const frameStart = performance.now();
      if (cellDirty) {
        cellDirty = false;
        drawCells();
        cellPassMs = smooth(cellPassMs, performance.now() - frameStart);
      }
      const v = view();
      selectPass(gl, programs, targets, themeRes, v, grid, reducedMotion ? 0 : time, highlights());
      drawLife(now);
      glyphPass(gl, programs, targets, themeRes, theme, v, grid, time, reducedMotion, daylight);
      drawDirty = false;
      lastDraw = now;
      frameMs = smooth(frameMs, performance.now() - frameStart);
      drawTimes.push(now);
    }
    while (drawTimes.length > 0 && drawTimes[0]! <= now - 1000) drawTimes.shift();
    // The cell targets keep the last drawn frame, so a pick doesn't need a redraw.
    picker.issue({
      fbo: targets.cellFbo,
      attachment: gl.COLOR_ATTACHMENT2,
      cols: targets.cols,
      rows: targets.rows,
      dpr,
      grid: {
        shiftX: grid.shiftX,
        shiftY: grid.shiftY,
        cellWidth: cellDev().w,
        cellHeight: cellDev().h,
      },
      camera: { ...camera },
      size: cssSize(),
      generation: targetsGeneration,
    });
    readClasses(now);
  };
  raf = requestAnimationFrame(frame);

  // A lost context (GPU reset, too many contexts, a backgrounded mobile tab) takes every GPU
  // handle with it. Ask for it back, then rebuild everything; the tiles are fetched again.
  const onContextLost = (event: Event) => {
    event.preventDefault();
    if (lost) return;
    lost = true;
    cancelAnimationFrame(raf);
    programs = undefined;
    themeRes = undefined;
    targets = undefined;
    targetsGeneration++;
    readback.reset(true);
    tileCache.suspend();
    emit('contextlost', undefined);
  };
  const onContextRestored = () => {
    if (!lost || destroyed) return;
    lost = false;
    programs = createPrograms(gl);
    tileCache.resume();
    // `resize` rebuilds the theme resources and render targets.
    sizeDirty = true;
    cellDirty = true;
    raf = requestAnimationFrame(frame);
    emit('contextrestored', undefined);
  };
  canvas.addEventListener('webglcontextlost', onContextLost);
  canvas.addEventListener('webglcontextrestored', onContextRestored);

  const applyCamera = (next: CameraState) => {
    camera = clampCamera(next, limits, dpr > 0 ? cssSize() : undefined);
    cellDirty = true;
    lastInput = performance.now();
    emit('camerachange', { ...camera });
  };

  /** Input takes over from any flight. */
  const byUser =
    <A extends unknown[]>(action: (...args: A) => void) =>
    (...args: A) => {
      flight = null;
      action(...args);
      emit('input', { ...camera });
    };

  const detachInput = attachInput(canvas, {
    pan: byUser((dx: number, dy: number) => applyCamera(panByView(camera, dx, dy, cssSize()))),
    // Tilted views zoom around the center (the cursor anchor math is for flat views).
    zoom: byUser((delta: number, anchor: [number, number]) => {
      const zoom = Math.min(limits.maxZoom, Math.max(limits.minZoom, camera.zoom + delta));
      applyCamera(zoomAround(camera, zoom, isTilted(camera) ? [0, 0] : anchor));
    }),
    orbit: byUser((dBearing: number, dPitch: number) =>
      applyCamera(orbitBy(camera, dBearing, dPitch)),
    ),
    hover: (point) => {
      pointerOver = point !== null;
      if (point) {
        picker.hover(point);
      } else {
        picker.cancelHover();
        if (hoverIndex !== 0) {
          hoverIndex = 0;
          drawDirty = true;
          emit('hover', { featureId: null, feature: null, point: null });
        }
      }
    },
    tap: (point) => picker.click(point),
  });

  return {
    setCamera(partial, opts) {
      if (opts?.animate) {
        flyTo(partial, opts);
        return;
      }
      flight = null;
      applyCamera({ ...camera, ...partial });
    },
    flyTo,
    getCamera: () => ({ ...camera }),
    setSelected(featureId) {
      selectedId = featureId;
      drawDirty = true;
    },
    setHighlighted(featureIds) {
      highlightedIds = featureIds.slice(0, MAX_HIGHLIGHT);
      drawDirty = true;
    },
    getFeature: (featureId) => source.featureById(featureId),
    getStats: () => ({
      fps: drawTimes.length,
      frameMs,
      cellPassMs,
      tilesLoaded: tileCache.size,
      tilesPending: source.pendingCount,
      decodeMs: source.decodeMsAverage,
      agents: agentsDrawn,
    }),
    setLife(settings) {
      life = { ...life, ...settings };
      lastSun = -Infinity;
      // Spawn or drop agents for the tiles on screen.
      cellDirty = true;
    },
    getLife: () => ({ ...life }),
    setYear() {
      // Phase 4: time filtering.
    },
    setTheme(name) {
      theme = themes[name];
      // While the context is lost, the theme is built on restore.
      if (!lost) buildThemeResources();
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
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
      detachInput();
      tileCache.destroy();
      readback.reset(lost);
      if (!lost) {
        if (targets) deleteCellTargets(gl, targets);
        if (themeRes) deleteThemeResources(gl, themeRes);
        if (programs) deletePrograms(gl, programs);
      }
      listeners.clear();
    },
  };
}
