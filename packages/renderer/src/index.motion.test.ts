import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAtlas, type Atlas } from './index';
import { LifeWorld } from './life/simulate';
import { cellPass, glyphPass, lifePass, lightPass, selectPass } from './passes';
import type * as PassesModule from './passes';
import type * as PacingModule from './pacing';

vi.mock('./gpu-context', () => ({
  createPrograms: () => ({ streetText: { count: 0 } }),
  deletePrograms: vi.fn(),
  createMapGlyphs: () => ({ cellDev: { w: 10, h: 18 }, atlas: { index: () => 0 } }),
  createLabelGlyphs: () => ({ cellDev: { w: 10, h: 18 } }),
  deleteMapGlyphs: vi.fn(),
  deleteLabelGlyphs: vi.fn(),
}));
vi.mock('./gpu', () => ({
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
  let canvas: HTMLCanvasElement, atlas: Atlas, time: number, next: FrameRequestCallback;
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
    vi.spyOn(canvas, 'getContext').mockReturnValue({} as WebGL2RenderingContext);
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
