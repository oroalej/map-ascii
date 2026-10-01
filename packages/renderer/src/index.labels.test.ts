// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAtlas, type Atlas } from './index';
import { cellPass, crownPass, overlayPass } from './passes';
import type * as Passes from './passes';
import type * as Pacing from './pacing';
import type * as Gpu from './gpu';
import type { InputIntents } from './input';
import type { PickResult } from './picking';
import type { LoadedTile } from './tile-cache';
import type { TileLabel } from './raster/geometry';
import { LabelRank } from './labels';
import { LifeBuilder } from './life/geometry';

const state = vi.hoisted(() => ({
  input: undefined as InputIntents | undefined,
  reply: undefined as ((result: PickResult) => void) | undefined,
  arrive: undefined as (() => void) | undefined,
  known: true,
  loaded: undefined as LoadedTile | undefined,
  requests: vi.fn(),
}));
vi.mock('./gpu-context', () => ({
  createPrograms: () => ({ streetText: { count: 0 } }),
  deletePrograms: vi.fn(),
  createMapGlyphs: () => ({ cellDev: { w: 10, h: 18 }, atlas: { index: () => 2 } }),
  createLabelGlyphs: () => ({ cellDev: { w: 10, h: 18 }, atlas: { index: () => 2 } }),
  deleteMapGlyphs: vi.fn(),
  deleteLabelGlyphs: vi.fn(),
}));
vi.mock('./gpu', async (load) => ({
  ...(await load<typeof Gpu>()),
  createCellTargets: (
    _gl: unknown,
    cols: number,
    rows: number,
    labelCols: number,
    labelRows: number,
  ) => ({ cols, rows, labelCols, labelRows }),
  deleteCellTargets: vi.fn(),
}));
vi.mock('./passes', async (load) => {
  const actual = await load<typeof Passes>();
  return {
    ...actual,
    cellPass: vi.fn(),
    crownPass: vi.fn(),
    selectPass: vi.fn(),
    glyphPass: vi.fn(),
    overlayPass: vi.fn(actual.overlayPass),
    lifePass: vi.fn(() => 0),
    lifeRaster: () => null,
    lightPass: vi.fn(),
    fixturePass: () => ({ streetlights: false, trafficSignals: false, utilities: false }),
  };
});
vi.mock('./tile-cache', () => ({
  TileCache: class {
    source = {
      indexOf: (id: string) => (state.known ? Number(id.split('/')[1]) || 0 : 0),
      feature: (id: number) => ({ id: `feature/${id}`, class: 'landmark', name: `Feature ${id}` }),
      featureById: (id: string) => ({ id, class: 'landmark' }),
      pendingCount: 0,
      decodeMsAverage: 0,
    };
    size = 1;
    constructor(_gl: unknown, _url: string, arrive: () => void) {
      state.arrive = arrive;
    }
    tilesToDraw() {
      return state.loaded ? [{ z: 16, x: 32768, y: 32768 }] : [];
    }
    regionTilesFor() {
      return [];
    }
    get() {
      return state.loaded;
    }
    suspend() {}
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
    request = state.requests;
  },
}));
vi.mock('./picking', () => ({
  MAX_HIGHLIGHT: 64,
  Picker: class {
    constructor(_readback: unknown, _generation: unknown, reply: (result: PickResult) => void) {
      state.reply = reply;
    }
    issue() {}
    hover() {}
    cancelHover() {}
  },
}));
vi.mock('./input', () => ({
  attachInput: (_canvas: unknown, input: InputIntents) => {
    state.input = input;
    return () => {};
  },
}));
vi.mock('./pacing', async (load) => ({
  ...(await load<typeof Pacing>()),
  watchVisibility: () => ({ watched: () => true, detach() {} }),
}));

describe('label focus in the renderer frame', () => {
  let atlas: Atlas, canvas: HTMLCanvasElement, next: FrameRequestCallback, time: number;
  const draw = (at: number) => {
    time = at;
    next(at);
  };
  const focus = () => vi.mocked(overlayPass).mock.calls.at(-1)?.[7];
  const hover = (id: number) => {
    state.input!.hover([20, 20]);
    state.reply!({
      index: id,
      click: false,
      point: [20, 20],
      camera: atlas.getCamera(),
      size: { width: 400, height: 300 },
    });
  };
  beforeEach(() => {
    vi.clearAllMocks();
    state.known = true;
    const labels: TileLabel[] = [1, 7, 9].map((id) => ({
      id,
      text: `Name ${id}`,
      lng: 0,
      lat: 0,
      rank: LabelRank.landmark,
      band: { min: 17 },
    }));
    // Rasterization is mocked; only crown presence, labels and the empty Life payload are read.
    state.loaded = {
      mesh: { crowns: { count: 1 } },
      labels,
      life: new LifeBuilder().finish(),
    } as LoadedTile;
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
    const gl = {
      getExtension: () => null,
      bindTexture: vi.fn(),
      pixelStorei: vi.fn(),
      texSubImage2D: vi.fn(),
      bindBuffer: vi.fn(),
      bufferData: vi.fn(),
    } as unknown as WebGL2RenderingContext;
    vi.spyOn(canvas, 'getContext').mockReturnValue(gl);
    atlas = createAtlas(canvas, {
      tilesUrl: '/tiles/test.pmtiles',
      bounds: [-1, -1, 1, 1],
      initialCamera: { lng: 0, lat: 0, zoom: 18 },
      year: 2026,
      reducedMotion: true,
      life: { enabled: false, time: 720, wind: 'storm' },
    });
  });
  afterEach(() => {
    atlas.destroy();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('relabels once for selected/hovered priority without a cell pass or class readback', () => {
    draw(10);
    const labels = vi.fn();
    atlas.on('labelschange', labels);
    vi.mocked(cellPass).mockClear();
    vi.mocked(crownPass).mockClear();
    state.requests.mockClear();
    atlas.setSelected('feature/7');
    hover(9);
    draw(11);
    expect(focus()).toEqual([7, 9]);
    const placed = vi.mocked(overlayPass).mock.results.at(-1)?.value as
      ReturnType<typeof overlayPass> | undefined;
    expect(placed?.[0]?.id).toBe(7);
    expect(labels).toHaveBeenCalledOnce();
    expect(cellPass).not.toHaveBeenCalled();
    expect(crownPass).not.toHaveBeenCalled();
    expect(state.requests).not.toHaveBeenCalled();
    const passes = vi.mocked(overlayPass).mock.calls.length;
    atlas.setSelected('feature/7');
    draw(12);
    expect(overlayPass).toHaveBeenCalledTimes(passes);
    atlas.setSelected('feature/9');
    hover(7);
    draw(13);
    expect(focus()).toEqual([9, 7]);
  });
  it('does not relabel when focus has no eligible label, including the blackout', () => {
    draw(10);
    const passes = vi.mocked(overlayPass).mock.calls.length;
    atlas.setSelected('feature/20');
    hover(21);
    draw(11);
    expect(overlayPass).toHaveBeenCalledTimes(passes);
    atlas.setCamera({ zoom: 16 });
    draw(12);
    const hiddenPasses = vi.mocked(overlayPass).mock.calls.length;
    atlas.setSelected('feature/9');
    draw(13);
    expect(overlayPass).toHaveBeenCalledTimes(hiddenPasses);
    expect(focus()).toEqual([]);
  });
  it('relabels after mouse leave and coalesces focus with a cell redraw', () => {
    draw(10);
    hover(7);
    draw(11);
    expect(focus()).toEqual([7]);
    state.input!.hover(null);
    draw(12);
    expect(focus()).toEqual([]);
    const passes = vi.mocked(overlayPass).mock.calls.length;
    atlas.setSelected('feature/9');
    state.arrive!();
    draw(13);
    expect(overlayPass).toHaveBeenCalledTimes(passes + 1);
    expect(focus()).toEqual([9]);
  });
  it('resolves a selection set before its feature and tile arrive', () => {
    state.known = false;
    state.loaded = undefined;
    atlas.setSelected('feature/9');
    draw(10);
    expect(focus()).toEqual([]);
    state.known = true;
    state.loaded = {
      mesh: { crowns: { count: 0 } },
      labels: [
        { id: 9, text: 'Later', lng: 0, lat: 0, rank: LabelRank.landmark, band: { min: 17 } },
      ],
      life: new LifeBuilder().finish(),
    } as LoadedTile;
    state.arrive!();
    draw(11);
    expect(focus()).toEqual([9]);
  });
  it('reports changed text and anchors even when the visible feature ids stay the same', () => {
    const labels = vi.fn();
    atlas.on('labelschange', labels);
    draw(10);
    labels.mockClear();
    state.loaded = {
      ...state.loaded!,
      labels: state.loaded!.labels.map((label) =>
        label.id === 1 ? { ...label, text: 'New name', lng: 0.00000001 } : label,
      ),
    };
    state.arrive!();
    draw(11);
    expect(labels).toHaveBeenCalledOnce();
    expect(labels.mock.calls[0]?.[0]).toContainEqual({
      featureId: 'feature/1',
      name: 'New name',
      kind: 'landmark',
      lngLat: [0.00000001, 0],
    });
  });
  it('keeps ordinary due crown animation but adds none for an intervening focus frame', () => {
    draw(10);
    atlas.setReducedMotion(false);
    draw(100);
    vi.mocked(crownPass).mockClear();
    vi.mocked(cellPass).mockClear();
    atlas.setSelected('feature/9');
    draw(101);
    expect(crownPass).not.toHaveBeenCalled();
    expect(cellPass).not.toHaveBeenCalled();
    draw(150);
    expect(crownPass).toHaveBeenCalledOnce();
  });
  it('shifts subcell pans without placement and restores selection after context recreation', () => {
    draw(10);
    atlas.setSelected('feature/9');
    draw(11);
    const passes = vi.mocked(overlayPass).mock.calls.length;
    atlas.setCamera({ lng: 0.00000001 });
    draw(12);
    expect(overlayPass).toHaveBeenCalledTimes(passes);
    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    canvas.dispatchEvent(new Event('webglcontextrestored'));
    draw(100);
    expect(focus()).toEqual([9]);
    expect(overlayPass).toHaveBeenCalledTimes(passes + 1);
  });
});
