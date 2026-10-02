import { MOMENTS } from './life/moments';
import { spawnMargin } from './life/births';
import {
  bandVisibility,
  CLASS_ZOOM,
  UTILITY_ZOOM,
  shopHours,
  shopOpen,
  dialogueChoices,
  type ShopHours,
} from '@atlas/shared';
import { sameReferenceMembers } from './cache-inputs';
import type {
  BBox,
  CameraState,
  CityLifeConfig,
  ClimateConfig,
  DialogueCatalog,
  RuntimeDialogueCatalog,
  ProcessionRoute,
  TrafficMix,
} from '@atlas/shared';
import {
  clampCamera,
  fitZoom,
  MAX_ZOOM,
  MIN_ZOOM,
  panBy,
  viewportFor,
  zoomAround,
  type CameraLimits,
} from './camera';
import { classesIn, type RenderClass } from './classes';
import { DEFAULT_FONT } from './glyphs/atlas';
import { createCellTargets, deleteCellTargets, type CellTargets } from './gpu';
import {
  cellStep,
  DEFAULT_CELLS,
  DEFAULT_LABEL_CELL,
  detailZoom,
  stepCell,
  type CellSchedule,
} from './density';
import {
  createLabelGlyphs,
  createMapGlyphs,
  createPrograms,
  deleteLabelGlyphs,
  deleteMapGlyphs,
  deletePrograms,
  type LabelGlyphs,
  type MapGlyphs,
  type Programs,
  type ThemeResources,
} from './gpu-context';
import { startFlight, stepFlight, type Flight } from './flight';
import { attachInput } from './input';
import {
  cellPass,
  crownPass,
  effectClockPass,
  glyphPass,
  fixturePass,
  hasCrowns,
  lifePass,
  lifeRaster,
  labelsCoverPoint,
  labelCovers,
  lightPass,
  metersPerCssPx,
  overlayPass,
  streetTextPass,
  placeGrid,
  screenArea,
  selectPass,
  type Grid,
  type GridPlacement,
  type TileDraw,
  type View,
} from './passes';
import { LabelRank } from './labels';
import { LifeHoverController, type LifeHover } from './life/hover';
import { normalizeFocus, type LegendFocus } from './focus';
import { atCityMinutes, cityTime, type ClockZone } from './life/clock';
import {
  activityChanged,
  activityLevels,
  FLOOD,
  SHOP,
  STREETLIGHT,
  type Activity,
} from './life/config';
import {
  FLOOD_STRIDE,
  LAMP_STRIDE,
  LampState,
  placeSeed,
  SHOP_STRIDE,
  type LampState as LampStateValue,
  type VisibleLamp,
} from './life/lights';
import { moonlight } from './life/moon';
import { createUtilityFixtureCache } from './life/utilities';
import { tileFixtures, type StreetFixture, type FixtureVisibility } from './life/fixtures';
import { liveProgress, type LngLatBounds } from './life/procession';
import { LifeWorld, type LifeTile, type ProcessionRun, type VisibleAgent } from './life/simulate';
import { createInlineHost, createWorkerHost, type FrameView } from './life/host';
import { LifePause, LivePauseOffset } from './life/pause';
import { SpeechController, type SpeechInView } from './life/speech';
import { daylight as daylightAt, solarPosition, type Sun } from './life/sun';
import {
  prevailingWind,
  rainFor,
  stillWind,
  windAt,
  type WindChoice,
  type WindNow,
} from './life/wind';
import { animationDue, watchVisibility } from './pacing';
import { MAX_HIGHLIGHT, Picker, type PickResult } from './picking';
import {
  EXTENT,
  metersPerUnit,
  tileToLngLat,
  type FeatureInfo,
  type TileLabel,
} from './raster/geometry';
import { Readback } from './readback';
import { GpuTimer } from './gpu-timer';
import { FrameProfiler, type AtlasProfile } from './profile';
import { QualityController, TIERS, type QualityChoice, type QualityState } from './quality';
import { themes, type ThemeName } from './theme';
import { themeUniforms } from './theme-uniforms';
import { TileCache, type LoadedTile } from './tile-cache';
import { tileKey, type TileId } from './tiles';

export { CLASS_LABELS, type ThemeName } from './theme';
export { DEFAULT_CELLS, type CellSchedule } from './density';
export { legendEntries, type LegendEntry, type LegendEntryId, type LegendIcon } from './legend';
export type { FeatureInfo } from './raster/geometry';
export type { FixtureVisibility } from './life/fixtures';
export type { SpeechInView } from './life/speech';
export type { LifeHover } from './life/hover';
export type { RenderClass } from './classes';
export type { LifeFocus, LegendFocus } from './focus';
export type { AtlasProfile } from './profile';
export type { QualityChoice, QualityState } from './quality';
export type { WindChoice } from './life/wind';
export { cityTime, type LocalTime } from './life/clock';

/**
 * The life layer (SPEC.md §4 "Life layer"): simulated traffic, people, boats, and birds, and
 * the time of day the map is lit for.
 */
export type LifeSettings = {
  /** Show the agents (never with reduced motion, which keeps the map still). */
  enabled: boolean;
  /**
   * The time of day in the city: `'live'` for its clock now, else a fixed time, in minutes past
   * local midnight (today, in the city). The sun lights the map for it, and the daily rhythm
   * sets how much traffic is out (life/config.ts `activityLevels`).
   */
  time: 'live' | number;
  /**
   * How hard the wind blows over grass, trees, and water: `'live'` for the season's (the city's
   * `climate`), else a strength, from the season's direction.
   */
  wind: WindChoice;
};

export type AtlasOptions = {
  /** Per-item hover pause; 'all' restores the previous global inspection path. */
  lifeHoverPause?: 'item' | 'all';
  /** Optional curated city-pack speech. Display preferences do not affect simulation. */
  dialogue?: DialogueCatalog | RuntimeDialogueCatalog;
  speech?: boolean;
  /** Static city-pack utility policy; omitted means disabled. */
  utilities?: { derive: boolean };
  /** Drawing quality, independent of simulation and view state. Default: Auto. */
  quality?: QualityChoice;
  tilesUrl: string;
  theme?: ThemeName;
  /**
   * Map cell size in CSS pixels by zoom (SPEC.md §2 "Cell size"; default `DEFAULT_CELLS`:
   * 8 px wide in wide views down to 5 px up close).
   */
  cells?: CellSchedule;
  /** Label cell size in CSS pixels, fixed (default 10×18). */
  labelCell?: { width: number; height: number };
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
  /** Opt-in asynchronous GPU frame timing, for diagnostics only. */
  gpuTiming?: boolean;
  /** Collect bounded CPU stage samples for local diagnostics. Disabled by default. */
  profiling?: boolean;
  /** Run Life in a worker when available; false selects the synchronous in-process path. */
  lifeWorker?: boolean;
  /**
   * Which features respond to the pointer: hovering highlights them, and the `hover` and `click`
   * events report them. Anything else is treated as nothing. Default: every feature.
   */
  interactive?: (feature: FeatureInfo) => boolean;
  /** CSS font family for non-box-drawing glyphs. */
  font?: string;
  /** Default: enabled, live time of day. */
  life?: Partial<LifeSettings>;
  /** The city's vehicle mix (its pack's `traffic`); default: life/vehicles.ts `DEFAULT_TRAFFIC`. */
  traffic?: TrafficMix;
  /** The city's winds by season (its pack's `climate`); default: a breeze from the east. */
  climate?: ClimateConfig;
  /**
   * The city's IANA time zone (its pack's `timezone`), which its clock follows; default: the
   * sun's time at the middle of `bounds`.
   */
  timezone?: string;
  /** The city's daily rhythm (its pack's `life`); default: `DEFAULT_RHYTHM`. */
  cityLife?: CityLifeConfig;
  /** The clock for the live time of day (tests pin it). */
  now?: () => Date;
  /**
   * The city's river processions (its `<slug>.processions.json`): played on request, and shown
   * live while one is under way by its schedule (with the live time of day).
   */
  processions?: readonly ProcessionRoute[];
};

export type { ProcessionRun } from './life/simulate';

export type AtlasEventMap = {
  /** A visible simulated agent under the mouse, in canvas CSS pixels. */
  lifehover: LifeHover;
  /** Visible simulated speakers, anchored in CSS pixels from the canvas top left. */
  speechchange: SpeechInView[];
  qualitychange: QualityState;
  camerachange: CameraState;
  /**
   * The interactive feature under the mouse changed (`AtlasOptions.interactive`). `point` is in
   * CSS px from the canvas's top left.
   */
  hover: {
    featureId: string | null;
    feature: FeatureInfo | null;
    point: [number, number] | null;
  };
  /** A click or tap, on an interactive feature or on nothing. */
  click: {
    featureId: string | null;
    feature: FeatureInfo | null;
    point: [number, number];
    lngLat: [number, number];
  };
  /** A flight reached its target (not sent when input cancels it). */
  flyend: CameraState;
  /**
   * The visitor moved the camera (drag, wheel, pinch, or keys), which also ends any
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
  /** A procession started, ended, or went from played to live (null: none is under way). */
  procession: ProcessionRun | null;
  /** The streetlights came on (dusk or night, close enough to see them) or went (for the legend). */
  lightschange: boolean;
  /** Hardware packed inside the viewport, independent of Life and illumination. */
  fixtureschange: FixtureVisibility;
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
  quality: QualityState;
  /** Frames drawn in the last second (idle frames that draw nothing don't count). */
  fps: number;
  /** Main-thread time of a drawn frame, smoothed, in ms (GPU time isn't included). */
  frameMs: number;
  /** GPU rendering time in ms; null when disabled, unavailable, or awaiting a valid sample. */
  gpuFrameMs: number | null;
  /** Main-thread time of a cell pass (tiles, cells, labels), smoothed, in ms. */
  cellPassMs: number;
  /** Main-thread time of a crown pass (the swaying tree crowns), smoothed, in ms. */
  crownPassMs: number;
  /** Main-thread time of the life layer (moving, placing, and packing its agents), smoothed, in ms. */
  lifeMs: number;
  tilesLoaded: number;
  tilesPending: number;
  /** Worker time to decode a tile, averaged over recent tiles, in ms. */
  decodeMs: number;
  /** Life layer agents on the grid in the last frame. */
  agents: number;
};

export type Atlas = {
  /** Transient legend focus; null restores ordinary map colours. */
  setFocus(focus: LegendFocus | null): void;
  setSpeech(enabled: boolean): void;
  setQuality(choice: QualityChoice): void;
  getQuality(): QualityChoice;
  /** Move the camera, or fly there with `animate`. */
  setCamera(partial: Partial<CameraState>, opts?: { animate?: boolean } & FlyOptions): void;
  /** Fly to a camera (SPEC.md §3): zoom out, travel, zoom in. Any input cancels it. */
  flyTo(target: Partial<CameraState>, opts?: FlyOptions): void;
  getCamera(): CameraState;
  /** Apply a changed motion preference without recreating the map or changing Life settings. */
  setReducedMotion(enabled: boolean): void;
  setYear(year: number, opts?: { animate?: boolean }): void;
  setTheme(theme: ThemeName): void;
  /** Select a feature by id (accent color and shimmer), or clear the selection. */
  setSelected(featureId: string | null): void;
  /** Highlight features by id (accent color), e.g. the ways of a street; at most 64. */
  setHighlighted(featureIds: readonly string[]): void;
  /** What the renderer knows about a feature, once a tile containing it has loaded. */
  getFeature(featureId: string): FeatureInfo | undefined;
  getStats(): AtlasStats;
  /** A detached diagnostic snapshot, or null when profiling is disabled. */
  getProfile(): AtlasProfile | null;
  resetProfile(): void;
  /** Turn the life layer on or off, or change the time of day. */
  setLife(settings: Partial<LifeSettings>): void;
  getLife(): LifeSettings;
  /**
   * Play a procession from its start as a time-lapse. False when it isn't one of the city's or
   * the life layer is off.
   */
  playProcession(id: string): boolean;
  stopProcession(): void;
  on<K extends AtlasEventName>(event: K, handler: (payload: AtlasEventMap[K]) => void): () => void;
  destroy(): void;
};

const sameCamera = (a: CameraState, b: CameraState) =>
  a.lat === b.lat && a.lng === b.lng && a.zoom === b.zoom;
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
  const readGpuRenderer = (): string | null => {
    if (!options.profiling) return null;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? (gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string) : null;
  };
  let gpuRenderer = readGpuRenderer();
  const quality = new QualityController(options.quality ?? 'auto');
  let knobs = TIERS[quality.tier]!.knobs;
  let previousDraw: { at: number; cpuMs: number } | undefined;
  let qualityWarmupDraw = true;
  const resetQualitySamples = () => {
    quality.reset();
    previousDraw = undefined;
    qualityWarmupDraw = true;
  };

  const schedule = options.cells ?? DEFAULT_CELLS;
  const labelCss = options.labelCell ?? DEFAULT_LABEL_CELL;
  const baseMinZoom = options.minZoom ?? MIN_ZOOM;
  const limits: CameraLimits = {
    bounds: options.bounds,
    minZoom: baseMinZoom,
    maxZoom: options.maxZoom ?? MAX_ZOOM,
  };
  let reducedMotion = options.reducedMotion ?? false;
  const interactive = options.interactive ?? (() => true);
  const font = options.font ?? DEFAULT_FONT;
  let camera = clampCamera({ ...options.initialCamera }, limits);
  let life: LifeSettings = { enabled: true, time: 'live', wind: 'live', ...options.life };
  const now = options.now ?? (() => new Date());
  /** Where the city's clock is (life/clock.ts). */
  const zone: ClockZone = {
    timezone: options.timezone,
    lng: (options.bounds[0] + options.bounds[2]) / 2,
  };
  /** The city's month now (1–12), which the season's wind follows (kept by `updateSun`). */
  let cityMonth = cityTime(now(), zone).month;
  /**
   * The wind at `time` seconds in world axes (x east, y south), which are the grid's (the map is
   * north-up): the season's (or the chosen strength), veering and breathing; still with reduced
   * motion.
   */
  const worldWind = (time: number): WindNow => {
    const base = prevailingWind(life.wind, options.climate, cityMonth);
    return reducedMotion ? stillWind(base) : windAt(time, base);
  };
  /** How hard it rains now: in a storm (the chosen or the season's), never with reduced motion. */
  const currentRain = (): number =>
    rainFor(prevailingWind(life.wind, options.climate, cityMonth), reducedMotion);
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
  /**
   * What the cells were last drawn for, in a flat view: the zoom, where the map and label grids
   * start, and which of their cells are on screen. A pan that changes none of it (within a cell)
   * leaves the cells as they are, only shifted (`shiftCells`). Null: draw them again.
   */
  let cellsFor: string | null = null;
  let cellsTargets: CellTargets | undefined;
  let drawDirty = true;
  let focus = normalizeFocus(null);
  let lastDraw = -Infinity;
  let lastInput = -Infinity;
  const start = performance.now();
  const lifePause = new LifePause<FrameView>(start, life.enabled && !reducedMotion);
  const itemInspection = options.lifeHoverPause !== 'all';
  let inspected: { id: number; generation: number | undefined } | undefined;
  let inspectionRevision = 0;
  const livePause = new LivePauseOffset();
  let drawnLife: FrameView | undefined;
  /** Timing stats (`getStats`): when recent frames were drawn, and smoothed durations. */
  const drawTimes: number[] = [];
  let frameMs = 0;
  let cellPassMs = 0;
  let crownPassMs = 0;
  let lifeMs = 0;

  // GPU resources (gpu-context.ts). Glyphs depend on the device pixel ratio (atlas resolution)
  // and, for the map's, on the cell size step (density.ts), so each step's are kept once built.
  // The render targets are the map and label grids, each plus a one-cell margin on every side.
  let programs: Programs | undefined = createPrograms(gl);
  let dpr = 0;
  /** The map cell size step (density.ts `cellStep`), set by `resize`. */
  let step: number | undefined;
  const mapGlyphs = new Map<number, MapGlyphs>();
  let uniforms = themeUniforms(theme);
  let labelGlyphs: LabelGlyphs | undefined;
  let themeRes: ThemeResources | undefined;
  let targets: CellTargets | undefined;
  /** Bumped when the targets are recreated, so reads from the old ones are dropped. */
  let targetsGeneration = 0;
  let grid: Grid = { originCol: 0, originRow: 0, shiftX: 0, shiftY: 0 };
  let labelGrid: Grid = grid;
  let placement: GridPlacement | undefined;
  /** The tiles the last cell pass drew, whose tree crowns the crown pass draws over it. */
  let crownTiles: TileDraw[] = [];
  const readback = new Readback(gl);
  const lifeHover = new LifeHoverController(
    readback,
    gl.COLOR_ATTACHMENT0,
    (hover) => emit('lifehover', hover),
    (active) => {
      if (!itemInspection) {
        if (active) lifePause.pause(drawnLife, performance.now());
        else lifePause.resume(performance.now());
      }
      drawDirty = true;
    },
    (agent) => {
      if (!itemInspection) return;
      inspected =
        agent?.inspectionId === undefined
          ? undefined
          : { id: agent.inspectionId, generation: drawnLife?.generation };
      inspectionRevision++;
      drawDirty = true;
    },
  );
  let speechEnabled = options.speech ?? true;
  const speech = new SpeechController(readback, gl.COLOR_ATTACHMENT0, (cues) =>
    emit('speechchange', cues),
  );
  const speechSpeakers = {
    members: new Uint8Array(0),
    points: new Map<number, [number, number]>(),
  };
  let speechGeometry = 0;
  let gpuTimer = new GpuTimer(gl, options.gpuTiming ?? false);

  const cellDev = () => themeRes?.map.cellDev ?? { w: 1, h: 1 };
  const cssSize = () => ({ width: canvas.width / dpr, height: canvas.height / dpr });
  const view = (): View => ({
    camera,
    dpr,
    cellDev: cellDev(),
    labelDev: themeRes?.label.cellDev ?? { w: 1, h: 1 },
    detailZoom: detailZoom(camera.zoom, stepCell(schedule, step ?? 0).width),
    width: canvas.width,
    height: canvas.height,
  });

  /** Forget every glyph atlas (a new theme or pixel ratio); `resize` builds what it needs. */
  const dropGlyphs = (deleteTextures: boolean) => {
    if (deleteTextures) {
      for (const glyphs of mapGlyphs.values()) deleteMapGlyphs(gl, glyphs);
      if (labelGlyphs) deleteLabelGlyphs(gl, labelGlyphs);
    }
    mapGlyphs.clear();
    labelGlyphs = undefined;
    themeRes = undefined;
  };

  /** The glyphs for the current step, built the first time it is used. */
  const useGlyphs = () => {
    const at = step ?? 0;
    let map = mapGlyphs.get(at);
    if (!map) {
      map = createMapGlyphs(gl, theme, stepCell(schedule, at), dpr, font);
      mapGlyphs.set(at, map);
    }
    labelGlyphs ??= createLabelGlyphs(gl, labelCss, dpr, font);
    if (themeRes?.map !== map || themeRes.label !== labelGlyphs) {
      themeRes = { map, label: labelGlyphs, uniforms };
      cellDirty = true;
      cellsFor = null;
    }
  };

  const resize = () => {
    lifeHover.pointer(null);
    resetQualitySamples();
    const nextDpr = Math.min(window.devicePixelRatio || 1, knobs.maxDpr);
    const width = Math.max(1, Math.round(canvas.clientWidth * nextDpr));
    const height = Math.max(1, Math.round(canvas.clientHeight * nextDpr));
    if (nextDpr !== dpr) {
      dropGlyphs(dpr !== 0);
      dpr = nextDpr;
    }
    step = cellStep(schedule, camera.zoom, step);
    useGlyphs();
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const cols = Math.ceil(width / cellDev().w) + 3;
    const rows = Math.ceil(height / cellDev().h) + 3;
    const labelDev = view().labelDev;
    const labelCols = Math.ceil(width / labelDev.w) + 3;
    const labelRows = Math.ceil(height / labelDev.h) + 3;
    if (
      !targets ||
      targets.cols !== cols ||
      targets.rows !== rows ||
      targets.labelCols !== labelCols ||
      targets.labelRows !== labelRows
    ) {
      if (targets) deleteCellTargets(gl, targets);
      targets = createCellTargets(gl, cols, rows, labelCols, labelRows);
      targetsGeneration++;
      lifeHover.clear();
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
    cellsFor = null;
  };

  // Tiles
  const profiler = options.profiling ? new FrameProfiler() : undefined;
  const tileCache = new TileCache(
    gl,
    new URL(options.tilesUrl, canvas.ownerDocument.baseURI).href,
    () => {
      if (destroyed) return;
      cellDirty = true;
      cellsFor = null;
    },
    profiler,
  );
  const { source } = tileCache;

  const cellsKey = (v: View, map: GridPlacement, labels: GridPlacement) => {
    const a = screenArea(v, map.grid);
    const b = screenArea(v, labels.grid, v.labelDev);
    return [
      v.camera.zoom,
      map.grid.originCol,
      map.grid.originRow,
      labels.grid.originCol,
      labels.grid.originRow,
      a.left,
      a.top,
      a.right,
      a.bottom,
      b.left,
      b.top,
      b.right,
      b.bottom,
    ].join(' ');
  };
  /** Shift the cells for a pan within a cell, if that is all it takes; whether it was. */
  const shiftCells = (): boolean => {
    if (!targets || cellsFor === null || cellsTargets !== targets) return false;
    const v = view();
    const next = placeGrid(v, v.cellDev, targets.cols, targets.rows);
    const nextLabels = placeGrid(v, v.labelDev, targets.labelCols, targets.labelRows);
    if (cellsKey(v, next, nextLabels) !== cellsFor) return false;
    placement = next;
    grid = next.grid;
    labelGrid = nextLabels.grid;
    // Keep asking for the view's tiles (one that arrives draws the cells again).
    tileCache.tilesToDraw(camera, cssSize());
    return true;
  };

  const drawCells = () => {
    if (!targets || !programs || !themeRes) return;
    const v = view();
    placement = placeGrid(v, v.cellDev, targets.cols, targets.rows);
    grid = placement.grid;
    const labelPlacement = placeGrid(v, v.labelDev, targets.labelCols, targets.labelRows);
    labelGrid = labelPlacement.grid;
    cellsFor = cellsKey(v, placement, labelPlacement);
    cellsTargets = targets;
    const tiles = tileCache.tilesToDraw(camera, cssSize());
    syncLife(tiles);
    syncLamps(tiles);
    syncFixtures(tiles);
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
    crownTiles = layer(tiles);
    cellPass(gl, programs, targets, v, placement, { region, tiles: crownTiles });
    const placed = overlayPass(gl, targets, themeRes, v, labelPlacement, labels.values(), programs);
    speechGeometry++;
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
  const processions = options.processions ?? [];
  const moments = {
    dialogue: options.dialogue && dialogueChoices(options.dialogue),
    periods: options.dialogue?.periods,
  };
  const host =
    options.lifeWorker !== false && typeof Worker !== 'undefined'
      ? createWorkerHost({ ...options, itemInspection, moments }, processions, profiler)
      : (() => {
          const world = new LifeWorld(options.traffic, profiler, moments, itemInspection);
          world.setProcessions(processions);
          return createInlineHost(world, profiler);
        })();
  /** The procession last reported (`procession` event), as "id live". */
  let processionKey = '';
  const lifeView = () => lifePause.view(host.latest());
  const reportProcession = () => {
    const run = lifeView()?.procession;
    const key = run ? `${run.id} ${run.live}` : '';
    if (key === processionKey) return;
    processionKey = key;
    emit('procession', run ?? null);
  };
  const lifeActive = () => life.enabled && !reducedMotion;
  const lifeRunning = () => lifeActive() && !lost && watch.watched();
  let lifeInputs: LifeTile[] = [];
  /** Whether the life texture holds agents (so turning the layer off clears it once). */
  let lifeShown = false;
  let agentsDrawn = 0;

  const syncLife = (tiles: readonly TileId[]) => {
    if (!lifeActive()) {
      host.clearTiles();
      return;
    }
    const lifeTiles: LifeTile[] = [];
    for (const tile of tiles) {
      if (tile.z < LIFE_TILE_MIN_ZOOM) continue;
      const loaded = tileCache.get(tile);
      if (loaded) lifeTiles.push({ key: tileKey(tile), tile, life: loaded.life });
    }
    if (
      lifeTiles.length !== lifeInputs.length ||
      lifeTiles.some(
        (tile) => !lifeInputs.some((old) => old.key === tile.key && old.life === tile.life),
      )
    )
      lifeHover.pointer(null);
    lifeInputs = lifeTiles;
    const cell = stepCell(schedule, step ?? 0);
    host.sync(lifeTiles, [camera.lng, camera.lat], {
      bounds: viewBounds(),
      spawnMarginM: spawnMargin(metersPerCssPx(camera) * cell.width, cell.height / cell.width),
    });
  };

  /** The view's ground bounds, [west, south, east, north], kept while the camera and size stay. */
  let bounds: { camera: CameraState; width: number; height: number; at: LngLatBounds } | null =
    null;
  const viewBounds = (): LngLatBounds => {
    const { width, height } = cssSize();
    if (bounds?.camera !== camera || bounds.width !== width || bounds.height !== height) {
      const [[west, south], [east, north]] = viewportFor(camera, { width, height }).getBounds() as [
        [number, number],
        [number, number],
      ];
      bounds = { camera, width, height, at: [west, south, east, north] };
    }
    return bounds.at;
  };

  /** The agents last drawn, whose headlights throw beams at night (`drawLights`). */
  let lifeAgents: VisibleAgent[] = [];
  const drawLife = (at: number, wind: WindNow) => {
    if (!targets || !themeRes || !placement) return;
    let agents: VisibleAgent[] = [];
    if (lifeActive()) {
      // How hard the wind blows in a tree's crown at a place, on the grid's cells (select pass);
      // `wind` is the frame's, taken at this same `at`.
      const time = (at - start) / 1000;
      // Wind reactions and clearance use the CSS schedule, never a rounded drawing DPR.
      const cssCell = stepCell(schedule, step ?? 0);
      const size = cssSize();
      const accepted =
        !lifePause.inspecting &&
        host.request({
          ...(itemInspection
            ? {
                inspection: {
                  id: inspected?.id ?? null,
                  revision: inspectionRevision,
                  time: lifePause.time,
                },
              }
            : {}),
          gust: { camera, size, cssCell: { w: cssCell.width, h: cssCell.height }, time, wind },
          step: {
            dt: lifePause.delta,
            zoom: camera.zoom,
            bounds: viewBounds(),
            wind: worldWind(time),
            weather: { rain: currentRain(), minutes: cityMinutes, cityLife: options.cityLife },
            cellMeters: metersPerCssPx(camera) * cssCell.width,
          },
          visible: [
            camera.zoom,
            activity,
            [camera.lng, camera.lat],
            { rain: currentRain(), sunAltitude: sun?.altitude ?? 0 },
            viewBounds(),
            knobs.crowd,
            knobs.maxAgents,
          ],
        });
      if (accepted) lifePause.accept();
      drawnLife = lifeView();
      if (inspected && drawnLife?.generation !== inspected.generation) lifeHover.clear();
      agents = drawnLife?.agents ?? [];
      reportProcession();
    } else if (!lifeShown) {
      return;
    }
    // Nothing out, and the texture already empty: nothing to upload.
    if (agents.length === 0 && !lifeShown) {
      agentsDrawn = 0;
      lifeAgents = agents;
      return;
    }
    const trackSpeech = options.dialogue && speechEnabled && camera.zoom >= MOMENTS.zoom;
    if (trackSpeech && speechSpeakers.members.length !== targets.cols * targets.rows)
      speechSpeakers.members = new Uint8Array(targets.cols * targets.rows);
    agentsDrawn = lifePass(
      gl,
      targets,
      themeRes,
      theme,
      view(),
      placement,
      agents,
      knobs.shadows ? sun : null,
      profiler,
      drawnLife?.cellGuard(placement.toCell),
      focus.life,
      itemInspection ? drawnLife?.agents : lifePause.inspecting ? drawnLife : undefined,
      trackSpeech ? speechSpeakers : undefined,
    );
    lifeShown = agents.length > 0;
    lifeAgents = agents;
  };
  const reportSpeech = (now: number) => {
    const raster = targets && lifeRaster(targets);
    if (
      !raster ||
      !speechEnabled ||
      now - lastInput < 150 ||
      !options.dialogue ||
      !lifeActive() ||
      !watch.watched() ||
      camera.zoom < MOMENTS.zoom ||
      !targets ||
      !placement ||
      !lifeAgents.length ||
      speechSpeakers.members.length !== raster.owners.length
    ) {
      speech.clear();
      return;
    }
    const cell = cellDev(),
      label = themeRes!.label.cellDev;
    speech.update(
      {
        targets,
        dpr,
        agents: lifeAgents,
        owners: raster.owners,
        speakers: speechSpeakers,
        life: raster.life,
        geometry: `${targetsGeneration}/${speechGeometry}/${camera.lng}/${camera.lat}/${camera.zoom}`,
        grid: { shiftX: grid.shiftX, shiftY: grid.shiftY, cellWidth: cell.w, cellHeight: cell.h },
        toCell: placement.toCell,
        size: cssSize(),
        labelsCover: ([x, y]) =>
          labelCovers(
            targets!,
            (x * dpr + labelGrid.shiftX) / label.w,
            (y * dpr + labelGrid.shiftY) / label.h,
          ),
      },
      now,
    );
  };

  // Streetlights (life/lights.ts): the lamps of the tiles on screen, lit from dusk. They are
  // lighting, like windows, so they show with the life layer off and with reduced motion too.
  let lamps: VisibleLamp[] = [];
  /** The shops on screen, each with its own hours, and which of them are open (by index). */
  let shops: { lamp: VisibleLamp; hours: ShopHours }[] = [];
  let shopsKey = '';
  /** The city's local time, minutes past midnight (`updateSun`), for shops' hours. */
  let cityMinutes = 12 * 60;
  /**
   * The lamps lit now (street and flood lamps, and the open shops) and which shops are open, as
   * a key; worked out again only when the lamps or the city's minute change.
   */
  let lit = { lamps, shops, minutes: NaN, all: [] as VisibleLamp[], key: '' };
  const litNow = () => {
    if (lit.lamps !== lamps || lit.shops !== shops || lit.minutes !== cityMinutes) {
      const open = shops.map((s) => shopOpen(s.hours, cityMinutes));
      lit = {
        lamps,
        shops,
        minutes: cityMinutes,
        all: [...lamps, ...shops.filter((_, i) => open[i]).map((s) => s.lamp)],
        key: open.map((o) => (o ? '1' : '0')).join(''),
      };
    }
    return lit;
  };
  /** Whether the light texture holds lamps (so it is cleared once when they go). */
  let lampsShown = false;
  const lampShow = () => bandVisibility(STREETLIGHT.zoom, camera.zoom);
  /** Each loaded tile's shops and lamps, placed once (by its life data, dropped with it). */
  const tileLights = new WeakMap<
    LoadedTile['life'],
    { shops: { lamp: VisibleLamp; hours: ShopHours }[]; lamps: VisibleLamp[] }
  >();
  const lightsOf = (tile: TileId, life: LoadedTile['life']) => {
    const cached = tileLights.get(life);
    if (cached) return cached;
    const tileShops: { lamp: VisibleLamp; hours: ShopHours }[] = [];
    const tileLamps: VisibleLamp[] = [];
    // Shops and markets: lit while open, each by its own hours (shared rhythm.ts shopHours).
    const shopsHere = life.shops;
    for (let i = 0; shopsHere && i < shopsHere.length; i += SHOP_STRIDE) {
      const x = shopsHere[i]!;
      const y = shopsHere[i + 1]!;
      const perMeter = 1 / metersPerUnit(tile);
      const reach = Math.min(shopsHere[i + 2]!, SHOP.maxRadius * perMeter) + SHOP.spill * perMeter;
      const at = tileToLngLat(tile, { x, y });
      const seed = placeSeed((tile.x * EXTENT + x) / perMeter, (tile.y * EXTENT + y) / perMeter);
      tileShops.push({
        lamp: {
          lng: at[0],
          lat: at[1],
          center: at,
          pool: at,
          east: tileToLngLat(tile, { x: x + reach, y }),
          north: tileToLngLat(tile, { x, y: y - reach }),
          state: LampState.shop,
          seed: seed & 31,
        },
        hours: shopHours(seed, options.cityLife),
      });
    }
    // Floodlit landmarks: a wash of light over each footprint, and a little past it.
    const floods = life.floods;
    for (let i = 0; floods && i < floods.length; i += FLOOD_STRIDE) {
      const x = floods[i]!;
      const y = floods[i + 1]!;
      const perMeter = 1 / metersPerUnit(tile);
      const reach = Math.min(floods[i + 2]!, FLOOD.maxRadius * perMeter) + FLOOD.spill * perMeter;
      const at = tileToLngLat(tile, { x, y });
      tileLamps.push({
        lng: at[0],
        lat: at[1],
        center: at,
        pool: at,
        east: tileToLngLat(tile, { x: x + reach, y }),
        north: tileToLngLat(tile, { x, y: y - reach }),
        state: LampState.flood,
        seed: 0,
      });
    }
    const found = life.lamps;
    const radius = STREETLIGHT.radius / metersPerUnit(tile);
    for (let i = 0; i < found.length; i += LAMP_STRIDE) {
      const [lng, lat] = tileToLngLat(tile, { x: found[i]!, y: found[i + 1]! });
      // The pool, centered out over the road.
      const x = found[i + 4]!;
      const y = found[i + 5]!;
      tileLamps.push({
        lng,
        lat,
        center: tileToLngLat(tile, { x: found[i + 6]!, y: found[i + 7]! }),
        pool: tileToLngLat(tile, { x, y }),
        east: tileToLngLat(tile, { x: x + radius, y }),
        north: tileToLngLat(tile, { x, y: y - radius }),
        state: found[i + 2]! as LampStateValue,
        seed: found[i + 3]!,
      });
    }
    const placed = { shops: tileShops, lamps: tileLamps };
    tileLights.set(life, placed);
    return placed;
  };
  const syncLamps = (tiles: readonly TileId[]) => {
    lamps = [];
    shops = [];
    shopsKey = '';
    if (lampShow() <= 0) return;
    for (const tile of tiles) {
      if (tile.z < LIFE_TILE_MIN_ZOOM) continue;
      const loaded = tileCache.get(tile);
      if (!loaded) continue;
      const placed = lightsOf(tile, loaded.life);
      for (const shop of placed.shops) shops.push(shop);
      for (const lamp of placed.lamps) lamps.push(lamp);
    }
  };
  let fixtures: StreetFixture[] = [];
  const fixtureTiles = new WeakMap<LoadedTile['life'], StreetFixture[]>();
  let fixturesKey = '';
  const cachedUtilities = createUtilityFixtureCache();
  let fixtureInputs: readonly LoadedTile[] = [];
  let hadUtilities = false;
  const syncFixtures = (tiles: readonly TileId[]) => {
    if (camera.zoom < 15) {
      fixtures = [];
      fixtureInputs = [];
      hadUtilities = false;
      return;
    }
    const inputs = tiles
      .filter((tile) => tile.z >= LIFE_TILE_MIN_ZOOM)
      .map((tile) => tileCache.get(tile))
      .filter((t): t is LoadedTile => !!t);
    const showUtilities =
      options.utilities?.derive === true && bandVisibility(UTILITY_ZOOM, camera.zoom) > 0;
    if (showUtilities === hadUtilities && sameReferenceMembers(inputs, fixtureInputs)) return;
    fixtureInputs = inputs;
    hadUtilities = showUtilities;
    fixtures = [];
    for (const tile of tiles) {
      if (tile.z < LIFE_TILE_MIN_ZOOM) continue;
      const loaded = tileCache.get(tile);
      if (!loaded) continue;
      let found = fixtureTiles.get(loaded.life);
      if (!found) {
        found = tileFixtures(tile, loaded.life);
        fixtureTiles.set(loaded.life, found);
      }
      fixtures.push(...found);
    }
    const utilityGroups = showUtilities
      ? inputs.flatMap((t) => (t.utilities ? [t.utilities] : []))
      : [];
    fixtures.push(...cachedUtilities(utilityGroups));
  };
  const drawFixtures = (cellsDrawn: boolean, time: number, wind: WindNow) => {
    if (!targets || !themeRes || !placement) return;
    const visible = fixturePass(
      gl,
      targets,
      themeRes,
      view(),
      placement,
      fixtures,
      lifeView()?.signalClock ?? 0,
      cellsDrawn,
      { time, strength: wind.strength },
    );
    const key = `${visible.streetlights} ${visible.trafficSignals} ${visible.utilities}`;
    if (key !== fixturesKey) {
      fixturesKey = key;
      emit('fixtureschange', visible);
    }
  };
  /** Whether the light texture holds headlight beams (so they are cleared once they go). */
  let beamsShown = false;
  /**
   * Put the lamps on the grid when it moves or they come on, and the moving vehicles' headlight
   * beams every frame they are out; clear them once they go. Tells the legend when the lamps
   * come on or go (`lightschange`).
   */
  const drawLights = (cellsDrawn: boolean) => {
    if (!targets || !placement) return;
    // Lit from dusk (shaders/glyph.ts `lamps()`).
    const on = lampShow() > 0 && daylight < 0.75;
    const beams = on && lifeAgents.length > 0 && knobs.beams;
    const changed = on !== lampsShown;
    // A shop opening or closing packs the lamps again.
    const key = on ? litNow().key : '';
    const shopsChanged = key !== shopsKey;
    shopsKey = key;
    if (!changed && !shopsChanged && !(on && cellsDrawn) && !beams && !beamsShown) {
      effectClockPass(gl, targets);
      return;
    }
    lightPass(
      gl,
      targets,
      view(),
      placement,
      on ? litNow().all : [],
      beams ? lifeAgents : [],
      changed || shopsChanged || cellsDrawn,
    );
    lampsShown = on;
    beamsShown = beams;
    if (changed) emit('lightschange', on);
  };

  // The time of day the map is lit for (life/sun.ts) and how much traffic is out
  // (life/config.ts), worked out again every `SUN_MS`.
  let daylight = 1;
  /** How much moonlight falls (life/moon.ts), 0–1. */
  let moon = 0;
  let activity: Activity = activityLevels(1);
  /** The sun the map's shadows fall from (none at night). */
  let sun: Sun | null = null;
  let lastSun = -Infinity;
  let liveOccurrence: string | undefined;
  const updateSun = (at: number) => {
    if (at - lastSun < SUN_MS) return;
    lastSun = at;
    // A procession under way by its schedule, when the map follows the real clock.
    let live: { id: string; progress: number } | undefined;
    let occurrence: string | undefined;
    let duration = 1;
    if (life.time === 'live') {
      for (const route of processions) {
        const date = now();
        const progress = liveProgress(route.schedule, date);
        if (progress !== undefined) {
          const local = cityTime(date, { ...zone, timezone: route.schedule.timezone });
          occurrence = `${route.id}/${local.year}`;
          duration = route.schedule.duration_min * 60;
          live = { id: route.id, progress };
          break;
        }
      }
    }
    if (occurrence !== liveOccurrence) {
      lifeHover.pointer(null);
      livePause.reset();
      liveOccurrence = occurrence;
    }
    if (live && occurrence)
      live.progress = livePause.progress(
        occurrence,
        live.progress,
        duration,
        lifePause.pausedSeconds(at),
      );
    else livePause.reset();
    host.setLive(live?.id, live?.progress, occurrence);
    // The moment the map shows: now, or today at the fixed time in the city.
    const moment = life.time === 'live' ? now() : atCityMinutes(now(), zone, life.time);
    const position = solarPosition(moment, camera.lng, camera.lat);
    const next = daylightAt(position.altitude);
    const nextMoon = moonlight(moment, camera.lng, camera.lat);
    const local = cityTime(moment, zone);
    cityMinutes = local.minutes;
    cityMonth = cityTime(now(), zone).month;
    const nextActivity = activityLevels(next, {
      minutes: local.minutes,
      weekday: local.weekday,
      life: options.cityLife,
    });
    // Shadows follow the sun while it is up.
    const nextSun = position.altitude > 0 ? position : null;
    const moved = activityChanged(nextActivity, activity);
    if (
      moved ||
      Math.abs(next - daylight) > 0.001 ||
      Math.abs(nextMoon - moon) > 0.001 ||
      Math.abs((nextSun?.azimuth ?? 0) - (sun?.azimuth ?? 0)) > 0.01 ||
      Math.abs((nextSun?.altitude ?? 0) - (sun?.altitude ?? 0)) > 0.01 ||
      !nextSun !== !sun
    ) {
      daylight = next;
      moon = nextMoon;
      activity = nextActivity;
      sun = nextSun;
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
    lifeHover.pointer(null);
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
    ({ point, click, index: hit, camera: at, size }: PickResult) => {
      // A feature that isn't interactive counts as a miss: no highlight, and no feature reported.
      const picked = source.feature(hit);
      const found = picked?.parentId ? source.featureById(picked.parentId) : picked;
      const feature = found && interactive(found) ? found : null;
      const featureId = feature?.id ?? null;
      const index = feature ? source.indexOf(feature.id) : 0;
      if (click) {
        const [lng, lat] = viewportFor(at, size).unproject([...point]) as [number, number];
        emit('click', { featureId, feature, point, lngLat: [lng, lat] });
      } else if (pointerOver && index !== hoverIndex) {
        canvas.style.cursor = feature ? 'pointer' : '';
        hoverIndex = index;
        drawDirty = true;
        emit('hover', { featureId, feature, point });
      }
    },
  );

  let raf = 0;
  const frame = (now: number) => {
    if (destroyed || lost) return;
    lifePause.tick(now, lifeRunning());
    profiler?.begin(now);
    raf = requestAnimationFrame(frame);
    gpuTimer.poll();
    if (previousDraw && watch.watched()) {
      quality.sample({
        at: now,
        intervalMs: now - previousDraw.at,
        cpuMs: previousDraw.cpuMs,
        gpuMs: gpuTimer.milliseconds,
      });
    }
    previousDraw = undefined;
    // Zooming across a cell size step rebuilds the grid at the new size (density.ts).
    if (step !== undefined && cellStep(schedule, camera.zoom, step) !== step) sizeDirty = true;
    if (sizeDirty) {
      sizeDirty = false;
      resize();
    }
    advanceFlight(now);
    const nextTier = quality.decide(now, !flight && now - lastInput >= 1000);
    if (nextTier !== undefined) {
      const nextKnobs = TIERS[nextTier]!.knobs;
      if (nextKnobs.maxDpr !== knobs.maxDpr) sizeDirty = true;
      knobs = nextKnobs;
      drawDirty = true;
      resetQualitySamples();
      emit('qualitychange', quality.state);
      if (sizeDirty) {
        sizeDirty = false;
        resize();
      }
    }
    if (cameraMoved) {
      cameraMoved = false;
      emit('camerachange', { ...camera });
    }
    updateSun(now);
    if (!targets || !programs || !themeRes) {
      profiler?.end();
      return;
    }
    const animating = animationDue(now, lastDraw, lastInput, {
      reducedMotion,
      watched: watch.watched(),
    });
    if (cellDirty || drawDirty || animating) {
      const time = (now - start) / 1000;
      const frameStart = performance.now();
      gpuTimer.begin(now);
      let cellsDrawn = false;
      if (cellDirty) {
        cellDirty = false;
        if (!shiftCells()) {
          drawCells();
          cellsDrawn = true;
          cellPassMs = smooth(cellPassMs, performance.now() - frameStart);
        }
      }
      const v = view();
      const wind = worldWind(time);
      // Tree crowns go over the cells, and sway every frame while the wind blows through them.
      const swaying =
        knobs.crownSway &&
        !reducedMotion &&
        wind.strength > 0 &&
        hasCrowns(crownTiles) &&
        bandVisibility(CLASS_ZOOM.tree, camera.zoom) > 0;
      if (placement && (cellsDrawn || swaying)) {
        const crownStart = performance.now();
        crownPass(gl, programs, targets, v, placement, crownTiles, time, wind);
        crownPassMs = smooth(crownPassMs, performance.now() - crownStart);
      }
      selectPass(
        gl,
        programs,
        targets,
        themeRes,
        v,
        grid,
        reducedMotion ? 0 : time,
        highlights(),
        knobs.groundWind ? wind : { ...wind, strength: 0 },
        sun,
        knobs.shadows,
      );
      const lifeStart = performance.now();
      drawLife(now, wind);
      lifeMs = smooth(lifeMs, performance.now() - lifeStart);
      drawLights(cellsDrawn);
      drawFixtures(cellsDrawn, time, wind);
      glyphPass(
        gl,
        programs,
        targets,
        themeRes,
        theme,
        v,
        grid,
        labelGrid,
        time,
        reducedMotion,
        daylight,
        {
          rain: currentRain(),
          wind,
          detail: camera.zoom >= 18 && knobs.waterDetail,
          fish: lifeActive() && camera.zoom >= 18 && knobs.fish,
        },
        lampShow(),
        moon,
        sun,
        focus,
        lifePause.time,
      );
      drawDirty = false;
      streetTextPass(gl, programs, themeRes, theme, v, labelGrid);
      gpuTimer.end();
      lastDraw = now;
      frameMs = smooth(frameMs, performance.now() - frameStart);
      if (!qualityWarmupDraw) previousDraw = { at: now, cpuMs: performance.now() - frameStart };
      qualityWarmupDraw = false;
      profiler?.draw(performance.now() - frameStart, agentsDrawn);
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
    // Deliver reads after drawing and issuing prioritized picks/class queries so a slow
    // frame cannot consume freshly confirmed speech before it is published.
    readback.poll();
    const raster = lifeRaster(targets);
    lifeHover.update(
      lifeHover.hasPointer && lifeShown && lifeActive() && !flight && watch.watched() && raster
        ? {
            targets,
            generation: drawnLife?.generation,
            grid: {
              shiftX: grid.shiftX,
              shiftY: grid.shiftY,
              cellWidth: cellDev().w,
              cellHeight: cellDev().h,
            },
            dpr,
            geometry: `${targetsGeneration}/${camera.lng}/${camera.lat}/${camera.zoom}/${grid.originCol}/${grid.originRow}/${grid.shiftX}/${grid.shiftY}/${dpr}/${cellDev().w}/${cellDev().h}`,
            revision: raster.revision,
            owners: raster.owners,
            life: raster.life,
            agents: lifeAgents,
            labelsCover: (point) =>
              labelsCoverPoint(targets!, point, dpr, {
                shiftX: labelGrid.shiftX,
                shiftY: labelGrid.shiftY,
                cellWidth: view().labelDev.w,
                cellHeight: view().labelDev.h,
              }),
          }
        : null,
      performance.now(),
    );
    reportSpeech(performance.now());
    profiler?.end();
  };
  raf = requestAnimationFrame(frame);

  // A lost context (GPU reset, too many contexts, a backgrounded mobile tab) takes every GPU
  // handle with it. Ask for it back, then rebuild everything; the tiles are fetched again.
  const onContextLost = (event: Event) => {
    event.preventDefault();
    if (lost) return;
    lost = true;
    lifeHover.pointer(null);
    lifePause.tick(performance.now(), false);
    speech.clear();
    canvas.style.cursor = '';
    hoverIndex = 0;
    emit('hover', { featureId: null, feature: null, point: null });
    cancelAnimationFrame(raf);
    programs = undefined;
    dropGlyphs(false);
    targets = undefined;
    targetsGeneration++;
    readback.reset(true);
    gpuTimer.reset(true);
    resetQualitySamples();
    profiler?.reset();
    tileCache.suspend();
    fixtures = [];
    fixtureInputs = [];
    cachedUtilities([]);
    fixturesKey = '';
    emit('fixtureschange', { streetlights: false, trafficSignals: false, utilities: false });
    emit('contextlost', undefined);
  };
  const onContextRestored = () => {
    if (!lost || destroyed) return;
    lost = false;
    lifePause.tick(performance.now(), lifeRunning());
    resetQualitySamples();
    gpuRenderer = readGpuRenderer();
    programs = createPrograms(gl);
    gpuTimer = new GpuTimer(gl, options.gpuTiming ?? false);
    tileCache.resume();
    // `resize` rebuilds the theme resources and render targets.
    sizeDirty = true;
    cellDirty = true;
    raf = requestAnimationFrame(frame);
    emit('contextrestored', undefined);
  };
  canvas.addEventListener('webglcontextlost', onContextLost);
  canvas.addEventListener('webglcontextrestored', onContextRestored);

  // The map moves on its own only while someone can watch it (pacing.ts); back in view, the
  // agents carry on from where they stood.
  const watch = watchVisibility(canvas, (watched) => {
    resetQualitySamples();
    if (!watched) lifeHover.pointer(null);
    lifePause.tick(performance.now(), watched && lifeActive() && !lost);
    if (!watched) speech.clear();
  });

  /** Input moved the camera since the last frame: `camerachange` goes out once, from `frame`. */
  let cameraMoved = false;
  /** Move the camera; input (`batched`) tells of it once a frame, however many events came. */
  const applyCamera = (next: CameraState, batched = false) => {
    lifeHover.pointer(null);
    speech.clear();
    camera = clampCamera(next, limits, dpr > 0 ? cssSize() : undefined);
    cellDirty = true;
    lastInput = performance.now();
    if (batched) cameraMoved = true;
    else emit('camerachange', { ...camera });
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
    pan: byUser((dx: number, dy: number) => applyCamera(panBy(camera, dx, dy), true)),
    zoom: byUser((delta: number, anchor: [number, number]) => {
      const zoom = Math.min(limits.maxZoom, Math.max(limits.minZoom, camera.zoom + delta));
      applyCamera(zoomAround(camera, zoom, anchor), true);
    }),
    hover: (point) => {
      lifeHover.pointer(flight ? null : point);
      pointerOver = point !== null;
      if (!point) canvas.style.cursor = '';
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
    setFocus(input) {
      const next = normalizeFocus(input);
      if (next.key === focus.key) return;
      focus = next;
      drawDirty = true;
    },
    setSpeech(enabled) {
      if (speechEnabled === enabled) return;
      speechEnabled = enabled;
      if (!enabled) speech.clear();
      drawDirty = true;
    },
    setQuality(choice) {
      quality.setChoice(choice);
    },
    getQuality: () => quality.choice,
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
    setReducedMotion(enabled) {
      speech.clear();
      if (reducedMotion === enabled) return;
      reducedMotion = enabled;
      lifeHover.pointer(null);
      lifePause.tick(performance.now(), lifeRunning());
      if (enabled) host.clearTiles();
      lastSun = -Infinity;
      cellDirty = true;
      cellsFor = null;
      drawDirty = true;
      if (enabled && flight) {
        const destination = flight.path.at(1);
        flight = null;
        cameraMoved = false;
        applyCamera(destination);
        emit('flyend', { ...camera });
      }
    },
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
      quality: quality.state,
      fps: drawTimes.length,
      frameMs,
      gpuFrameMs: gpuTimer.milliseconds,
      cellPassMs,
      crownPassMs,
      lifeMs,
      tilesLoaded: tileCache.size,
      tilesPending: source.pendingCount,
      decodeMs: source.decodeMsAverage,
      agents: agentsDrawn,
    }),
    getProfile: () => profiler?.snapshot(gpuRenderer) ?? null,
    resetProfile: () => profiler?.reset(),
    setLife(settings) {
      lifeHover.pointer(null);
      if (settings.time !== undefined && settings.time !== life.time) livePause.reset();
      life = { ...life, ...settings };
      lifePause.tick(performance.now(), lifeRunning());
      speech.clear();
      if (!lifeActive()) host.clearTiles();
      lastSun = -Infinity;
      // Spawn or drop agents for the tiles on screen.
      cellDirty = true;
      cellsFor = null;
    },
    getLife: () => ({ ...life }),
    playProcession(id) {
      if (!lifeActive() || !host.play(id)) return false;
      lifeHover.pointer(null);
      lastSun = -Infinity;
      drawDirty = true;
      return true;
    },
    stopProcession() {
      lifeHover.pointer(null);
      lastSun = -Infinity;
      host.stop();
      drawDirty = true;
    },
    setYear() {
      // Phase 4: time filtering.
    },
    setTheme(name) {
      lifeHover.pointer(null);
      theme = themes[name];
      uniforms = themeUniforms(theme);
      // `resize` builds the new theme's glyphs (on restore, while the context is lost).
      dropGlyphs(!lost);
      sizeDirty = true;
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
      lifeHover.pointer(null);
      speech.clear();
      host.dispose();
      destroyed = true;
      canvas.style.cursor = '';
      cancelAnimationFrame(raf);
      observer.disconnect();
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
      watch.detach();
      detachInput();
      tileCache.destroy();
      readback.reset(lost);
      gpuTimer.reset(lost);
      profiler?.reset();
      if (!lost) {
        if (targets) deleteCellTargets(gl, targets);
        dropGlyphs(true);
        if (programs) deletePrograms(gl, programs);
      }
      listeners.clear();
    },
  };
}
