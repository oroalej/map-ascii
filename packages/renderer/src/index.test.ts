// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAtlas, type Atlas } from './index';

import type * as GpuModule from './gpu';
import type * as PassesModule from './passes';
import type * as FolklorePassModule from './folklore-pass';
import type * as PacingModule from './pacing';
import { LifeBuilder } from './life/geometry';
import type { LoadedTile } from './tile-cache';
import type { TileMesh } from './gpu';
import { glyphPass } from './passes';
const fixture = vi.hoisted(() => ({
  loaded: undefined as LoadedTile | undefined,
  region: false,
  cached: false,
  changed: () => {},
}));
vi.mock('./gpu-context', () => ({
  createPrograms: () => ({ streetText: { count: 0 } }),
  deletePrograms: vi.fn(),
  prewarmGlyphPrograms: vi.fn(),
  createMapGlyphs: () => ({ cellDev: { w: 10, h: 18 }, atlas: { index: () => 0 } }),
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
  ) => ({ cols, rows, labelCols, labelRows, glyphFbo: 'glyph', sub: { fbo: 'sub' } }),
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
vi.mock('./fireworks-pass', () => ({ fireworksPass: vi.fn(), deleteFireworks: vi.fn() }));
vi.mock('./folklore-pass', async (load) => ({
  ...(await load<typeof FolklorePassModule>()),
  folklorePass: vi.fn(),
}));
vi.mock('./input', () => ({ attachInput: () => () => {} }));
vi.mock('./pacing', async (load) => ({
  ...(await load<typeof PacingModule>()),
  watchVisibility: () => ({ watched: () => true, detach() {} }),
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
vi.mock('./tile-cache', () => ({
  TileCache: class {
    source = {
      indexOf: () => 0,
      feature: () => undefined,
      featureById: () => undefined,
      pendingCount: 0,
      decodeMsAverage: 0,
      setFireworksActive() {},
    };
    get size() {
      return fixture.loaded || fixture.cached ? 1 : 0;
    }
    constructor(_gl: unknown, _url: string, changed: () => void) {
      fixture.changed = changed;
    }
    tilesToDraw() {
      return fixture.loaded || fixture.cached ? [{ z: 16, x: 32768, y: 32768 }] : [];
    }
    regionTilesFor() {
      return fixture.region ? [{ z: 11, x: 1024, y: 1024 }] : [];
    }
    residentialSitesFor() {
      return [];
    }
    get(tile: { z: number }) {
      return fixture.region === (tile.z === 11) ? fixture.loaded : null;
    }
    suspend() {
      fixture.loaded = undefined;
    }
    resume() {}
    destroy() {}
  },
}));

const options = {
  tilesUrl: '/tiles/example.pmtiles',
  bounds: [-1, -1, 1, 1] as [number, number, number, number],
  initialCamera: { lat: 0, lng: 0, zoom: 13 },
  year: 2026,
};

describe('createAtlas', () => {
  it('throws a clear error when WebGL2 is unavailable', () => {
    const canvas = document.createElement('canvas');
    vi.spyOn(canvas, 'getContext').mockReturnValue(null);
    expect(() => createAtlas(canvas, options)).toThrow(/WebGL2/);
  });
});

describe('first tile frame', () => {
  let atlas: Atlas, canvas: HTMLCanvasElement, next: FrameRequestCallback;
  beforeEach(() => {
    vi.clearAllMocks();
    fixture.loaded = undefined;
    fixture.region = false;
    fixture.cached = false;
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
    vi.spyOn(canvas, 'getContext').mockReturnValue({
      COLOR_ATTACHMENT0: 100,
      getExtension: () => null,
      getParameter: vi.fn(),
    } as unknown as WebGL2RenderingContext);
    atlas = createAtlas(canvas, { ...options, life: { enabled: false }, lifeWorker: false });
  });
  afterEach(() => {
    atlas.destroy();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  const tile = (): LoadedTile => ({
    mesh: { crowns: { count: 0 } } as TileMesh,
    labels: [],
    life: new LifeBuilder().finish(),
  });
  it('keeps empty draws and cached missing tiles unready', () => {
    expect(atlas.getStats().hasDrawnTileFrame).toBe(false);
    next(100);
    expect(glyphPass).toHaveBeenCalled();
    expect(atlas.getStats().hasDrawnTileFrame).toBe(false);
    fixture.cached = true;
    fixture.changed();
    next(200);
    expect(atlas.getStats().tilesLoaded).toBe(1);
    expect(atlas.getStats().hasDrawnTileFrame).toBe(false);
  });
  it.each([false, true])(
    'becomes ready after glyph completion with a real tile (region %s), and resets on loss',
    (region) => {
      fixture.loaded = tile();
      fixture.region = region;
      vi.mocked(glyphPass).mockImplementationOnce(() => {
        expect(atlas.getStats().hasDrawnTileFrame).toBe(false);
      });
      next(100);
      expect(atlas.getStats().hasDrawnTileFrame).toBe(true);
      canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
      expect(atlas.getStats().hasDrawnTileFrame).toBe(false);
      canvas.dispatchEvent(new Event('webglcontextrestored'));
      next(200);
      expect(atlas.getStats().hasDrawnTileFrame).toBe(false);
      fixture.loaded = tile();
      fixture.changed();
      next(300);
      expect(atlas.getStats().hasDrawnTileFrame).toBe(true);
    },
  );
});
