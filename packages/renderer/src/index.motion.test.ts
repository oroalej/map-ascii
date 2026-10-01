// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAtlas, type Atlas } from './index';
import { LifeWorld } from './life/simulate';
import { cellPass, fixturePass, glyphPass, lifePass, lightPass, selectPass } from './passes';
import type * as PassesModule from './passes';
import type * as PacingModule from './pacing';
import { TileCache, type LoadedTile } from './tile-cache';
import { LifeBuilder } from './life/geometry';
import type { TileMesh } from './gpu';

vi.mock('./gpu-context', () => ({
  createPrograms: () => ({ streetText: { count: 0 } }),
  deletePrograms: vi.fn(),
  createMapGlyphs: () => ({ cellDev: { w: 10, h: 18 }, atlas: { index: () => 0 } }),
  createLabelGlyphs: () => ({ cellDev: { w: 10, h: 18 } }),
  deleteMapGlyphs: vi.fn(),
  deleteLabelGlyphs: vi.fn(),
}));
vi.mock('./gpu', () => ({
  createContext: (canvas: HTMLCanvasElement) => canvas.getContext('webgl2'),
  createCellTargets: (
    _gl: unknown,
    cols: number,
    rows: number,
    labelCols: number,
    labelRows: number,
  ) => ({ cols, rows, labelCols, labelRows }),
  deleteCellTargets: vi.fn(),
}));
vi.mock('./passes', async (load) => ({
  ...(await load<typeof PassesModule>()),
  cellPass: vi.fn(),
  crownPass: vi.fn(),
  selectPass: vi.fn(),
  glyphPass: vi.fn(),
  overlayPass: () => [],
  lifePass: vi.fn(() => 0),
  lightPass: vi.fn(),
  fixturePass: vi.fn(() => ({ streetlights: false, trafficSignals: false, utilities: false })),
}));
vi.mock('./tile-cache', () => ({
  TileCache: class {
    source = { indexOf: () => 0, feature: () => undefined, pendingCount: 0, decodeMsAverage: 0 };
    size = 0;
    tilesToDraw() {
      return [];
    }
    regionTilesFor() {
      return [];
    }
    get() {}
    suspend() {}
    resume() {}
    destroy() {}
  },
}));
vi.mock('./readback', () => ({
  Readback: class {
    poll() {}
    reset() {}
    request() {}
  },
}));
vi.mock('./picking', () => ({
  MAX_HIGHLIGHT: 64,
  Picker: class {
    issue() {}
  },
}));
vi.mock('./input', () => ({ attachInput: () => () => {} }));
vi.mock('./pacing', async (load) => ({
  ...(await load<typeof PacingModule>()),
  watchVisibility: () => ({ watched: () => true, detach() {} }),
}));

describe('live motion preference', () => {
  const defaultGetExtension = vi.fn(() => null);
  let canvas: HTMLCanvasElement,
    gl: WebGL2RenderingContext,
    atlas: Atlas,
    time: number,
    next: FrameRequestCallback;
  const draw = (at: number) => {
    time = at;
    next(at);
  };
  beforeEach(() => {
    vi.clearAllMocks();
    time = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => time);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      next = callback;
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    canvas = document.createElement('canvas');
    Object.defineProperties(canvas, { clientWidth: { value: 400 }, clientHeight: { value: 300 } });
    gl = {
      getExtension: defaultGetExtension,
      getParameter: vi.fn(),
    } as unknown as WebGL2RenderingContext;
    vi.spyOn(canvas, 'getContext').mockReturnValue(gl);
    atlas = createAtlas(canvas, {
      tilesUrl: '/tiles/test.pmtiles',
      bounds: [-1, -1, 1, 1],
      initialCamera: { lat: 0, lng: 0, zoom: 18 },
      year: 2026,
      life: { time: 720, wind: 'storm' },
    });
  });
  afterEach(() => {
    atlas.destroy();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('retains fixtures on tile reordering and invalidates on eviction or replacement with Life off', () => {
    atlas.destroy();
    const a = { z: 16, x: 32768, y: 32768 },
      b = { ...a, x: a.x + 1 };
    const loaded = (id: string): LoadedTile => ({
      // The mocked cell pass does not inspect mesh buffers.
      mesh: { crowns: { count: 0 } } as TileMesh,
      labels: [],
      life: new LifeBuilder().finish(),
      utilities: [
        {
          version: 1,
          kind: 'pole',
          pole: {
            id,
            road: 'r',
            component: 'r/0',
            at: [0.001, -0.001],
            heading: [1, 0],
            normal: [0, 1],
            transformer: false,
          },
        },
      ],
    });
    const one = loaded('one');
    let two = loaded('two');
    const order = vi.spyOn(TileCache.prototype, 'tilesToDraw').mockReturnValue([a, b]);
    vi.spyOn(TileCache.prototype, 'get').mockImplementation((tile) => (tile.x === a.x ? one : two));
    atlas = createAtlas(canvas, {
      tilesUrl: '/tiles/test.pmtiles',
      bounds: [-1, -1, 1, 1],
      initialCamera: { lat: 0, lng: 0, zoom: 19.5 },
      year: 2026,
      utilities: { derive: true },
      life: { enabled: false, time: 720 },
    });
    draw(10);
    const fixtures = vi.mocked(fixturePass).mock.calls.at(-1)![5];
    expect(fixtures).toHaveLength(2);
    order.mockReturnValue([b, a]);
    atlas.setCamera({ lng: 0.01 });
    draw(50);
    expect(vi.mocked(fixturePass).mock.calls.at(-1)![5]).toBe(fixtures);
    two = loaded('two');
    atlas.setCamera({ lng: 0.02 });
    draw(100);
    const replaced = vi.mocked(fixturePass).mock.calls.at(-1)![5];
    expect(replaced).not.toBe(fixtures);
    order.mockReturnValue([a]);
    atlas.setCamera({ lng: 0.03 });
    draw(150);
    expect(vi.mocked(fixturePass).mock.calls.at(-1)![5]).toHaveLength(1);
    atlas.setCamera({ zoom: 18 });
    draw(200);
    expect(vi.mocked(fixturePass).mock.calls.at(-1)![5]).toEqual([]);
  });

  it('leaves profiling disabled by default and resets enabled profiles on context loss', () => {
    draw(10);
    expect(atlas.getProfile()).toBeNull();
    atlas.resetProfile();
    atlas.destroy();
    atlas = createAtlas(canvas, {
      tilesUrl: '/tiles/test.pmtiles',
      bounds: [-1, -1, 1, 1],
      initialCamera: { lat: 0, lng: 0, zoom: 18 },
      year: 2026,
      life: { time: 720, wind: 'storm' },
      profiling: true,
    });
    draw(20);
    expect(atlas.getProfile()!.samples).toHaveLength(1);
    expect(atlas.getProfile()!.stages.callback.count).toBe(1);
    atlas.resetProfile();
    expect(atlas.getProfile()!.samples).toHaveLength(0);
    draw(50);
    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    expect(atlas.getProfile()!.samples).toHaveLength(0);
    canvas.dispatchEvent(new Event('webglcontextrestored'));
    draw(100);
    expect(atlas.getProfile()!.samples).toHaveLength(1);
  });

  it('applies quality DPR caps and restores High without changing simulation clearance', () => {
    vi.stubGlobal('devicePixelRatio', 2);
    const step = vi.spyOn(LifeWorld.prototype, 'step');
    const changed = vi.fn();
    atlas.on('qualitychange', changed);
    draw(10);
    const minimum = step.mock.calls.at(-1)![6];
    expect(canvas.width).toBe(800);
    atlas.setQuality('low');
    draw(1010);
    expect(canvas.width).toBe(500);
    expect(step.mock.calls.at(-1)![6]).toBe(minimum);
    expect(atlas.getQuality()).toBe('low');
    expect(atlas.getStats().quality).toEqual({ choice: 'low', tier: 3, name: 'pixels' });
    expect(changed).toHaveBeenCalledWith({ choice: 'low', tier: 3, name: 'pixels' });
    atlas.setQuality('high');
    draw(2010);
    expect(canvas.width).toBe(800);
    expect(step.mock.calls.at(-1)![6]).toBe(minimum);
  });

  it('recovers Auto with skipped idle callbacks and keeps the idle draw cadence', () => {
    const step = vi.spyOn(LifeWorld.prototype, 'step');
    for (let at = 50; at <= 4500; at += 50) draw(at);
    expect(atlas.getStats().quality.tier).toBe(1);
    for (let at = 4516; at < 19_500; at += 16) draw(at);
    step.mockClear();
    for (let at = 19_500; at < 24_500; at += 16) draw(at);
    expect(atlas.getStats().quality.tier).toBe(0);
    expect(step.mock.calls.length).toBeLessThanOrEqual(151);
  });

  it('defers manual quality while a camera flight is active', () => {
    draw(10);
    atlas.flyTo({ lng: 0.2 }, { duration: 2000 });
    atlas.setQuality('low');
    draw(100);
    expect(atlas.getStats().quality.tier).toBe(0);
    draw(2100);
    expect(atlas.getStats().quality.tier).toBe(0);
    draw(3200);
    expect(atlas.getStats().quality.tier).toBe(3);
  });

  it('reads GPU metadata only for profiling and refreshes it after context restoration', () => {
    expect(defaultGetExtension).not.toHaveBeenCalled();
    const extension = { UNMASKED_RENDERER_WEBGL: 123 };
    const getExtension = vi.fn((name: string) =>
      name === 'WEBGL_debug_renderer_info' ? extension : null,
    );
    Object.defineProperty(gl, 'getExtension', { value: getExtension });
    const getParameter = vi.spyOn(gl, 'getParameter').mockReturnValue('initial GPU');
    atlas.destroy();
    atlas = createAtlas(canvas, {
      tilesUrl: '/tiles/test.pmtiles',
      bounds: [-1, -1, 1, 1],
      initialCamera: { lat: 0, lng: 0, zoom: 18 },
      year: 2026,
      profiling: true,
    });
    expect(atlas.getProfile()!.gpuRenderer).toBe('initial GPU');
    expect(atlas.getProfile()!.gpuRenderer).toBe('initial GPU');
    expect(getExtension).toHaveBeenCalledOnce();
    expect(getParameter).toHaveBeenCalledExactlyOnceWith(extension.UNMASKED_RENDERER_WEBGL);
    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    getParameter.mockReturnValue('restored GPU');
    canvas.dispatchEvent(new Event('webglcontextrestored'));
    expect(atlas.getProfile()!.gpuRenderer).toBe('restored GPU');
    expect(getExtension).toHaveBeenCalledTimes(2);
    expect(getParameter).toHaveBeenCalledTimes(2);
  });

  it('invalidates once, preserves Life settings, freezes animations, and resumes without catching up', () => {
    const step = vi.spyOn(LifeWorld.prototype, 'step');
    vi.spyOn(LifeWorld.prototype, 'visible').mockReturnValue([
      { kind: 'person', lng: 0, lat: 0, flap: 0 },
    ]);
    draw(100);
    const saved = atlas.getLife();
    atlas.setReducedMotion(true);
    draw(200);
    expect(atlas.getLife()).toEqual(saved);
    expect(vi.mocked(glyphPass).mock.calls.at(-1)![9]).toBe(true);
    expect(vi.mocked(selectPass).mock.calls.at(-1)![6]).toBe(0);
    expect(vi.mocked(lifePass).mock.calls.at(-1)![6]).toEqual([]);
    expect(vi.mocked(glyphPass).mock.calls.at(-1)![11]!.fish).toBe(false);
    const frames = vi.mocked(cellPass).mock.calls.length;
    atlas.setReducedMotion(true);
    draw(250);
    expect(vi.mocked(cellPass).mock.calls.length).toBe(frames);
    time = 10_000;
    atlas.setReducedMotion(false);
    draw(10_020);
    expect(step.mock.calls.at(-1)![0]).toBeCloseTo(0.02);
    expect(vi.mocked(glyphPass).mock.calls.at(-1)![9]).toBe(false);
  });

  it('finishes a flight at its destination and emits its end only once', () => {
    draw(0);
    const ended = vi.fn();
    atlas.on('flyend', ended);
    atlas.flyTo({ lat: 0.1, lng: 0.2, zoom: 19 }, { duration: 2000 });
    draw(100);
    atlas.setReducedMotion(true);
    expect(atlas.getCamera()).toEqual({ lat: 0.1, lng: 0.2, zoom: 19 });
    expect(ended).toHaveBeenCalledTimes(1);
    atlas.setReducedMotion(true);
    draw(3000);
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it('disables animals and fish with Life while keeping the selected weather', () => {
    const step = vi.spyOn(LifeWorld.prototype, 'step');
    vi.spyOn(LifeWorld.prototype, 'visible').mockReturnValue([
      { kind: 'cat', lng: 0, lat: 0, flap: 2 },
    ]);
    draw(100);
    const frames = step.mock.calls.length;
    atlas.setLife({ enabled: false });
    draw(200);
    expect(step.mock.calls.length).toBe(frames);
    expect(vi.mocked(lifePass).mock.calls.at(-1)![6]).toEqual([]);
    const weather = vi.mocked(glyphPass).mock.calls.at(-1)![11]!;
    expect(weather.fish).toBe(false);
    expect(weather.rain).toBeGreaterThan(0);
    expect(atlas.getLife().wind).toBe('storm');
  });

  it('clears moving headlight beams when motion is reduced', () => {
    atlas.setLife({ time: 1320 });
    vi.spyOn(LifeWorld.prototype, 'visible').mockReturnValue([
      { kind: 'vehicle', vehicle: 'car', lng: 0, lat: 0, ahead: [0.01, 0], flap: 0 },
    ]);
    draw(100);
    expect(vi.mocked(lightPass).mock.calls.at(-1)![5]).toHaveLength(1);
    atlas.setReducedMotion(true);
    draw(200);
    expect(vi.mocked(lightPass).mock.calls.at(-1)![5]).toEqual([]);
  });

  it('drives flag motion from renderer time with Life off and freezes it with reduced motion', () => {
    atlas.setLife({ enabled: false, wind: 'breeze' });
    draw(100);
    const first = vi.mocked(fixturePass).mock.calls.at(-1)!;
    expect(first[6]).toBe(0);
    expect(first[8]!.time).toBeCloseTo(0.1);
    expect(first[8]!.strength).toBeGreaterThan(0);
    draw(1100);
    expect(vi.mocked(fixturePass).mock.calls.at(-1)![8]!.time).toBeCloseTo(1.1);
    atlas.setReducedMotion(true);
    draw(1200);
    expect(vi.mocked(fixturePass).mock.calls.at(-1)![8]!.strength).toBe(0);
  });

  it('rebuilds cached palettes on a theme change', () => {
    draw(0);
    const first = vi.mocked(glyphPass).mock.calls.at(-1)![3].uniforms;
    atlas.setTheme('light');
    draw(100);
    const next = vi.mocked(glyphPass).mock.calls.at(-1)![3].uniforms;
    expect(next).not.toBe(first);
    expect(next.label).not.toEqual(first.label);
    draw(200);
    expect(vi.mocked(glyphPass).mock.calls.at(-1)![3].uniforms).toBe(next);
  });

  it('applies a preference changed while the context was lost to the restored frame', () => {
    draw(0);
    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    atlas.setReducedMotion(true);
    canvas.dispatchEvent(new Event('webglcontextrestored'));
    draw(100);
    expect(vi.mocked(glyphPass).mock.calls.at(-1)![9]).toBe(true);
    expect(atlas.getStats().gpuFrameMs).toBeNull();
  });
});
