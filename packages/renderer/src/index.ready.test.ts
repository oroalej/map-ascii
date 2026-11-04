// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAtlas, type Atlas } from './index';
import type * as GpuModule from './gpu';
import type * as PassesModule from './passes';
import type * as FolkloreModule from './folklore-pass';
import type * as PacingModule from './pacing';
import { LifeBuilder } from './life/geometry';
import type { LoadedTile } from './tile-cache';
import { cellPass, glyphPass, streetTextPass } from './passes';
import { fireworksPass } from './fireworks-pass';
import { createMorphSnapshot, morphPass, releaseMorph } from './morph';
import {
  bloomCompositePass,
  bloomExtractPass,
  bloomStrength,
  createBloomTarget,
  releaseBloom,
} from './bloom';
import * as Hosts from './life/host';

const fixture = vi.hoisted(() => ({
  view: undefined as LoadedTile | undefined,
  region: undefined as LoadedTile | undefined,
  arrive: () => {},
  url: '',
  /** What `programs.boot.poll` answers in turn; empty means no boot shaders at all. */
  bootStages: [] as string[],
  drewTiles: vi.fn(),
  /** Whether the morph program has linked, and what the pass answers. */
  morphProgram: undefined as object | undefined,
  morphRunning: true,
  bloomStrength: 0,
  createMapGlyphs: vi.fn(() => ({ cellDev: { w: 10, h: 18 }, atlas: { index: () => 0 } })),
}));
vi.mock('./optional-programs', () => ({ optionalProgram: () => fixture.morphProgram }));
vi.mock('./bloom', () => ({
  bloomStrength: vi.fn(() => fixture.bloomStrength),
  bloomPrograms: () => fixture.morphProgram && { extract: {}, blur: {}, add: {} },
  createBloomTarget: vi.fn(() => ({ cols: 0, rows: 0, lit: { framebuffer: 'lit' }, blurred: {} })),
  releaseBloom: vi.fn(),
  bloomExtractPass: vi.fn(),
  bloomCompositePass: vi.fn(),
  sparkViewport: () => [0, 0, 1, 1],
}));
vi.mock('./morph', () => ({
  morphFragment: '',
  createMorphSnapshot: vi.fn(() => ({ framebuffer: 'snapshot fbo', blankOverlay: 'blank' })),
  morphPass: vi.fn(() => fixture.morphRunning),
  releaseMorph: vi.fn(),
}));
vi.mock('./gpu-context', () => ({
  createPrograms: () => {
    const programs: { streetText: { count: number }; boot?: object } = {
      streetText: { count: 0 },
    };
    if (fixture.bootStages.length > 0)
      programs.boot = {
        poll: () => fixture.bootStages.shift(),
        commit: () => {
          programs.boot = undefined;
        },
        drewTiles: fixture.drewTiles,
      };
    return programs;
  },
  deletePrograms: vi.fn(),
  prewarmGlyphPrograms: vi.fn(),
  createMapGlyphs: fixture.createMapGlyphs,
  createLabelGlyphs: () => ({ cellDev: { w: 10, h: 18 }, atlas: { index: () => 0 } }),
  deleteMapGlyphs: vi.fn(),
  deleteLabelGlyphs: vi.fn(),
}));
vi.mock('./gpu', async (load) => ({
  ...(await load<typeof GpuModule>()),
  createCellTargets: (
    _gl: unknown,
    cols: number,
    rows: number,
    labelCols: number,
    labelRows: number,
  ) => ({ cols, rows, labelCols, labelRows }),
  deleteCellTargets: vi.fn(),
  uploadEffectClocks: vi.fn(),
}));
vi.mock('./passes', async (load) => ({
  ...(await load<typeof PassesModule>()),
  cellPass: vi.fn(),
  crownPass: vi.fn(),
  selectPass: vi.fn(),
  glyphPass: vi.fn(),
  streetTextPass: vi.fn(),
  overlayPass: vi.fn(() => []),
  lifePass: vi.fn(() => 0),
  effectClockPass: vi.fn(),
  lifeRaster: vi.fn(() => null),
  lightPass: vi.fn(),
  fixturePass: vi.fn(() => ({ streetlights: false, trafficSignals: false, utilities: false })),
}));
vi.mock('./fireworks-pass', () => ({ fireworksPass: vi.fn() }));
vi.mock('./folklore-pass', async (load) => ({
  ...(await load<typeof FolkloreModule>()),
  folklorePass: vi.fn(),
}));
vi.mock('./tile-cache', () => ({
  TileCache: class {
    source = {
      indexOf: () => 0,
      featureById: () => undefined,
      pendingCount: 0,
      decodeMsAverage: 0,
      setFireworksActive() {},
    };
    size = 0;
    constructor(_gl: unknown, url: string, arrive: () => void) {
      fixture.url = url;
      fixture.arrive = arrive;
    }
    tilesToDraw() {
      return fixture.view ? [{ z: 16, x: 32768, y: 32768 }] : [];
    }
    regionTilesForView() {
      return fixture.region ? [{ z: 11, x: 1024, y: 1024 }] : [];
    }
    get(tile: { z: number }) {
      return tile.z === 11 ? fixture.region : fixture.view;
    }
    residentialSitesFor() {
      return [];
    }
    suspend() {
      fixture.view = fixture.region = undefined;
    }
    resume() {}
    destroy() {}
  },
}));
vi.mock('./readback', () => ({
  MAX_PENDING_READS: 8,
  Readback: class {
    size = 0;
    poll() {}
    reset() {}
    request() {}
  },
}));
vi.mock('./picking', () => ({
  MAX_HIGHLIGHT: 64,
  Picker: class {
    issue() {}
    hover() {}
    cancelHover() {}
  },
}));
vi.mock('./input', () => ({ attachInput: () => () => {} }));
vi.mock('./pacing', async (load) => ({
  ...(await load<typeof PacingModule>()),
  watchVisibility: () => ({ watched: () => true, detach() {} }),
}));

let atlas: Atlas, canvas: HTMLCanvasElement, time: number;
let nextId = 0;
const turns = new Map<number, FrameRequestCallback>();
const draw = (at: number) => {
  time = at;
  const queued = [...turns.values()];
  turns.clear();
  queued.forEach((callback) => callback(at));
};
const tile = () =>
  ({
    mesh: { crowns: { count: 0 } },
    labels: [],
    life: new LifeBuilder().finish(),
  }) as unknown as LoadedTile;
beforeEach(() => {
  vi.clearAllMocks();
  fixture.view = fixture.region = undefined;
  fixture.bootStages = [];
  fixture.morphProgram = undefined;
  fixture.morphRunning = true;
  fixture.bloomStrength = 0;
  time = 0;
  turns.clear();
  vi.spyOn(performance, 'now').mockImplementation(() => time);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    turns.set(++nextId, callback);
    return nextId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => turns.delete(id));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  canvas = document.createElement('canvas');
  Object.defineProperties(canvas, { clientWidth: { value: 400 }, clientHeight: { value: 300 } });
  vi.spyOn(canvas, 'getContext').mockReturnValue({
    getExtension: () => null,
    isContextLost: () => false,
  } as unknown as WebGL2RenderingContext);
  atlas = createAtlas(canvas, {
    tilesUrl: '/tiles/fixture.pmtiles?existing=yes',
    tilesVersion: '1234abcd',
    bounds: [-1, -1, 1, 1],
    initialCamera: { lng: 0, lat: 0, zoom: 18 },
    year: 2026,
    life: { enabled: false },
  });
});
afterEach(() => {
  atlas.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(['view', 'region'] as const)(
  'becomes ready only after a completed %s canvas frame, once per context',
  (layer) => {
    const ready = vi.fn(() => {
      expect(glyphPass).toHaveBeenCalled();
      expect(streetTextPass).toHaveBeenCalled();
      expect(atlas.getStats().readyMs).not.toBeNull();
    });
    const mark = vi.fn();
    vi.stubGlobal('performance', { now: () => time, mark });
    atlas.on('ready', ready);
    draw(100);
    expect(ready).not.toHaveBeenCalled();
    expect(atlas.getStats().readyMs).toBeNull();
    fixture[layer] = tile();
    fixture.arrive();
    draw(200);
    expect(ready).toHaveBeenCalledExactlyOnceWith({ firstTileFrame: 200 });
    expect(mark.mock.calls.filter(([name]) => name === 'atlas:ready')).toHaveLength(1);
    expect(atlas.getStats().detailReadyMs).toBe(200);
    draw(300);
    expect(ready).toHaveBeenCalledTimes(1);
    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    expect(atlas.getStats().readyMs).toBeNull();
    canvas.dispatchEvent(new Event('webglcontextrestored'));
    draw(400);
    expect(ready).toHaveBeenCalledTimes(1);
    fixture[layer] = tile();
    fixture.arrive();
    draw(500);
    expect(ready).toHaveBeenCalledTimes(2);
    expect(cellPass).toHaveBeenCalled();
  },
);
it('draws boot frames while the full shaders compile, and marks each readiness once', () => {
  atlas.destroy();
  vi.clearAllMocks();
  fixture.bootStages = ['wait', 'grace', 'boot', 'boot', 'full'];
  atlas = createAtlas(canvas, {
    tilesUrl: '/fixture.pmtiles',
    bounds: [-1, -1, 1, 1],
    initialCamera: { lng: 0, lat: 0, zoom: 18 },
    year: 2026,
    life: { enabled: false },
  });
  const ready = vi.fn();
  const detail = vi.fn();
  atlas.on('ready', ready);
  atlas.on('detailready', detail);
  fixture.view = tile();
  fixture.arrive();
  // Nothing has linked: nothing draws.
  draw(100);
  expect(cellPass).not.toHaveBeenCalled();
  expect(glyphPass).not.toHaveBeenCalled();
  // The grace: tiles reach the cells, the screen holds.
  draw(200);
  expect(cellPass).toHaveBeenCalled();
  expect(glyphPass).not.toHaveBeenCalled();
  expect(ready).not.toHaveBeenCalled();
  // Boot: the map shows, without anything that needs a full program.
  draw(300);
  expect(glyphPass).toHaveBeenCalled();
  expect(fireworksPass).not.toHaveBeenCalled();
  expect(ready).toHaveBeenCalledExactlyOnceWith({ firstTileFrame: 300 });
  expect(fixture.drewTiles).toHaveBeenCalled();
  expect(detail).not.toHaveBeenCalled();
  expect(atlas.getStats().detailReadyMs).toBeNull();
  draw(400);
  expect(detail).not.toHaveBeenCalled();
  // The swap draws at once, whatever the frame pacing wants.
  vi.mocked(glyphPass).mockClear();
  draw(500);
  expect(glyphPass).toHaveBeenCalledOnce();
  expect(fireworksPass).toHaveBeenCalled();
  expect(ready).toHaveBeenCalledOnce();
  expect(detail).toHaveBeenCalledExactlyOnceWith({ firstDetailFrame: 500 });
  expect(atlas.getStats()).toMatchObject({ readyMs: 300, detailReadyMs: 500 });
});
describe('the halo', () => {
  const start = (options: { quality?: 'low'; theme?: 'light' } = {}) => {
    atlas.destroy();
    vi.clearAllMocks();
    fixture.morphProgram = { program: {} };
    atlas = createAtlas(canvas, {
      tilesUrl: '/fixture.pmtiles',
      bounds: [-1, -1, 1, 1],
      initialCamera: { lng: 0, lat: 0, zoom: 18 },
      year: 2026,
      life: { enabled: false },
      ...options,
    });
    fixture.view = tile();
    fixture.arrive();
  };

  it('draws the lights, lets fireworks add their sparks, then adds it to the canvas', () => {
    fixture.bloomStrength = 0.8;
    start();
    draw(100);
    expect(createBloomTarget).toHaveBeenCalledOnce();
    const extract = vi.mocked(bloomExtractPass).mock.invocationCallOrder[0]!;
    const fireworks = vi.mocked(fireworksPass).mock.invocationCallOrder[0]!;
    const composite = vi.mocked(bloomCompositePass).mock.invocationCallOrder[0]!;
    const text = vi.mocked(streetTextPass).mock.invocationCallOrder[0]!;
    expect(extract).toBeLessThan(fireworks);
    expect(fireworks).toBeLessThan(composite);
    expect(composite).toBeLessThan(text);
    expect(vi.mocked(fireworksPass).mock.calls[0]![14]).toEqual({
      framebuffer: 'lit',
      viewport: [0, 0, 1, 1],
      rows: 0,
    });
    expect(vi.mocked(bloomCompositePass).mock.calls[0]![6]).toBe(0.8);
  });

  it('allocates nothing by day, and releases its target when day comes', () => {
    start();
    draw(100);
    expect(createBloomTarget).not.toHaveBeenCalled();
    expect(bloomExtractPass).not.toHaveBeenCalled();
    expect(vi.mocked(fireworksPass).mock.calls[0]![14]).toBeUndefined();
    fixture.bloomStrength = 0.8;
    atlas.setCamera({ zoom: 18.1 });
    draw(200);
    expect(createBloomTarget).toHaveBeenCalledOnce();
    fixture.bloomStrength = 0;
    atlas.setCamera({ zoom: 18.2 });
    draw(300);
    expect(releaseBloom).toHaveBeenCalledOnce();
  });

  it('stays off on the lower tiers and the light theme', () => {
    fixture.bloomStrength = 0.8;
    for (const options of [{ quality: 'low' as const }, { theme: 'light' as const }]) {
      start(options);
      draw(100);
      expect(bloomStrength).not.toHaveBeenCalled();
      expect(createBloomTarget).not.toHaveBeenCalled();
    }
  });

  it('waits for the full shaders', () => {
    fixture.bloomStrength = 0.8;
    fixture.bootStages = ['boot'];
    start();
    draw(100);
    expect(bloomExtractPass).not.toHaveBeenCalled();
  });
});
describe('the dissolve', () => {
  const start = (zoom: number, options: { reducedMotion?: boolean; quality?: 'low' } = {}) => {
    atlas.destroy();
    vi.clearAllMocks();
    fixture.morphProgram = { program: {} };
    atlas = createAtlas(canvas, {
      tilesUrl: '/fixture.pmtiles',
      bounds: [-1, -1, 1, 1],
      initialCamera: { lng: 0, lat: 0, zoom },
      year: 2026,
      life: { enabled: false },
      ...options,
    });
    fixture.view = tile();
    fixture.arrive();
    draw(100);
    expect(glyphPass).toHaveBeenCalled();
    vi.mocked(glyphPass).mockClear();
  };

  it('keeps the last frame when a step is crossed, and runs until it has gone', () => {
    start(16.4);
    atlas.setCamera({ zoom: 16.7 });
    draw(200);
    expect(createMorphSnapshot).toHaveBeenCalledOnce();
    const passes = vi.mocked(glyphPass).mock.calls;
    expect(passes).toHaveLength(2);
    // The old frame first, into the snapshot without labels; then the new one to the canvas.
    expect(passes[0]![22]).toEqual({ framebuffer: 'snapshot fbo', overlay: 'blank' });
    expect(passes[1]![22]).toBeUndefined();
    expect(morphPass).toHaveBeenCalledOnce();
    // Still running: the next display frame draws without input.
    vi.mocked(glyphPass).mockClear();
    draw(210);
    expect(glyphPass).toHaveBeenCalledOnce();
    fixture.morphRunning = false;
    draw(220);
    expect(releaseMorph).toHaveBeenCalledOnce();
    expect(createMorphSnapshot).toHaveBeenCalledOnce();
  });

  it('gets out of the way of a resize at the same moment', () => {
    let resized = () => {};
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          resized = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    start(16.4);
    atlas.setCamera({ zoom: 16.7 });
    resized();
    draw(200);
    expect(createMorphSnapshot).not.toHaveBeenCalled();
  });

  it('stays out of a move that keeps the same cell size', () => {
    start(18);
    atlas.setCamera({ zoom: 18.5 });
    draw(200);
    expect(createMorphSnapshot).not.toHaveBeenCalled();
    expect(morphPass).not.toHaveBeenCalled();
  });

  it('never runs with reduced motion or on the lowest quality', () => {
    for (const options of [{ reducedMotion: true }, { quality: 'low' as const }]) {
      start(16.4, options);
      atlas.setCamera({ zoom: 16.7 });
      draw(200);
      expect(createMorphSnapshot).not.toHaveBeenCalled();
    }
  });

  it('crosses plainly until its program has linked', () => {
    start(16.4);
    fixture.morphProgram = undefined;
    atlas.setCamera({ zoom: 16.7 });
    draw(200);
    expect(createMorphSnapshot).not.toHaveBeenCalled();
    expect(glyphPass).toHaveBeenCalledOnce();
  });

  it('dissolves from the last boot frame at the swap', () => {
    atlas.destroy();
    vi.clearAllMocks();
    fixture.morphProgram = { program: {} };
    fixture.bootStages = ['boot', 'full'];
    atlas = createAtlas(canvas, {
      tilesUrl: '/fixture.pmtiles',
      bounds: [-1, -1, 1, 1],
      initialCamera: { lng: 0, lat: 0, zoom: 18 },
      year: 2026,
      life: { enabled: false },
    });
    fixture.view = tile();
    fixture.arrive();
    draw(100);
    expect(createMorphSnapshot).not.toHaveBeenCalled();
    draw(200);
    expect(createMorphSnapshot).toHaveBeenCalledOnce();
    expect(morphPass).toHaveBeenCalledOnce();
  });

  it('builds the next step ahead of a crossing, only when near it', () => {
    vi.stubGlobal('requestIdleCallback', (callback: () => void) => callback());
    start(18);
    fixture.createMapGlyphs.mockClear();
    draw(200);
    expect(fixture.createMapGlyphs).not.toHaveBeenCalled();
    start(16.3);
    // The near step, then the one past the edge at 16.5.
    expect(fixture.createMapGlyphs).toHaveBeenCalledTimes(2);
    draw(200);
    expect(fixture.createMapGlyphs).toHaveBeenCalledTimes(2);
  });
});
it('preserves query parameters while forwarding the pinned URL', () => {
  const url = new URL(fixture.url);
  expect(url.searchParams.get('existing')).toBe('yes');
  expect(url.searchParams.get('v')).toBe('1234abcd');
});
it('works without performance.mark and cannot emit after destruction', () => {
  vi.stubGlobal('performance', { now: () => time });
  fixture.view = tile();
  fixture.arrive();
  draw(100);
  expect(atlas.getStats().readyMs).toBe(100);
  const ready = vi.fn();
  atlas.on('ready', ready);
  atlas.destroy();
  draw(200);
  expect(ready).not.toHaveBeenCalled();
});

it('starts active Life on the turn after readiness and replays already loaded tiles', () => {
  atlas.destroy();
  const create = vi.spyOn(Hosts, 'createInlineHostLazy');
  atlas = createAtlas(canvas, {
    tilesUrl: '/fixture.pmtiles',
    bounds: [-1, -1, 1, 1],
    initialCamera: { lng: 0, lat: 0, zoom: 18 },
    year: 2026,
    life: { time: 720 },
  });
  draw(100);
  expect(create).not.toHaveBeenCalled();
  fixture.view = tile();
  fixture.arrive();
  draw(200);
  expect(create).not.toHaveBeenCalled();
  draw(300);
  expect(create).toHaveBeenCalledOnce();
  const sync = vi.spyOn(create.mock.results[0]!.value, 'sync');
  expect(atlas.getStats().readyMs).toBe(200);
  draw(400);
  expect(create).toHaveBeenCalledOnce();
  expect(sync).not.toHaveBeenCalled(); // retained first tiles did not require a second arrival
});
it('cancels scheduled Life construction when the context is lost or the atlas is destroyed', () => {
  atlas.destroy();
  const create = vi.spyOn(Hosts, 'createInlineHostLazy');
  atlas = createAtlas(canvas, {
    tilesUrl: '/fixture.pmtiles',
    bounds: [-1, -1, 1, 1],
    initialCamera: { lng: 0, lat: 0, zoom: 18 },
    year: 2026,
  });
  fixture.view = tile();
  fixture.arrive();
  draw(100);
  canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
  draw(200);
  expect(create).not.toHaveBeenCalled();
  canvas.dispatchEvent(new Event('webglcontextrestored'));
  fixture.view = tile();
  fixture.arrive();
  draw(300);
  atlas.destroy();
  draw(400);
  expect(create).not.toHaveBeenCalled();
});
