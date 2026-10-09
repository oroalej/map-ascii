// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  createAtlas as createRenderer,
  type Atlas,
  type LabelInView,
  type AtlasOptions,
} from './index';

// Motion fixtures explicitly start active Life; startup deferral is covered in index.ready.test.
function createAtlas(canvas: HTMLCanvasElement, options: AtlasOptions) {
  const atlas = createRenderer(canvas, options);
  if (options.life?.enabled !== false && !options.reducedMotion) {
    atlas.setLife({ enabled: false });
    atlas.setLife({ enabled: true });
  }
  return atlas;
}
import { LifeWorld } from './life/simulate';
import * as TapCapture from './life/tap-capture';
import type { ProcessionRun } from './life/simulate';
import type { FluvialRoute, ClimateConfig } from '@atlas/shared';
import { CROP_STAGE } from './glyphs/select';
import { activityLevels } from './life/config';
import { LifeInspection } from './life/inspection';
import {
  cellPass,
  crownPass,
  labelsInView,
  labelMemory,
  overlayPass,
  effectClockPass,
  fixturePass,
  glyphPass,
  lifePass,
  lifeRaster,
  lightPass,
  selectPass,
} from './passes';
import { classId } from './classes';
import type { InputIntents } from './input';
const input = vi.hoisted(() => ({ intents: undefined as InputIntents | undefined }));
const visibility = vi.hoisted(() => ({
  watched: true,
  changed: undefined as ((watched: boolean) => void) | undefined,
}));
import type * as Hosts from './life/host';
import * as InlineHosts from './life/inline-host';
import type { FrameInput } from './life/worker-api';
import type * as PassesModule from './passes';
import type * as PacingModule from './pacing';
import type * as PickingModule from './picking';
import type { PickResult } from './picking';
import type * as GpuModule from './gpu';
import type { TileLabel } from './raster/geometry';
import { LabelRank } from './labels';
import { TileCache, type LoadedTile } from './tile-cache';
import { LifeBuilder, LifeLine } from './life/geometry';
import type { TileMesh } from './gpu';
import { Readback } from './readback';
import { SpeechController } from './life/speech';
import { LifeHoverController } from './life/hover';
import { prewarmGlyphPrograms } from './gpu-context';
import * as FireworkSites from './fireworks-sites';
import { fireworksPass } from './fireworks-pass';
import { createConePackingScratch } from './life/lights';
import { cityTime, atCityMinutes } from './life/clock';
import type * as FolklorePassModule from './folklore-pass';
import type { FolkloreQuad } from './folklore-pass';
import { folklorePass } from './folklore-pass';
import { focusPulse } from './focus';
import type { FolklorePacket } from './life/folklore';
import { solarPosition } from './life/sun';
import { cloudCover, driftClouds, SKY, skyAnchor } from './life/sky';
import { moonlight } from './life/moon';
import { viewportFor } from './camera';

const folkloreCapture = vi.hoisted(() => ({
  quads: undefined as readonly FolkloreQuad[] | undefined,
  packet: undefined as FolklorePacket | undefined,
}));

const vehicleBuffers = () => ({
  stampedVehicles: new Uint8Array(0),
  beamCones: createConePackingScratch(),
  brakeCones: createConePackingScratch(),
});

/** Label cases opt into the real CPU overlay; motion cases keep their original empty map. */
const labelFixture = vi.hoisted(() => ({
  enabled: false,
  known: true,
  loaded: undefined as LoadedTile | undefined,
  region: undefined as LoadedTile | undefined,
  reply: undefined as ((result: PickResult) => void) | undefined,
  arrive: undefined as (() => void) | undefined,
  requests: vi.fn(),
  residentialRequests: vi.fn(),
}));

vi.mock('./gpu-context', () => ({
  createPrograms: () => ({ streetText: { count: 0 } }),
  deletePrograms: vi.fn(),
  prewarmGlyphPrograms: vi.fn(),
  createMapGlyphs: () => ({ cellDev: { w: 10, h: 18 }, atlas: { index: () => 0 } }),
  createLabelGlyphs: () => ({ cellDev: { w: 10, h: 18 }, atlas: { index: () => 2 } }),
  deleteMapGlyphs: vi.fn(),
  deleteLabelGlyphs: vi.fn(),
}));
vi.mock('./fireworks-pass', () => ({ fireworksPass: vi.fn(), deleteFireworks: vi.fn() }));
vi.mock('./folklore-pass', async (load) => ({
  ...(await load<typeof FolklorePassModule>()),
  folklorePass: vi.fn<typeof FolklorePassModule.folklorePass>(
    (_gl, _programs, _targets, _theme, _view, _grid, quads) => {
      folkloreCapture.quads = quads;
    },
  ),
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
vi.mock('./passes', async (load) => {
  const actual = await load<typeof PassesModule>();
  return {
    ...actual,
    cellPass: vi.fn(),
    crownPass: vi.fn(),
    selectPass: vi.fn(),
    glyphPass: vi.fn<typeof PassesModule.glyphPass>(
      (
        _gl,
        _programs,
        _targets,
        _themeRes,
        _theme,
        _view,
        _grid,
        _labelGrid,
        _time,
        _reduced,
        _daylight,
        _weather,
        _lampShow,
        _moon,
        _sun,
        _focus,
        _lifeTime,
        folklore,
      ) => {
        folkloreCapture.packet = folklore;
      },
    ),
    streetTextPass: vi.fn(),
    overlayPass: vi.fn(() => []),
    labelsInView: vi.fn(actual.labelsInView),
    lifePass: vi.fn(() => 0),
    effectClockPass: vi.fn(),
    lifeRaster: vi.fn(() => null),
    lightPass: vi.fn(),
    fixturePass: vi.fn(() => ({ streetlights: false, trafficSignals: false, utilities: false })),
  };
});
vi.mock('./tile-cache', () => ({
  TileCache: class {
    source = {
      indexOf: (id: string) =>
        labelFixture.enabled && labelFixture.known ? Number(id.split('/')[1]) || 0 : 0,
      feature: (id: number) =>
        labelFixture.enabled
          ? { id: `feature/${id}`, class: 'landmark', name: `Feature ${id}` }
          : undefined,
      featureById: (id: string) => (labelFixture.enabled ? { id, class: 'landmark' } : undefined),
      pendingCount: 0,
      decodeMsAverage: 0,
      setFireworksActive: vi.fn(),
    };
    size = labelFixture.enabled ? 1 : 0;
    constructor(_gl: unknown, _url: string, arrive: () => void) {
      if (labelFixture.enabled) labelFixture.arrive = arrive;
    }
    tilesToDraw() {
      return labelFixture.enabled && labelFixture.loaded ? [{ z: 16, x: 32768, y: 32768 }] : [];
    }
    regionTilesForView() {
      return labelFixture.enabled && labelFixture.region ? [{ z: 11, x: 1024, y: 1024 }] : [];
    }
    residentialSitesFor(
      _camera: unknown,
      _size: unknown,
      active: boolean,
      tiles: readonly { z: number }[] = [],
    ) {
      labelFixture.residentialRequests(active, tiles);
      return active
        ? tiles.flatMap((tile) => {
            const loaded = this.get(tile);
            return loaded?.residential ? [{ tile, sites: loaded.residential }] : [];
          })
        : [];
    }
    get(tile: { z: number }) {
      return labelFixture.enabled
        ? tile.z === 11
          ? labelFixture.region
          : labelFixture.loaded
        : undefined;
    }
    suspend() {}
    resume() {}
    destroy() {}
  },
}));
vi.mock('./readback', () => ({
  MAX_PENDING_READS: 8,
  Readback: class {
    pending: (() => void)[] = [];
    get size() {
      return this.pending.length;
    }
    poll() {
      this.pending.splice(0).forEach((done) => done());
    }
    reset() {
      this.pending.length = 0;
    }
    request(
      fbo: WebGLFramebuffer,
      attachment: number,
      _rect: unknown,
      done: (bytes: Uint8Array) => void,
    ) {
      if (labelFixture.enabled) {
        labelFixture.requests(fbo, attachment, _rect, done);
        return;
      }
      this.pending.push(() =>
        done(
          new Uint8Array(
            (fbo as unknown) === 'glyph'
              ? [0, classId('road_mid'), 0, 0]
              : [attachment === 100 ? classId('road_mid') : 0, 0, 0, 0],
          ),
        ),
      );
    }
  },
}));
vi.mock('./picking', async (load) => ({
  ...(await load<typeof PickingModule>()),
  MAX_HIGHLIGHT: 64,
  Picker: class {
    click = vi.fn();
    constructor(_readback: unknown, _generation: unknown, reply: (result: PickResult) => void) {
      if (labelFixture.enabled) labelFixture.reply = reply;
    }
    issue() {}
    hover() {}
    cancelHover() {}
  },
}));
vi.mock('./input', () => ({
  attachInput: (_canvas: HTMLCanvasElement, intents: InputIntents) => {
    input.intents = intents;
    return () => {};
  },
}));
vi.mock('./pacing', async (load) => ({
  ...(await load<typeof PacingModule>()),
  watchVisibility: (_canvas: HTMLCanvasElement, changed: (watched: boolean) => void) => {
    visibility.changed = changed;
    return { watched: () => visibility.watched, detach() {} };
  },
}));

describe('live motion preference', () => {
  it('calls the Life pass for an accepted crowd frame with zero simulated actors', async () => {
    atlas.destroy();
    const original = InlineHosts.createConfiguredInlineHost;
    const event: FluvialRoute = {
      id: 'crowd-only',
      kind: 'fluvial',
      title: { en: 'Crowd' },
      status: 'draft',
      route: [
        [0, 0],
        [0.001, 0],
      ],
      length_m: 100,
      schedule: {
        month: 9,
        weekday: 6,
        nth: 3,
        offset_days: 0,
        start: '12:00',
        duration_min: 60,
        timezone: 'Asia/Manila',
      },
      crowd_ground: {
        grounds: [
          [
            [-0.001, -0.001],
            [0.001, -0.001],
            [0.001, 0.001],
            [-0.001, 0.001],
            [-0.001, -0.001],
          ],
        ],
        blocked: [],
        water: [],
        bridges: [],
      },
    };
    vi.spyOn(InlineHosts, 'createConfiguredInlineHost').mockImplementation((...args) => {
      const host = original(...args);
      host.latest = () => ({
        agents: [],
        puffs: new Float64Array(0),
        signalClock: 0,
        generation: 1,
        procession: { id: event.id, progress: 0.4, live: false },
        throngRun: { id: event.id, progress: 0.4, live: false },
        cellGuard: () => undefined,
        folklore: { sprites: [], haunts: [] },
      });
      return host;
    });
    atlas = createAtlas(canvas, {
      tilesUrl: '/tiles/test.pmtiles',
      bounds: [-1, -1, 1, 1],
      initialCamera: { lng: 0, lat: 0, zoom: 16 },
      year: 2026,
      lifeWorker: false,
      processions: [event],
    });
    await vi.dynamicImportSettled();
    vi.mocked(lifePass).mockClear();
    draw(100);
    expect(
      vi
        .mocked(lifePass)
        .mock.calls.some(
          (args) => args[6].length === 0 && args[14]?.event === event && args[14]?.progress === 0.4,
        ),
    ).toBe(true);
  });

  it.each([1, 2])(
    'uses uniform cloud dimming below the detail resolution at DPR %s',
    async (dpr) => {
      atlas.destroy();
      atlas = createAtlas(canvas, {
        tilesUrl: '/tiles/test.pmtiles',
        bounds: [-1, -1, 1, 1],
        initialCamera: { lat: 0, lng: 0, zoom: 18 },
        minZoom: 7,
        year: 2026,
        life: { time: 720, wind: 'storm' },
      });
      await vi.dynamicImportSettled();
      vi.stubGlobal('devicePixelRatio', dpr);
      atlas.setQuality('high');
      const anchor = skyAnchor([-1, -1, 1, 1]);
      const boundary = Math.log2(
        (anchor.meters * SKY.detailPixels * SKY.fineCells) / (SKY.wrap * dpr),
      );
      const weather = () => vi.mocked(glyphPass).mock.calls.at(-1)![11]!;
      atlas.setCamera({ zoom: boundary - 0.1 });
      draw(100);
      expect(weather()).toMatchObject({ cloudDetail: false, cloudCover: 1 });
      atlas.setCamera({ zoom: boundary + 0.1 });
      draw(200);
      expect(weather()).toMatchObject({ cloudDetail: true, cloudCover: 1 });
      atlas.setCamera({ zoom: 12 });
      draw(300);
      expect(weather().cloudDetail).toBe(true);
      atlas.setQuality('low');
      atlas.setCamera({ zoom: 18 });
      draw(1400);
      expect(weather()).toMatchObject({ cloudDetail: false, cloudCover: 1 });
    },
  );

  it('keeps storm cloud cover independent of Life, motion and live wind resolution', async () => {
    atlas.setLife({ enabled: false });
    draw(100);
    let weather = vi.mocked(glyphPass).mock.calls.at(-1)![11]!;
    expect(weather.cloudCover).toBe(1);
    expect(weather.rain).toBe(1);
    atlas.setReducedMotion(true);
    draw(200);
    weather = vi.mocked(glyphPass).mock.calls.at(-1)![11]!;
    expect(weather.cloudCover).toBe(1);
    expect(weather.rain).toBe(0);
    atlas.destroy();
    atlas = createAtlas(canvas, {
      tilesUrl: '/test.pmtiles',
      bounds: [-1, -1, 1, 1],
      initialCamera: { lat: 0, lng: 0, zoom: 18 },
      year: 2026,
      reducedMotion: true,
      life: { enabled: false, wind: 'live' },
      climate: { wind: [], default: { from: 90, strength: 'storm' }, source: 'test' },
    });
    await vi.dynamicImportSettled();
    draw(300);
    expect(vi.mocked(glyphPass).mock.calls.at(-1)![11]).toMatchObject({
      cloudCover: 1,
      rain: 0,
      cloudOffset: [0, 0],
    });
  });

  it('advances clouds only while watched and rebases motion and context transitions', () => {
    atlas.setLife({ enabled: false, wind: 'breeze' });
    const weather = () => vi.mocked(glyphPass).mock.calls.at(-1)![11]!;
    draw(100);
    const first = weather().cloudOffset!;
    draw(200);
    expect(weather().cloudOffset).toEqual(driftClouds(first, weather().wind!, 0.1, false));
    const frozen = weather().cloudOffset!;
    time = 210;
    visibility.watched = false;
    visibility.changed!(false);
    draw(5000);
    expect(weather().cloudOffset).toEqual(frozen);
    time = 10_000;
    visibility.watched = true;
    visibility.changed!(true);
    draw(10_020);
    expect(weather().cloudOffset).toEqual(driftClouds(frozen, weather().wind!, 0.02, false));
    atlas.setReducedMotion(true);
    const reduced = weather().cloudOffset!;
    draw(20_000);
    atlas.setCamera({ lng: 0.001 });
    draw(20_100);
    expect(weather().cloudOffset).toEqual(reduced);
    time = 30_000;
    atlas.setReducedMotion(false);
    draw(30_020);
    expect(weather().cloudOffset).toEqual(driftClouds(reduced, weather().wind!, 0.02, false));
    const beforeLoss = weather().cloudOffset!;
    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    time = 40_000;
    canvas.dispatchEvent(new Event('webglcontextrestored'));
    draw(40_020);
    expect(weather().cloudOffset).toEqual(driftClouds(beforeLoss, weather().wind!, 0.02, false));
    const beforeGap = weather().cloudOffset!;
    draw(50_000);
    expect(weather().cloudOffset).toEqual(
      driftClouds(beforeGap, weather().wind!, SKY.maxDt, false),
    );
  });

  it('updates cover on sun ticks from the shown moment and attenuates fresh moonlight', async () => {
    atlas.destroy();
    let date = new Date('2026-07-29T22:00:00Z');
    atlas = createAtlas(canvas, {
      tilesUrl: '/test.pmtiles',
      bounds: [-1, -1, 1, 1],
      initialCamera: { lat: 0, lng: 0, zoom: 18 },
      year: 2026,
      life: { enabled: false, time: 'live', wind: 'breeze' },
      now: () => date,
      reducedMotion: true,
    });
    await vi.dynamicImportSettled();
    const seed = skyAnchor([-1, -1, 1, 1]).seed;
    const check = () => {
      const call = vi.mocked(glyphPass).mock.calls.at(-1)!;
      const expected = cloudCover(date, seed);
      expect(call[11]!.cloudCover).toBe(expected);
      expect(call[13]).toBeCloseTo(moonlight(date, 0, 0) * (1 - SKY.moonLoss * expected), 10);
      expect(call[11]!.rain).toBe(0);
    };
    draw(100);
    check();
    const cover = vi.mocked(glyphPass).mock.calls.at(-1)![11]!.cloudCover;
    date = new Date('2026-07-30T00:00:00Z');
    atlas.setCamera({ zoom: 17 });
    draw(200);
    expect(vi.mocked(glyphPass).mock.calls.at(-1)![11]!.cloudCover).toBe(cover);
    draw(1100);
    check();
    atlas.setCamera({ zoom: 18 });
    draw(2100);
    check();
    expect(moonlight(date, 0, 0)).toBeGreaterThan(0.1);
    atlas.setLife({ time: 720 });
    draw(2200);
    expect(vi.mocked(glyphPass).mock.calls.at(-1)![11]!.cloudCover).toBe(
      cloudCover(atCityMinutes(date, { lng: 0 }, 720), seed),
    );
  });
  it('keeps ordinary agents when Wind or Time changes clear folklore', async () => {
    atlas.destroy();
    const original = InlineHosts.createConfiguredInlineHost,
      hosts: {
        host: Hosts.LifeHost;
        frame: MockInstance<() => void>;
        folklore: MockInstance<() => void>;
      }[] = [],
      person = { kind: 'person' as const, lng: 0, lat: 0, flap: 0 };
    vi.spyOn(LifeWorld.prototype, 'visible').mockReturnValue([person]);
    vi.spyOn(InlineHosts, 'createConfiguredInlineHost').mockImplementation((...args) => {
      const host = original(...args);
      const frame = vi.spyOn(host, 'invalidateFrame');
      const folklore = vi.spyOn(host, 'invalidateFolklore');
      hosts.push({ host, frame, folklore });
      return host;
    });
    atlas = createAtlas(canvas, {
      tilesUrl: '/tiles/test.pmtiles',
      bounds: [-1, -1, 1, 1],
      initialCamera: { lng: 0, lat: 0, zoom: 18 },
      year: 2026,
      lifeWorker: false,
    });
    await vi.dynamicImportSettled();
    draw(100);
    const { host, frame, folklore } = hosts[0]!;
    expect(host.latest()?.agents).toEqual([person]);
    atlas.setLife({ wind: 'storm' });
    atlas.setLife({ time: 1320 });
    expect(host.latest()?.agents).toEqual([person]);
    expect(folklore).toHaveBeenCalledTimes(2);
    expect(frame).not.toHaveBeenCalled();
  });

  it('draws a folklore-only packet and clears visibility and haunts on inactive lifecycle gates', () => {
    vi.spyOn(LifeWorld.prototype, 'visible').mockReturnValue([]);
    vi.spyOn(LifeWorld.prototype, 'visibleFolklore').mockReturnValue({
      sprites: [
        {
          id: 'g',
          kind: 'ghost',
          lng: 0,
          lat: 0,
          heading: 0,
          pose: 'breath',
          alpha: 0.5,
          phase: 0,
          wisp: 0,
        },
      ],
      haunts: [{ id: 'g', lng: 0, lat: 0, radius: 8 }],
    });
    const changed = vi.fn();
    atlas.on('folklorechange', changed);
    draw(100);
    expect(changed).toHaveBeenCalledWith(true);
    expect(folkloreCapture.quads).toHaveLength(1);
    atlas.setFocus({ classes: [], life: [], folklore: true });
    draw(200);
    const spiritDraw = () => vi.mocked(folklorePass).mock.calls.at(-1)!;
    expect(spiritDraw()[7]!.folklore).toBe(true);
    const firstPulse = focusPulse(spiritDraw()[8]!, !spiritDraw()[9]);
    expect(spiritDraw()[8]).toBe(vi.mocked(glyphPass).mock.calls.at(-1)![8]);
    draw(300);
    expect(focusPulse(spiritDraw()[8]!, !spiritDraw()[9])).not.toBe(firstPulse);
    atlas.setFocus({ classes: [], life: ['people'] });
    draw(400);
    expect([...spiritDraw()[7]!.life]).toEqual(['people']);
    expect(spiritDraw()[7]!.folklore).toBe(false);
    atlas.setFocus(null);
    draw(500);
    expect(spiritDraw()[7]).toMatchObject({ folklore: false, mask: new Uint32Array(2) });
    expect(spiritDraw()[7]!.life.size).toBe(0);
    const draws = vi.mocked(folklorePass).mock.calls.length;
    visibility.watched = false;
    visibility.changed!(false);
    draw(600);
    expect(vi.mocked(folklorePass)).toHaveBeenCalledTimes(draws);
    visibility.watched = true;
    visibility.changed!(true);
    atlas.setLife({ enabled: false });
    expect(changed).toHaveBeenLastCalledWith(false);
    draw(700);
    expect(folkloreCapture.packet?.haunts ?? []).toEqual([]);
    atlas.setLife({ enabled: true });
    draw(800);
    expect(changed).toHaveBeenLastCalledWith(true);
    atlas.setReducedMotion(true);
    expect(changed).toHaveBeenLastCalledWith(false);
    draw(900);
    expect(spiritDraw()[9]).toBe(true);
  });
  it('emits fixture changes when only pedestrian head visibility changes', () => {
    const changed = vi.fn();
    atlas.on('fixtureschange', changed);
    vi.mocked(fixturePass).mockReturnValue({
      streetlights: false,
      trafficSignals: false,
      utilities: false,
    });
    draw(100);
    changed.mockClear();
    vi.mocked(fixturePass).mockReturnValue({
      streetlights: false,
      trafficSignals: false,
      utilities: false,
      pedestrianSignals: true,
    });
    draw(200);
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ pedestrianSignals: true }));
    changed.mockClear();
    draw(300);
    expect(changed).not.toHaveBeenCalled();
    vi.mocked(fixturePass).mockReturnValue({
      streetlights: false,
      trafficSignals: false,
      utilities: false,
    });
    draw(400);
    expect(changed).toHaveBeenCalledWith(expect.not.objectContaining({ pedestrianSignals: true }));
  });
  const defaultGetExtension = vi.fn(() => null);
  let canvas: HTMLCanvasElement,
    gl: WebGL2RenderingContext,
    atlas: Atlas,
    time: number,
    next: FrameRequestCallback;
  let resized: ResizeObserverCallback;
  const draw = (at: number) => {
    time = at;
    next(at);
  };
  const usePauseMode = async (mode: 'item' | 'all') => {
    atlas.destroy();
    atlas = createAtlas(canvas, {
      tilesUrl: '/tiles/test.pmtiles',
      bounds: [-1, -1, 1, 1],
      initialCamera: { lat: 0, lng: 0, zoom: 18 },
      year: 2026,
      life: { time: 720, wind: 'storm' },
      lifeHoverPause: mode,
      lifeWorker: false,
    });
    await vi.dynamicImportSettled();
  };
  beforeEach(async () => {
    vi.clearAllMocks();
    folkloreCapture.quads = undefined;
    folkloreCapture.packet = undefined;
    labelFixture.enabled = false;
    vi.mocked(overlayPass).mockReset().mockReturnValue([]);
    visibility.watched = true;
    vi.mocked(lifeRaster).mockReturnValue(null);
    vi.mocked(lifePass).mockReset().mockReturnValue(0);
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
        constructor(callback: ResizeObserverCallback) {
          resized = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    canvas = document.createElement('canvas');
    Object.defineProperties(canvas, {
      clientWidth: { value: 400, configurable: true },
      clientHeight: { value: 300, configurable: true },
    });
    gl = {
      COLOR_ATTACHMENT0: 100,
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
      lifeHoverPause: 'all',
    });
    await vi.dynamicImportSettled();
  });
  it.each(['item', 'all'] as const)(
    'queues a touch once and keeps picking while flights and reduced motion drop Life taps (%s)',
    async (mode) => {
      await usePauseMode(mode);
      const capture = vi
        .spyOn(TapCapture, 'captureTap')
        .mockImplementation((_point, tap, _frame, _reads, _attachment, _current, done) =>
          done(tap),
        );
      vi.mocked(lifeRaster).mockReturnValue({
        owners: new Uint32Array(0),
        life: new Uint8Array(0),
        revision: 1,
      } as NonNullable<ReturnType<typeof lifeRaster>>);
      const step = vi.spyOn(LifeWorld.prototype, 'step');
      draw(100);
      input.intents!.tap([20, 20], 'touch');
      draw(140);
      expect(step.mock.calls.at(-1)![12]).toHaveLength(1);
      draw(180);
      expect(step.mock.calls.at(-1)![12]).toBeUndefined();
      atlas.flyTo({ lng: 0.01 });
      input.intents!.tap([20, 20], 'touch');
      expect(capture).toHaveBeenCalledOnce();
      atlas.setReducedMotion(true);
      input.intents!.tap([20, 20], 'mouse');
      expect(capture).toHaveBeenCalledOnce();
    },
  );
  afterEach(() => {
    atlas.destroy();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  it('delivers pointer departure after a long pause, zero-time frame and busy rejection', async () => {
    const original = InlineHosts.createConfiguredInlineHost;
    const requests: FrameInput[] = [];
    let reject = false;
    vi.spyOn(InlineHosts, 'createConfiguredInlineHost').mockImplementation(
      (world, profiler, clock) => {
        const host = original(world, profiler, clock);
        const request = host.request.bind(host);
        host.request = (frame) => {
          requests.push(frame);
          if (reject) {
            reject = false;
            return false;
          }
          return request(frame);
        };
        return host;
      },
    );
    await usePauseMode('all');
    vi.spyOn(TapCapture, 'captureTap').mockImplementation(
      (_point, tap, _frame, _reads, _attachment, _current, done) => done(tap),
    );
    vi.mocked(lifeRaster).mockReturnValue({
      owners: new Uint32Array(0),
      life: new Uint8Array(0),
      revision: 1,
    } as NonNullable<ReturnType<typeof lifeRaster>>);
    draw(100);
    input.intents!.tap([20, 20], 'mouse');
    draw(140);
    visibility.watched = false;
    visibility.changed!(false);
    time = 30_140;
    input.intents!.pointerActivity!(true);
    visibility.watched = true;
    visibility.changed!(true);
    draw(30_140);
    expect(requests.at(-1)!.step.dt).toBe(0);
    expect(requests.at(-1)!.step.tapPointer).toEqual({ revision: 1, left: true });
    reject = true;
    draw(30_180);
    expect(requests.at(-1)!.step.tapPointer).toEqual({ revision: 1, left: true });
    draw(30_220);
    expect(requests.at(-1)!.step.tapPointer).toEqual({ revision: 1, left: true });
    draw(30_260);
    expect(requests.at(-1)!.step.tapPointer).toBeUndefined();
  });
  it('captures night-season fireworks and consumes a chosen launch receipt once', async () => {
    atlas.destroy();
    atlas = createAtlas(canvas, {
      tilesUrl: '/test.pmtiles',
      bounds: [-1, -1, 1, 1],
      initialCamera: { lat: 0, lng: 0, zoom: 21 },
      year: 2026,
      cityLife: {
        source: 'Synthetic calendar',
        seasons: [
          {
            id: 'new-year',
            title: { en: 'New Year' },
            window: { from: { month: 12, day: 31 }, to: { month: 1, day: 1 } },
            fireworks: { label: 'Fireworks', variants: ['peony'] },
          },
        ],
      },
      life: { time: 1320, season: 'new-year' },
    });
    await vi.dynamicImportSettled();
    const capture = vi
      .spyOn(TapCapture, 'captureTap')
      .mockImplementation((_point, tap, _frame, _reads, _attachment, _current, done) => done(tap));
    vi.mocked(lifeRaster).mockReturnValue({
      owners: new Uint32Array(0),
      life: new Uint8Array(0),
      revision: 1,
    } as NonNullable<ReturnType<typeof lifeRaster>>);
    draw(100);
    input.intents!.tap([200, 150], 'touch');
    expect(capture.mock.calls.at(-1)![1].firework).toBe(true);
    draw(140);
    const requests = vi.mocked(fireworksPass).mock.calls.at(-1)![13];
    expect(requests).toHaveLength(1);
    expect(Number.isFinite(requests![0]!.time)).toBe(true);
    expect(requests![0]!.at[0]).toBeCloseTo(0, 10);
    expect(requests![0]!.at[1]).toBeCloseTo(0, 10);
    draw(180);
    expect(vi.mocked(fireworksPass).mock.calls.at(-1)![13]).toBeUndefined();
    atlas.setLife({ time: 720 });
    draw(220);
    input.intents!.tap([200, 150], 'touch');
    expect(capture.mock.calls.at(-1)![1].firework).toBeUndefined();
    atlas.setLife({ time: 1320, season: 'unknown' });
    draw(260);
    input.intents!.tap([200, 150], 'touch');
    expect(capture.mock.calls.at(-1)![1].firework).toBeUndefined();
  });
  it('clamps an initial zoom below the default floor before and after drawing', async () => {
    atlas.destroy();
    atlas = createAtlas(canvas, {
      tilesUrl: '/tiles/test.pmtiles',
      bounds: [-1, -1, 1, 1],
      initialCamera: { lat: 0, lng: 0, zoom: 10 },
      year: 2026,
    });
    await vi.dynamicImportSettled();
    expect(atlas.getCamera().zoom).toBe(15);
    draw(100);
    expect(atlas.getCamera().zoom).toBe(15);
  });
  it('projects current camera and CSS size before rendering, independently of DPR', () => {
    expect(atlas.project([0, 0])).toEqual([200, 150]);
    vi.stubGlobal('devicePixelRatio', 2);
    draw(100);
    expect(atlas.project([0, 0])).toEqual([200, 150]);
    Object.defineProperties(canvas, { clientWidth: { value: 600 }, clientHeight: { value: 200 } });
    expect(atlas.project([0, 0])).toEqual([300, 100]);
    atlas.setCamera({ lng: 0.0001, lat: 0.0001 });
    const center = atlas.project([0.0001, 0.0001]);
    expect(center[0]).toBeCloseTo(300);
    expect(center[1]).toBeCloseTo(100);
  });
  it("ends a replay when another season is shown, keeping its own season's and season-less ones", async () => {
    atlas.destroy();
    const route = (id: string, season?: string): FluvialRoute => ({
      id,
      kind: 'fluvial',
      title: { en: id },
      status: 'draft',
      ...(season && { season }),
      route: [
        [0, 0],
        [0.001, 0],
      ],
      length_m: 100,
      schedule: {
        month: 9,
        weekday: 6,
        nth: 3,
        offset_days: 0,
        start: '12:00',
        duration_min: 240,
        timezone: 'Asia/Manila',
      },
    });
    const season = (id: string, month: number) => ({
      id,
      title: { en: id },
      window: { from: { month, day: 1 }, to: { month, day: 2 } },
      emoji: [{ mood: 'party' as const, subjects: ['person' as const], weight: 1 }],
    });
    atlas = createAtlas(canvas, {
      tilesUrl: '/test.pmtiles',
      bounds: [-1, -1, 1, 1],
      initialCamera: { lng: 0, lat: 0, zoom: 18 },
      year: 1900,
      timezone: 'Asia/Manila',
      lifeWorker: false,
      life: { time: 720, season: 'fiesta' },
      now: () => new Date('2026-06-01T04:00:00Z'),
      processions: [route('fiesta-event', 'fiesta'), route('any-season')],
      cityLife: { source: 'Fixture', seasons: [season('fiesta', 9), season('christmas', 12)] },
    });
    await vi.dynamicImportSettled();
    const reports: (ProcessionRun | null)[] = [];
    atlas.on('procession', (run) => reports.push(run));
    draw(10);
    expect(atlas.playProcession('fiesta-event')).toBe(true);
    draw(60);
    expect(reports.at(-1)?.id).toBe('fiesta-event');
    // The same season keeps it.
    atlas.setLife({ season: 'fiesta' });
    draw(110);
    expect(reports.at(-1)?.id).toBe('fiesta-event');
    atlas.setLife({ season: 'christmas' });
    draw(160);
    expect(reports.at(-1)).toBeNull();
    expect(atlas.getSeason()?.id).toBe('christmas');
    // An event without a season plays on in any season.
    expect(atlas.playProcession('any-season')).toBe(true);
    atlas.setLife({ season: 'fiesta' });
    draw(210);
    expect(reports.at(-1)?.id).toBe('any-season');
  });
  it('advances the event clock and lighting in renderer frames, restores preferences and cancels on Life off/reduced motion', async () => {
    atlas.destroy();
    const original = InlineHosts.createConfiguredInlineHost,
      requests: FrameInput[] = [];
    vi.spyOn(InlineHosts, 'createConfiguredInlineHost').mockImplementation(
      (world, profiler, clock) => {
        const host = original(world, profiler, clock),
          request = host.request.bind(host);
        host.request = (frame) => {
          requests.push(frame);
          return request(frame);
        };
        return host;
      },
    );
    const event: FluvialRoute = {
      id: 'event',
      kind: 'fluvial',
      title: { en: 'Event' },
      status: 'draft',
      route: [
        [0, 0],
        [0.001, 0],
      ],
      length_m: 100,
      schedule: {
        month: 9,
        weekday: 6,
        nth: 3,
        offset_days: -8,
        start: '12:00',
        duration_min: 240,
        timezone: 'Asia/Manila',
      },
    };
    const climate: ClimateConfig = {
      wind: [],
      default: { from: 90, strength: 'breeze' },
      source: 'Fixture',
      crops: {
        rice: {
          source: 'Fixture',
          calendar: [
            { from: '06-01', stage: 'transplanted' },
            { from: '09-01', stage: 'harvested' },
          ],
        },
      },
    };
    atlas = createAtlas(canvas, {
      tilesUrl: '/test.pmtiles',
      bounds: [-1, -1, 1, 1],
      initialCamera: { lng: 0, lat: 0, zoom: 18 },
      year: 1900,
      timezone: 'Asia/Manila',
      lifeWorker: false,
      life: { time: 1320 },
      now: () => new Date('2026-06-01T04:00:00Z'),
      processions: [event],
      climate,
    });
    await vi.dynamicImportSettled();
    const reports: (ProcessionRun | null)[] = [];
    atlas.on('procession', (run) => reports.push(run));
    draw(10);
    const cropInPasses = () => {
      expect(vi.mocked(selectPass).mock.calls.at(-1)![12]).toMatchObject({
        stage: CROP_STAGE.transplanted,
        progress: 0,
      });
      expect(vi.mocked(glyphPass).mock.calls.at(-1)![18]).toEqual(
        vi.mocked(selectPass).mock.calls.at(-1)![12],
      );
    };
    cropInPasses();
    expect(requests.at(-1)?.step.weather?.minutes).toBe(1320);
    expect(atlas.playProcession(event.id)).toBe(true);
    expect(reports.at(-1)?.time).toMatchObject({ date: '2026-09-11', time: '12:00' });
    for (let at = 60; at <= 2200; at += 50) draw(at);
    const minutes = reports.filter((r) => r?.time).map((r) => r!.time!.minute);
    expect(new Set(minutes).size).toBeGreaterThan(1);
    expect(requests.at(-1)?.step.weather?.minutes).toBeGreaterThanOrEqual(720);
    expect(requests.at(-1)?.step.weather?.minutes).toBeLessThan(730);
    cropInPasses();
    expect(atlas.getLife().time).toBe(1320);
    atlas.stopProcession();
    draw(2250);
    expect(reports.at(-1)).toBeNull();
    expect(requests.at(-1)?.step.weather?.minutes).toBe(1320);
    atlas.playProcession(event.id);
    atlas.setLife({ enabled: false });
    draw(2300);
    cropInPasses();
    expect(reports.at(-1)).toBeNull();
    atlas.setLife({ enabled: true });
    atlas.playProcession(event.id);
    atlas.setReducedMotion(true);
    draw(2400);
    cropInPasses();
    expect(vi.mocked(selectPass).mock.calls.at(-1)![6]).toBe(0);
    expect(reports.at(-1)).toBeNull();
    expect(atlas.getLife().time).toBe(1320);
  });

  it('clears crop pass state when the city has no crop calendar', () => {
    draw(10);
    expect(vi.mocked(selectPass).mock.calls.at(-1)![12]).toBeNull();
    expect(vi.mocked(glyphPass).mock.calls.at(-1)![18]).toBeNull();
  });

  it('redraws a real-city crop boundary with fixed time and sends scaled farm attendance to Life', async () => {
    atlas.destroy();
    let date = new Date('2026-06-30T15:59:00Z');
    const visible = vi.spyOn(LifeWorld.prototype, 'visible');
    atlas = createAtlas(canvas, {
      tilesUrl: '/test.pmtiles',
      bounds: [-1, -1, 1, 1],
      initialCamera: { lng: 0, lat: 0, zoom: 18 },
      year: 1900,
      timezone: 'Asia/Manila',
      lifeWorker: false,
      life: { time: 480 },
      now: () => date,
      climate: {
        wind: [],
        default: { from: 90, strength: 'breeze' },
        source: 'Fixture',
        crops: {
          rice: {
            source: 'Fixture',
            calendar: [
              { from: '06-01', stage: 'fallow' },
              { from: '07-01', stage: 'growing' },
            ],
          },
        },
      },
    });
    await vi.dynamicImportSettled();
    draw(10);
    expect(vi.mocked(selectPass).mock.calls.at(-1)![12]?.stage).toBe(CROP_STAGE.fallow);
    date = new Date('2026-06-30T16:01:00Z');
    draw(1200);
    expect(vi.mocked(selectPass).mock.calls.at(-1)![12]).toMatchObject({
      stage: CROP_STAGE.growing,
      progress: 0,
    });
    expect(vi.mocked(glyphPass).mock.calls.at(-1)![18]).toEqual(
      vi.mocked(selectPass).mock.calls.at(-1)![12],
    );
    const activity = visible.mock.calls.at(-1)![1];
    if (typeof activity === 'number') throw new Error('expected resolved activity');
    expect(activity.places.farm).toBe(
      activityLevels(1, { minutes: 480, weekday: 3 }).places.farm * 0.35,
    );
  });

  it('sends real city dates, valid previews and same-frame sun/wind choices to the observer', async () => {
    const step = vi.spyOn(LifeWorld.prototype, 'step');
    const date = new Date('2026-12-24T16:30:00Z'),
      zone = { timezone: 'Asia/Manila', lng: 0 };
    atlas.destroy();
    atlas = createAtlas(canvas, {
      tilesUrl: '/tiles/test.pmtiles',
      bounds: [-1, -1, 1, 1],
      initialCamera: { lat: 0, lng: 0, zoom: 19 },
      year: 1900,
      now: () => date,
      timezone: zone.timezone,
      life: { time: 720, wind: 'gusty', season: 'preview' },
      cityLife: {
        source: 'Fixture',
        seasons: [
          {
            id: 'winter',
            title: { en: 'Winter' },
            window: { from: { month: 12, day: 1 }, to: { month: 1, day: 6 } },
            emoji: [{ mood: 'gift', subjects: ['person'], weight: 1 }],
          },
          {
            id: 'preview',
            title: { en: 'Preview' },
            window: { from: { month: 7, day: 1 }, to: { month: 7, day: 2 } },
            emoji: [{ mood: 'party', subjects: ['person'], weight: 1 }],
          },
        ],
      },
    });
    await vi.dynamicImportSettled();
    draw(10);
    const weather = () => step.mock.calls.at(-1)![5]!;
    expect(weather().date).toEqual({
      epochDay: cityTime(date, zone).day,
      weekday: cityTime(date, zone).weekday,
      preview: true,
    });
    expect(weather().folkloreDate).toEqual({
      epochDay: cityTime(atCityMinutes(date, zone, 720), zone).day,
      preview: 'preview',
    });
    expect(weather().sunAltitude).toBe(
      solarPosition(atCityMinutes(date, zone, 720), 0, 0).altitude,
    );
    expect(weather().windPreset).toBe('gusty');
    atlas.setLife({ time: 1380, wind: 'storm', season: 'unknown' });
    draw(30);
    expect(weather().date?.preview).toBe(false);
    expect(weather().season).toBe('winter');
    expect(weather().sunAltitude).toBe(
      solarPosition(atCityMinutes(date, zone, 1380), 0, 0).altitude,
    );
    expect(weather().windPreset).toBe('storm');
    expect(weather().rain).toBe(1);
  });
  it('compiles residential samplers only while a fireworks season is selected', async () => {
    atlas.destroy();
    labelFixture.enabled = true;
    labelFixture.loaded = {
      mesh: { crowns: { count: 0 } } as TileMesh,
      labels: [],
      life: new LifeBuilder().finish(),
      residential: new Float64Array([1, 1000, 2000]),
    };
    const compile = vi.spyOn(FireworkSites, 'residentialFireworkSites');
    atlas = createAtlas(canvas, {
      tilesUrl: '/test.pmtiles',
      bounds: [-1, -1, 1, 1],
      initialCamera: { lng: 0, lat: 0, zoom: 18 },
      year: 2026,
      cityLife: {
        source: 'Synthetic calendar',
        seasons: [
          {
            id: 'new-year',
            title: { en: 'New Year' },
            window: { from: { month: 12, day: 31 }, to: { month: 1, day: 1 } },
            fireworks: { label: 'Fireworks', variants: ['peony'] },
          },
        ],
      },
      life: { season: 'auto' },
      now: () => new Date('2026-06-01T12:00:00Z'),
    });
    await vi.dynamicImportSettled();
    draw(100);
    expect(compile).not.toHaveBeenCalled();
    expect(labelFixture.residentialRequests).toHaveBeenLastCalledWith(false, [
      { z: 16, x: 32768, y: 32768 },
    ]);
    atlas.setLife({ season: 'new-year' });
    expect(vi.mocked(prewarmGlyphPrograms).mock.calls.at(-1)?.slice(3)).toEqual([
      false,
      false,
      true,
      false,
    ]);
    draw(200);
    expect(compile).toHaveBeenCalledTimes(1);
    expect(labelFixture.residentialRequests).toHaveBeenLastCalledWith(true, [
      { z: 16, x: 32768, y: 32768 },
    ]);
    atlas.setCamera({ lng: 0.00001 });
    draw(300);
    expect(compile).toHaveBeenCalledTimes(1);
    atlas.setLife({ season: 'auto' });
    draw(400);
    labelFixture.loaded = {
      ...labelFixture.loaded,
      residential: new Float64Array([2, 2000, 3000]),
    };
    labelFixture.arrive?.();
    draw(500);
    expect(compile).toHaveBeenCalledTimes(1);
    atlas.setLife({ season: 'new-year' });
    draw(600);
    expect(compile).toHaveBeenCalledTimes(2);
  });
  it('prepares bunting as its fade becomes visible without a tile arrival', async () => {
    atlas.destroy();
    labelFixture.enabled = true;
    const b = new LifeBuilder();
    b.line(
      [
        { x: 0, y: 2000 },
        { x: 4096, y: 2000 },
      ],
      LifeLine.roadMinor,
      8,
    );
    b.place({ x: 2000, y: 2000 }, 'worship', 20);
    labelFixture.loaded = {
      mesh: { crowns: { count: 0 } } as TileMesh,
      labels: [],
      life: b.finish(),
    };
    atlas = createAtlas(canvas, {
      tilesUrl: '/test.pmtiles',
      bounds: [-1, -1, 1, 1],
      initialCamera: { lng: 0, lat: 0, zoom: 17.5 },
      year: 2026,
      life: { season: 'feast' },
      cityLife: {
        source: 'Synthetic calendar',
        seasons: [
          {
            id: 'feast',
            title: { en: 'Feast' },
            window: { from: { month: 9, day: 1 }, to: { month: 9, day: 20 } },
            bunting: { label: 'Rows', near: ['worship'], radius_m: 300, spacing_m: 30 },
          },
        ],
      },
    });
    await vi.dynamicImportSettled();
    const hasBunting = () =>
      vi
        .mocked(fixturePass)
        .mock.calls.at(-1)![5]
        .some((f) => f.kind === 'season-bunting');
    draw(100);
    expect(hasBunting()).toBe(false);
    atlas.setCamera({ zoom: 17.75 });
    draw(200);
    expect(hasBunting()).toBe(true);
    atlas.setCamera({ zoom: 17.5 });
    draw(300);
    expect(hasBunting()).toBe(false);
  });

  it('updates carried candle ink clocks in daylight when the lighting pass stays idle', async () => {
    atlas.destroy();
    atlas = createAtlas(canvas, {
      tilesUrl: '/test.pmtiles',
      bounds: [-1, -1, 1, 1],
      initialCamera: { lat: 0, lng: 0, zoom: 18 },
      year: 2026,
      timezone: 'UTC',
      now: () => new Date('2026-10-02T12:00:00Z'),
      life: { time: 720, wind: 'calm' },
      lifeWorker: false,
    });
    await vi.dynamicImportSettled();
    vi.spyOn(LifeWorld.prototype, 'visible').mockReturnValue([
      { kind: 'person', lng: 0, lat: 0, flap: 0, candle: true, effectClock: -2 },
    ]);
    vi.mocked(lifePass).mockImplementation((_gl, targets) => {
      const life = new Uint8Array(targets.cols * targets.rows * 4);
      vi.mocked(lifeRaster).mockReturnValue({
        life,
        owners: new Uint32Array(targets.cols * targets.rows),
        revision: 1,
        light: life,
        lamps: null,
        ...vehicleBuffers(),
        candles: true,
      });
      return 1;
    });
    draw(100);
    draw(150);
    expect(prewarmGlyphPrograms).toHaveBeenLastCalledWith(
      gl,
      expect.anything(),
      expect.any(Function),
      true,
      false,
      false,
      false,
    );
    expect(lightPass).not.toHaveBeenCalled();
    expect(effectClockPass).toHaveBeenLastCalledWith(gl, expect.anything());
  });

  const hoverAgent = () => {
    atlas.setQuality('high');
    vi.spyOn(LifeWorld.prototype, 'visible').mockImplementation(function (this: LifeWorld) {
      return [
        {
          kind: 'person',
          inspectionId: 99,
          lng: this.signalClock * 0.00001,
          lat: 0,
          flap: this.signalClock,
        },
      ];
    });
    vi.mocked(lifePass).mockImplementation((_gl, targets) => {
      const life = new Uint8Array(targets.cols * targets.rows * 4);
      for (let i = 0; i < life.length; i += 4) {
        life[i + 1] = classId('life_person');
        life[i + 2] = 2;
      }
      vi.mocked(lifeRaster).mockReturnValue({
        life,
        owners: new Uint32Array(targets.cols * targets.rows).fill(1),
        revision: time,
        light: life,
        lamps: null,
        ...vehicleBuffers(),
      });
      return 1;
    });
    draw(100);
    input.intents!.hover([2, 3]);
    draw(150);
    draw(200);
  };

  it('projects cursor rings locally and clears them with mouse hover and Life', async () => {
    await usePauseMode('item');
    draw(100);
    input.intents!.hover([120, 90]);
    draw(150);
    input.intents!.hover([140, 90]);
    draw(200);
    const rings = vi.mocked(glyphPass).mock.calls.at(-1)![11]!.ripples!;
    expect(rings).toHaveLength(2);
    expect(rings.every(([x, y]) => Math.abs(x) < 200 && Math.abs(y) < 200)).toBe(true);
    input.intents!.hover(null);
    draw(250);
    expect(vi.mocked(glyphPass).mock.calls.at(-1)![11]!.ripples).toEqual([]);
    input.intents!.hover([120, 90]);
    draw(300);
    atlas.setLife({ enabled: false });
    draw(350);
    expect(vi.mocked(glyphPass).mock.calls.at(-1)![11]!.ripples).toEqual([]);
  });
  it('sends CSS cursor wind and unchanged-point rest, rebases resize and rejects inactive hover', async () => {
    const frames: FrameInput[] = [];
    const createInline = InlineHosts.createConfiguredInlineHost;
    vi.spyOn(InlineHosts, 'createConfiguredInlineHost').mockImplementation((...args) => {
      const host = createInline(...args),
        request = host.request.bind(host);
      host.request = (frame) => {
        frames.push(frame);
        return request(frame);
      };
      return host;
    });
    await usePauseMode('item');
    draw(100);
    input.intents!.hover([100, 90]);
    draw(150);
    expect(frames.at(-1)!.step.gust).toBeUndefined();
    input.intents!.hover([150, 90]);
    draw(200);
    expect(frames.at(-1)!.step.gust).toMatchObject({ dir: [1, 0] });
    expect(frames.at(-1)!.step.gust!.strength).toBeGreaterThan(0);
    input.intents!.hover([150, 90]);
    draw(1250);
    expect(frames.at(-1)!.step.pointerRest).toBe(1.1);
    expect(frames.at(-1)!.step.gust).toBeUndefined();
    input.intents!.hover([160, 90]);
    draw(1300);
    resized([], {} as ResizeObserver);
    draw(1350);
    expect(frames.at(-1)!.step.gust).toBeUndefined();
    visibility.watched = false;
    visibility.changed!(false);
    input.intents!.hover([180, 90]);
    visibility.watched = true;
    visibility.changed!(true);
    draw(1400);
    expect(frames.at(-1)!.step).not.toHaveProperty('pointerRest');
    atlas.setReducedMotion(true);
    input.intents!.hover([190, 90]);
    atlas.setReducedMotion(false);
    draw(1450);
    expect(frames.at(-1)!.step).not.toHaveProperty('pointer');
    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    input.intents!.hover([200, 90]);
    canvas.dispatchEvent(new Event('webglcontextrestored'));
    await vi.dynamicImportSettled();
    draw(1500);
    expect(frames.at(-1)!.step).not.toHaveProperty('gust');
  });
  it('carries geographic mouse hover in frames and clears it on input, flight and Life changes', async () => {
    const frames: FrameInput[] = [];
    const createInline = InlineHosts.createConfiguredInlineHost;
    vi.spyOn(InlineHosts, 'createConfiguredInlineHost').mockImplementation((...args) => {
      const host = createInline(...args);
      const request = host.request.bind(host);
      host.request = (frame) => {
        frames.push(frame);
        return request(frame);
      };
      return host;
    });
    await usePauseMode('item');
    draw(100);
    expect(frames.at(-1)!.step).not.toHaveProperty('pointer');
    input.intents!.hover([120, 90]);
    draw(150);
    const frame = frames.at(-1)!;
    expect(frame.step.pointer).toEqual(
      viewportFor(frame.gust.camera, frame.gust.size).unproject([120, 90]),
    );
    draw(200);
    expect(frames.at(-1)!.step.pointer).toBe(frame.step.pointer);
    Object.defineProperty(canvas, 'clientWidth', { value: 500, configurable: true });
    resized([], {} as ResizeObserver);
    draw(250);
    const resizedFrame = frames.at(-1)!;
    expect(resizedFrame.step.pointer).not.toBe(frame.step.pointer);
    expect(resizedFrame.step.pointer).toEqual(
      viewportFor(resizedFrame.gust.camera, resizedFrame.gust.size).unproject([120, 90]),
    );
    expect(frame.step.pointer).toEqual(
      viewportFor(frame.gust.camera, frame.gust.size).unproject([120, 90]),
    );
    // Press and leave both clear hover in attachInput; the renderer receives null.
    input.intents!.hover(null);
    draw(300);
    expect(frames.at(-1)!.step).not.toHaveProperty('pointer');
    input.intents!.hover([120, 90]);
    draw(350);
    input.intents!.pan(1, 0);
    draw(400);
    expect(frames.at(-1)!.step).not.toHaveProperty('pointer');
    input.intents!.hover([120, 90]);
    draw(450);
    const movedFrame = frames.at(-1)!;
    expect(movedFrame.step.pointer).not.toBe(resizedFrame.step.pointer);
    expect(movedFrame.step.pointer).toEqual(
      viewportFor(movedFrame.gust.camera, movedFrame.gust.size).unproject([120, 90]),
    );
    atlas.flyTo({ lng: 0.01 }, { duration: 1000 });
    draw(500);
    expect(frames.at(-1)!.step).not.toHaveProperty('pointer');
    draw(1600);
    input.intents!.hover([120, 90]);
    atlas.setLife({ enabled: false });
    draw(1650);
    atlas.setLife({ enabled: true });
    draw(1700);
    expect(frames.at(-1)!.step).not.toHaveProperty('pointer');
  });

  it('sends only the hovered identity while continuing requests, other poses and shared clocks', async () => {
    atlas.destroy();
    let generation = 1,
      clock = 0;
    let first = 0,
      second = 0;
    let latest: Hosts.FrameView | undefined;
    const request = vi.fn((frame: FrameInput) => {
      clock += frame.step.dt;
      if (frame.inspection?.id !== 1) first += 0.000001;
      second += 0.000001;
      latest = {
        generation,
        puffs: new Float64Array(0),
        folklore: { sprites: [], haunts: [] },
        signalClock: clock,
        procession: undefined,
        cellGuard: () => undefined,
        agents: [
          { kind: 'person', inspectionId: 1, lng: first, lat: 0, flap: 0 },
          { kind: 'person', inspectionId: 2, lng: second, lat: 0, flap: 0 },
        ],
      };
      return true;
    });
    vi.spyOn(InlineHosts, 'createConfiguredInlineHost').mockReturnValue({
      invalidateFrame() {},
      invalidateFolklore() {},
      sync() {},
      clearTiles() {},
      request,
      latest: () => latest,
      setProcessions() {},
      setEmergency() {},
      setLive() {},
      play: () => false,
      stop() {},
      dispose() {},
    });
    atlas = createAtlas(canvas, {
      tilesUrl: '/test.pmtiles',
      bounds: [-1, -1, 1, 1],
      initialCamera: { lat: 0, lng: 0, zoom: 18 },
      year: 2026,
      lifeWorker: false,
    });
    await vi.dynamicImportSettled();
    hoverAgent();
    draw(250);
    const held = first,
      moving = second,
      signal = clock;
    for (const at of [300, 350, 400]) draw(at);
    expect(first).toBe(held);
    expect(second).toBeGreaterThan(moving);
    expect(clock).toBeGreaterThan(signal);
    expect(request.mock.calls.at(-1)![0].inspection?.id).toBe(1);
    generation++;
    draw(450);
    draw(490);
    expect(request.mock.calls.at(-1)![0].inspection?.id).toBeNull();
    input.intents!.hover(null);
    draw(530);
    expect(first).toBeGreaterThan(held);
  });

  it('keeps the drawn Life pose, traffic clock and tooltip while environmental time advances', () => {
    const step = vi.spyOn(LifeWorld.prototype, 'step');
    const hovered = vi.fn();
    atlas.on('lifehover', hovered);
    hoverAgent();
    const count = step.mock.calls.length;
    const agents = vi.mocked(lifePass).mock.calls.at(-1)![6];
    const signal = vi.mocked(fixturePass).mock.calls.at(-1)![6];
    const lifeTime = vi.mocked(glyphPass).mock.calls.at(-1)![16];
    for (let at = 250; at <= 1200; at += 50) draw(at);
    expect(step.mock.calls.length).toBe(count);
    expect(vi.mocked(lifePass).mock.calls.at(-1)![6]).toBe(agents);
    expect(vi.mocked(fixturePass).mock.calls.at(-1)![6]).toBe(signal);
    expect(vi.mocked(glyphPass).mock.calls.at(-1)![16]).toBe(lifeTime);
    expect(vi.mocked(glyphPass).mock.calls.at(-1)![8]).toBeCloseTo(1.2);
    expect(hovered.mock.calls).toEqual([[{ label: 'Person (simulated)', point: [2, 3] }]]);
    input.intents!.hover(null);
    draw(1220);
    expect(step.mock.calls.at(-1)![0]).toBeCloseTo(0.02);
    expect(atlas.getLife().enabled).toBe(true);
  });

  it.each(['item', 'all'] as const)(
    'reacquires %s inspection at a stationary pointer after internal resize and tile arrival',
    async (mode) => {
      await usePauseMode(mode);
      const hovered = vi.fn();
      atlas.on('lifehover', hovered);
      hoverAgent();
      resized([], {} as ResizeObserver);
      draw(250);
      draw(300);
      expect(hovered).toHaveBeenLastCalledWith({ label: 'Person (simulated)', point: [2, 3] });
      // A quality-driven DPR rebuild keeps the same CSS point and requests fresh evidence.
      atlas.setQuality('low');
      draw(310);
      draw(330);
      expect(hovered).toHaveBeenLastCalledWith({ label: 'Person (simulated)', point: [2, 3] });
      const tile = { z: 16, x: 32768, y: 32768 };
      const loaded = {
        mesh: { crowns: { count: 0 } } as TileMesh,
        labels: [],
        life: new LifeBuilder().finish(),
      } as LoadedTile;
      vi.spyOn(TileCache.prototype, 'tilesToDraw').mockReturnValue([tile]);
      vi.spyOn(TileCache.prototype, 'get').mockReturnValue(loaded);
      draw(350);
      draw(400);
      expect(hovered).toHaveBeenLastCalledWith({ label: 'Person (simulated)', point: [2, 3] });
    },
  );

  it.each(
    (['item', 'all'] as const).flatMap((mode) =>
      (['pan', 'zoom', 'camera', 'theme', 'time'] as const).map((action) => ({ mode, action })),
    ),
  )('clears $mode inspection on $action and requires fresh hover', async ({ mode, action }) => {
    await usePauseMode(mode);
    const select = vi.spyOn(LifeInspection.prototype, 'select');
    const step = vi.spyOn(LifeWorld.prototype, 'step');
    const hovered = vi.fn();
    atlas.on('lifehover', hovered);
    hoverAgent();
    if (action === 'pan') input.intents!.pan(20, 0);
    if (action === 'zoom') input.intents!.zoom(0.2, [0, 0]);
    if (action === 'camera') atlas.setCamera({ lng: 0.01 });
    if (action === 'theme') atlas.setTheme('light');
    if (action === 'time') atlas.setLife({ time: 1320 });
    expect(hovered).toHaveBeenLastCalledWith({ label: null, point: null });
    if (mode === 'item') expect(select.mock.calls.at(-1)![0].id).toBeNull();
    draw(250);
    draw(300);
    expect(step.mock.calls.at(-1)![0]).toBeCloseTo(0.05);
    expect(hovered).toHaveBeenLastCalledWith({ label: null, point: null });
    input.intents!.hover([2, 3]);
    draw(350);
    draw(400);
    const count = step.mock.calls.length;
    draw(450);
    if (mode === 'all') expect(step.mock.calls.length).toBe(count);
    else expect(step.mock.calls.length).toBeGreaterThan(count);
  });

  it.each(['item', 'all'] as const)(
    'suppresses %s hover during flights and lost visibility',
    async (mode) => {
      await usePauseMode(mode);
      const step = vi.spyOn(LifeWorld.prototype, 'step');
      const hovered = vi.fn();
      atlas.on('lifehover', hovered);
      hoverAgent();
      atlas.flyTo({ lng: 0.01 }, { duration: 1000 });
      expect(hovered).toHaveBeenLastCalledWith({ label: null, point: null });
      input.intents!.hover([2, 3]);
      draw(300);
      draw(350);
      expect(hovered).toHaveBeenLastCalledWith({ label: null, point: null });
      visibility.watched = false;
      visibility.changed!(false);
      draw(5000);
      time = 10_000;
      visibility.watched = true;
      visibility.changed!(true);
      draw(10_020);
      expect(step.mock.calls.at(-1)![0]).toBeCloseTo(0.02);
    },
  );

  it.each(['item', 'all'] as const)(
    'handles a late host reply during %s inspection',
    async (mode) => {
      atlas.destroy();
      const original: Hosts.FrameView = {
        agents: [{ kind: 'person', inspectionId: 42, lng: 0, lat: 0, flap: 0 }],
        procession: undefined,
        puffs: new Float64Array(0),
        folklore: { sprites: [], haunts: [] },
        signalClock: 1,
        cellGuard: () => undefined,
      };
      let latest = original;
      const request = vi.fn<(input: FrameInput) => boolean>(() => true);
      vi.spyOn(InlineHosts, 'createConfiguredInlineHost').mockReturnValue({
        invalidateFrame() {},
        invalidateFolklore() {},
        sync() {},
        clearTiles() {},
        request,
        latest: () => latest,
        setProcessions() {},
        setEmergency() {},
        setLive() {},
        play: () => false,
        stop() {},
        dispose() {},
      });
      atlas = createAtlas(canvas, {
        tilesUrl: '/test.pmtiles',
        bounds: [-1, -1, 1, 1],
        initialCamera: { lat: 0, lng: 0, zoom: 18 },
        year: 2026,
        lifeWorker: false,
        lifeHoverPause: mode,
      });
      await vi.dynamicImportSettled();
      hoverAgent();
      const count = request.mock.calls.length;
      latest = {
        ...original,
        puffs: new Float64Array(0),
        folklore: { sprites: [], haunts: [] },
        signalClock: 2,
        agents: [{ kind: 'person', inspectionId: 43, lng: 0.01, lat: 0, flap: 1 }],
        cellGuard: () => undefined,
      };
      draw(250);
      if (mode === 'all') {
        expect(request.mock.calls.length).toBe(count);
        expect(vi.mocked(lifePass).mock.calls.at(-1)![6]).toBe(original.agents);
        expect(vi.mocked(fixturePass).mock.calls.at(-1)![6]).toBe(1);
      } else {
        expect(request.mock.calls.length).toBeGreaterThan(count);
        expect(vi.mocked(lifePass).mock.calls.at(-1)![6]).toBe(latest.agents);
        draw(260);
        expect(request.mock.calls.at(-1)![0].inspection!.id).toBeNull();
      }
      input.intents!.hover(null);
      draw(270);
      expect(vi.mocked(lifePass).mock.calls.at(-1)![6]).toBe(latest.agents);
      expect(vi.mocked(fixturePass).mock.calls.at(-1)![6]).toBe(2);
    },
  );

  it('preserves live occurrence hover delay across replay start and stop', async () => {
    atlas.destroy();
    const setLive = vi.fn<(id: string | undefined, progress?: number) => void>();
    const visible: Hosts.FrameView = {
      agents: [{ kind: 'person', lng: 0, lat: 0, flap: 0 }],
      procession: undefined,
      puffs: new Float64Array(0),
      folklore: { sprites: [], haunts: [] },
      signalClock: 0,
      cellGuard: () => undefined,
    };
    vi.spyOn(InlineHosts, 'createConfiguredInlineHost').mockReturnValue({
      invalidateFrame() {},
      invalidateFolklore() {},
      sync() {},
      clearTiles() {},
      request: () => true,
      latest: () => visible,
      setProcessions() {},
      setEmergency() {},
      setLive,
      play: () => true,
      stop() {},
      dispose() {},
    });
    atlas = createAtlas(canvas, {
      tilesUrl: '/test.pmtiles',
      bounds: [-1, -1, 1, 1],
      initialCamera: { lat: 0, lng: 0, zoom: 18 },
      year: 2026,
      lifeWorker: false,
      life: { time: 'live' },
      lifeHoverPause: 'all',
      now: () => new Date('2026-09-19T08:00:00Z'),
      processions: [
        {
          id: 'test',
          title: { en: 'Test' },
          status: 'draft',
          kind: 'fluvial',
          route: [
            [0, 0],
            [0.01, 0],
          ],
          length_m: 1000,
          schedule: {
            month: 9,
            weekday: 0,
            nth: 3,
            offset_days: -1,
            start: '15:00',
            duration_min: 180,
            timezone: 'Asia/Manila',
          },
        },
      ],
    });
    await vi.dynamicImportSettled();
    hoverAgent();
    const initial = setLive.mock.calls.at(-1)![1] as number;
    for (let at = 250; at <= 1200; at += 50) draw(at);
    const delayed = setLive.mock.calls.at(-1)![1] as number;
    expect(delayed).toBeLessThan(initial);
    atlas.playProcession('test');
    draw(1220);
    expect(setLive.mock.calls.at(-1)![1]).toBeLessThanOrEqual(delayed);
    const resumed = setLive.mock.calls.at(-1)![1];
    atlas.stopProcession();
    draw(1240);
    expect(setLive.mock.calls.at(-1)![1]).toBe(resumed);
    atlas.setLife({ time: 720 });
    draw(1260);
    atlas.setLife({ time: 'live' });
    draw(1280);
    expect(setLive.mock.calls.at(-1)![1]).toBe(initial);
  });

  it.each(['item', 'all'] as const)(
    'clears %s hover on exit, Life off, reduced motion and context loss',
    async (mode) => {
      await usePauseMode(mode);
      vi.spyOn(LifeWorld.prototype, 'visible').mockReturnValue([
        { kind: 'person', inspectionId: 99, lng: 0, lat: 0, flap: 0 },
      ]);
      vi.mocked(lifePass).mockImplementation((_gl, targets) => {
        const life = new Uint8Array(targets.cols * targets.rows * 4);
        for (let i = 0; i < life.length; i += 4) {
          life[i + 1] = classId('life_person');
          life[i + 2] = 2;
        }
        vi.mocked(lifeRaster).mockReturnValue({
          life,
          owners: new Uint32Array(targets.cols * targets.rows).fill(1),
          revision: time,
          light: life,
          lamps: null,
          ...vehicleBuffers(),
        });
        return 1;
      });
      const hovered = vi.fn();
      atlas.on('lifehover', hovered);
      draw(100);
      input.intents!.hover([2, 3]);
      draw(150);
      draw(200);
      expect(hovered).toHaveBeenLastCalledWith({ label: 'Person (simulated)', point: [2, 3] });
      expect(canvas.style.cursor).toBe('');
      input.intents!.hover(null);
      expect(hovered).toHaveBeenLastCalledWith({ label: null, point: null });
      input.intents!.hover([2, 3]);
      draw(250);
      draw(300);
      atlas.setLife({ enabled: false });
      expect(hovered).toHaveBeenLastCalledWith({ label: null, point: null });
      atlas.setLife({ enabled: true });
      draw(350);
      draw(400);
      atlas.setReducedMotion(true);
      expect(hovered).toHaveBeenLastCalledWith({ label: null, point: null });
      atlas.setReducedMotion(false);
      draw(450);
      draw(500);
      canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
      expect(hovered).toHaveBeenLastCalledWith({ label: null, point: null });
    },
  );

  it('copies focus inputs, avoids identical redraws and preserves focus across context restore', () => {
    atlas.setReducedMotion(true);
    draw(100);
    const descriptor = { classes: ['road_mid' as const], life: ['vendors' as const] };
    atlas.setFocus(descriptor);
    descriptor.life.length = 0;
    draw(200);
    const count = vi.mocked(glyphPass).mock.calls.length;
    const focused = vi.mocked(glyphPass).mock.calls.at(-1)![15]!;
    expect([...focused.life]).toEqual(['vendors']);
    atlas.setFocus({ classes: ['road_mid'], life: ['vendors'] });
    draw(250);
    expect(vi.mocked(glyphPass).mock.calls.length).toBe(count);
    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    canvas.dispatchEvent(new Event('webglcontextrestored'));
    draw(300);
    expect(vi.mocked(glyphPass).mock.calls.at(-1)![15]!.key).toBe(focused.key);
    atlas.setFocus(null);
    draw(350);
    expect(
      vi
        .mocked(glyphPass)
        .mock.calls.at(-1)![15]!
        .mask.every((word) => word === 0),
    ).toBe(true);
  });

  it('packs speech ownership only at the speech zoom threshold', async () => {
    atlas.destroy();
    atlas = createAtlas(canvas, {
      tilesUrl: '/tiles/test.pmtiles',
      bounds: [-1, -1, 1, 1],
      initialCamera: { lng: 0, lat: 0, zoom: 17 },
      year: 2026,
      dialogue: { native: { code: 'en', label: 'English' }, translations: [], exchanges: [] },
    });
    await vi.dynamicImportSettled();
    vi.spyOn(LifeWorld.prototype, 'visible').mockReturnValue([
      { kind: 'person', lng: 0, lat: 0, flap: 0 },
    ]);
    draw(100);
    expect(vi.mocked(lifePass).mock.calls.at(-1)![12]).toBeUndefined();
    atlas.setCamera({ lng: 0, lat: 0, zoom: 18 });
    draw(200);
    expect(vi.mocked(lifePass).mock.calls.at(-1)![12]!.members).toBeInstanceOf(Uint8Array);
    atlas.setCamera({ lng: 0, lat: 0, zoom: 17 });
    draw(300);
    expect(vi.mocked(lifePass).mock.calls.at(-1)![12]).toBeUndefined();
  });

  it('delivers GPU visibility replies after a slow drawing frame', async () => {
    atlas.destroy();
    atlas = createAtlas(canvas, {
      tilesUrl: '/tiles/test.pmtiles',
      bounds: [-1, -1, 1, 1],
      initialCamera: { lng: 0, lat: 0, zoom: 18 },
      year: 2026,
      dialogue: { native: { code: 'en', label: 'English' }, translations: [], exchanges: [] },
    });
    await vi.dynamicImportSettled();
    vi.mocked(lifePass).mockImplementation((_gl, targets) => {
      const life = new Uint8Array(targets.cols * targets.rows * 4);
      vi.mocked(lifeRaster).mockReturnValue({
        life,
        owners: new Uint32Array(life.length / 4),
        revision: 0,
        light: life,
        lamps: null,
        ...vehicleBuffers(),
      });
      return 0;
    });
    vi.spyOn(LifeWorld.prototype, 'visible').mockReturnValue([
      { kind: 'person', lng: 0, lat: 0, flap: 0 },
    ]);
    const delivered: [string, number][] = [];
    vi.spyOn(Readback.prototype, 'poll').mockImplementation(() => {
      delivered.push(['poll', performance.now()]);
    });
    vi.spyOn(LifeHoverController.prototype, 'update').mockImplementation(() => {
      delivered.push(['hover', performance.now()]);
    });
    vi.spyOn(SpeechController.prototype, 'update').mockImplementation(() => {
      delivered.push(['speech', performance.now()]);
    });
    vi.mocked(glyphPass).mockImplementationOnce(() => {
      time += 300;
    });
    draw(20);
    expect(delivered).toEqual([
      ['poll', 320],
      ['hover', 320],
      ['speech', 320],
    ]);
  });
  it('waits for camera input to settle before scheduling speech visibility work', async () => {
    atlas.destroy();
    atlas = createAtlas(canvas, {
      tilesUrl: '/tiles/test.pmtiles',
      bounds: [-1, -1, 1, 1],
      initialCamera: { lng: 0, lat: 0, zoom: 18 },
      year: 2026,
      dialogue: { native: { code: 'en', label: 'English' }, translations: [], exchanges: [] },
    });
    await vi.dynamicImportSettled();
    vi.mocked(lifePass).mockImplementation((_gl, targets) => {
      const life = new Uint8Array(targets.cols * targets.rows * 4);
      vi.mocked(lifeRaster).mockReturnValue({
        life,
        owners: new Uint32Array(life.length / 4),
        revision: 0,
        light: life,
        lamps: null,
        ...vehicleBuffers(),
      });
      return 0;
    });
    vi.spyOn(LifeWorld.prototype, 'visible').mockReturnValue([
      { kind: 'person', lng: 0, lat: 0, flap: 0 },
    ]);
    const update = vi.spyOn(SpeechController.prototype, 'update').mockImplementation(() => {});
    draw(100);
    update.mockClear();
    for (let at = 120; at <= 400; at += 20) {
      time = at;
      atlas.setCamera({ lng: at / 10000, lat: 0, zoom: 18 });
      draw(at);
    }
    draw(540);
    expect(update).not.toHaveBeenCalled();
    draw(560);
    expect(update).toHaveBeenCalledOnce();
  });
  it('retains fixtures on tile reordering and invalidates on eviction or replacement with Life off', async () => {
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
    await vi.dynamicImportSettled();
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
  it('releases inspection when the real calendar changes season without user input', async () => {
    atlas.destroy();
    let date = new Date('2026-12-31T04:00:00Z');
    atlas = createAtlas(canvas, {
      tilesUrl: '/test.pmtiles',
      bounds: [-1, -1, 1, 1],
      initialCamera: { lat: 0, lng: 0, zoom: 19 },
      year: 2026,
      lifeWorker: false,
      now: () => date,
      cityLife: {
        source: 'Synthetic calendar',
        seasons: [
          {
            id: 'winter',
            title: { en: 'Winter' },
            window: { from: { month: 12, day: 31 }, to: { month: 1, day: 1 } },
            lanterns: { label: 'Lanterns', shape: 'star' },
          },
        ],
      },
    });
    await vi.dynamicImportSettled();
    const hovered = vi.fn();
    atlas.on('lifehover', hovered);
    hoverAgent();
    expect(hovered).toHaveBeenLastCalledWith({ label: 'Person (simulated)', point: [2, 3] });
    date = new Date('2027-01-02T04:00:00Z');
    draw(1100);
    expect(atlas.getSeason()).toBeNull();
    expect(hovered).toHaveBeenLastCalledWith({ label: null, point: null });
  });
  it('resolves the real city date immediately, independently of year/time, and changes fixtures without moving', async () => {
    atlas.destroy();
    let date = new Date('2026-11-30T16:01:00Z');
    const tile = { z: 16, x: 32768, y: 32768 },
      builder = new LifeBuilder();
    builder.addLamps([2000, 2000, 0, 7, 2010, 2000, 2020, 2000]);
    const loaded: LoadedTile = {
      mesh: { crowns: { count: 0 } } as TileMesh,
      labels: [],
      life: builder.finish(),
    };
    vi.spyOn(TileCache.prototype, 'tilesToDraw').mockReturnValue([tile]);
    vi.spyOn(TileCache.prototype, 'get').mockReturnValue(loaded);
    const winter = {
      id: 'winter',
      title: { en: 'Winter' },
      sources: [{ title: 'Calendar', url: 'https://example.com/calendar' }],
      window: { from: { month: 12, day: 1 }, to: { month: 1, day: 6 } },
      lanterns: { label: 'Stars', shape: 'star' as const },
    };
    atlas = createAtlas(canvas, {
      tilesUrl: '/tiles/test.pmtiles',
      bounds: [-1, -1, 1, 1],
      initialCamera: { lat: 0, lng: 0, zoom: 19 },
      year: 1900,
      now: () => date,
      timezone: 'Asia/Manila',
      cityLife: { source: 'Synthetic calendar', seasons: [winter] },
      life: { enabled: false, time: 1320 },
    });
    await vi.dynamicImportSettled();
    expect(atlas.getSeason()?.id).toBe('winter');
    expect(atlas.getSeason()).toBe(atlas.getSeason());
    const events = vi.fn();
    atlas.on('seasonchange', events);
    draw(10);
    expect(
      vi
        .mocked(fixturePass)
        .mock.calls.at(-1)![5]
        .some((f) => f.kind === 'season-lantern'),
    ).toBe(true);
    const camera = atlas.getCamera();
    date = new Date('2027-01-07T04:00:00Z');
    draw(1100);
    expect(atlas.getSeason()).toBe(null);
    expect(events).toHaveBeenCalledWith(null);
    expect(
      vi
        .mocked(fixturePass)
        .mock.calls.at(-1)![5]
        .some((f) => f.kind === 'season-lantern'),
    ).toBe(false);
    atlas.setLife({ season: 'winter' });
    expect(atlas.getSeason()?.id).toBe('winter');
    draw(1200);
    expect(
      vi
        .mocked(fixturePass)
        .mock.calls.at(-1)![5]
        .some((f) => f.kind === 'season-lantern'),
    ).toBe(true);
    atlas.setLife({ season: 'unknown' });
    expect(atlas.getSeason()).toBe(null);
    expect(atlas.getCamera()).toEqual(camera);
    atlas.setLife({ season: 'winter' });
    atlas.setCamera({ zoom: 14 });
    draw(1300);
    expect(atlas.getCamera().zoom).toBe(15);
    expect(
      vi
        .mocked(fixturePass)
        .mock.calls.at(-1)![5]
        .some((f) => f.kind === 'season-lantern'),
    ).toBe(true);
    atlas.setCamera({ zoom: 19 });
    draw(1400);
    expect(
      vi
        .mocked(fixturePass)
        .mock.calls.at(-1)![5]
        .some((f) => f.kind === 'season-lantern'),
    ).toBe(true);
  });

  it('leaves profiling disabled by default and resets enabled profiles on context loss', async () => {
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
    await vi.dynamicImportSettled();
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

  it('reads GPU metadata only for profiling and refreshes it after context restoration', async () => {
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
    await vi.dynamicImportSettled();
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
    const clear = vi.spyOn(LifeWorld.prototype, 'clearTiles');
    const step = vi.spyOn(LifeWorld.prototype, 'step');
    vi.mocked(lifeRaster).mockReturnValue({
      life: new Uint8Array(4),
      owners: new Uint32Array(1),
      revision: 0,
      light: new Uint8Array(4),
      lamps: null,
      ...vehicleBuffers(),
    });
    vi.spyOn(LifeWorld.prototype, 'visible').mockReturnValue([
      { kind: 'person', lng: 0, lat: 0, flap: 0 },
    ]);
    draw(100);
    const saved = atlas.getLife();
    atlas.setReducedMotion(true);
    expect(clear).toHaveBeenCalled();
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
    const clear = vi.spyOn(LifeWorld.prototype, 'clearTiles');
    const step = vi.spyOn(LifeWorld.prototype, 'step');
    vi.mocked(lifeRaster).mockReturnValue({
      life: new Uint8Array(4),
      owners: new Uint32Array(1),
      revision: 0,
      light: new Uint8Array(4),
      lamps: null,
      ...vehicleBuffers(),
    });
    vi.spyOn(LifeWorld.prototype, 'visible').mockReturnValue([
      { kind: 'cat', lng: 0, lat: 0, flap: 2 },
    ]);
    draw(100);
    const frames = step.mock.calls.length;
    atlas.setLife({ enabled: false });
    expect(clear).toHaveBeenCalled();
    draw(200);
    expect(step.mock.calls.length).toBe(frames);
    expect(vi.mocked(lifePass).mock.calls.at(-1)![6]).toEqual([]);
    const weather = vi.mocked(glyphPass).mock.calls.at(-1)![11]!;
    expect(weather.fish).toBe(false);
    expect(weather.rain).toBeGreaterThan(0);
    expect(atlas.getLife().wind).toBe('storm');
    atlas.setLife({ enabled: true });
    draw(300);
    expect(step.mock.calls.length).toBeGreaterThan(frames);
    expect(vi.mocked(lifePass).mock.calls.at(-1)![6]).toHaveLength(1);
  });

  it('clears moving headlight beams when motion is reduced', () => {
    atlas.setLife({ time: 1320 });
    vi.mocked(lifeRaster).mockReturnValue({
      life: new Uint8Array(4),
      owners: new Uint32Array(1),
      revision: 0,
      light: new Uint8Array(4),
      lamps: null,
      ...vehicleBuffers(),
    });
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

  it('does not accumulate lost-context time when Life is reenabled before restoration', () => {
    const step = vi.spyOn(LifeWorld.prototype, 'step');
    draw(100);
    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    time = 1000;
    atlas.setLife({ enabled: false });
    atlas.setLife({ enabled: true });
    time = 10_000;
    canvas.dispatchEvent(new Event('webglcontextrestored'));
    draw(10_020);
    expect(step.mock.calls.at(-1)![0]).toBeCloseTo(0.02);
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

describe('label focus in the renderer frame', () => {
  let atlas: Atlas, canvas: HTMLCanvasElement, next: FrameRequestCallback, time: number;
  const draw = (at: number) => {
    time = at;
    next(at);
  };
  const focus = () => vi.mocked(overlayPass).mock.calls.at(-1)?.[7];
  const hover = (id: number) => {
    input.intents!.hover([20, 20]);
    labelFixture.reply!({
      index: id,
      click: false,
      point: [20, 20],
      camera: atlas.getCamera(),
      size: { width: 400, height: 300 },
    });
  };
  beforeEach(async () => {
    vi.clearAllMocks();
    labelFixture.enabled = true;
    visibility.watched = true;
    const actual = await vi.importActual<typeof PassesModule>('./passes');
    vi.mocked(overlayPass).mockReset().mockImplementation(actual.overlayPass);
    vi.mocked(labelsInView).mockReset().mockImplementation(actual.labelsInView);
    vi.mocked(lifePass).mockReset().mockReturnValue(0);
    vi.mocked(lifeRaster).mockReturnValue(null);
    labelFixture.known = true;
    labelFixture.region = undefined;
    const labels: TileLabel[] = [1, 7, 9].map((id) => ({
      id,
      text: `Name ${id}`,
      lng: 0,
      lat: 0,
      rank: LabelRank.landmark,
      band: { min: 17 },
    }));
    // Rasterization is mocked; only crown presence, labels and the empty Life payload are read.
    labelFixture.loaded = {
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
    await vi.dynamicImportSettled();
  });
  afterEach(() => {
    atlas.destroy();
    labelFixture.enabled = false;
    vi.mocked(overlayPass).mockReset().mockReturnValue([]);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('draws detailed road geometry when a longer region copy has the same feature id', () => {
    const detail: TileLabel = {
      ...labelFixture.loaded!.labels[0]!,
      rank: LabelRank.roadMajor,
      lng: 0.0002,
      angle: 0,
      run: [
        [-0.0003, 0],
        [0.0007, 0],
      ],
    };
    labelFixture.loaded = { ...labelFixture.loaded!, labels: [detail] };
    labelFixture.region = {
      ...labelFixture.loaded,
      labels: [
        {
          ...detail,
          lng: 0,
          angle: 0.3,
          run: [
            [-0.003, 0],
            [0.003, 0],
          ],
        },
      ],
    };
    draw(10);
    const call = vi.mocked(overlayPass).mock.calls.at(-1)!;
    const [col, row] = call[4].toCell(detail.lng, detail.lat);
    expect(call[5][0]).toMatchObject({
      id: detail.id,
      col: Math.floor(col),
      row: Math.floor(row),
      angle: detail.angle,
    });
    expect(vi.mocked(overlayPass).mock.results.at(-1)?.value).toHaveLength(1);
  });

  it('keeps the accessible list unchanged through focus and pans while layout priorities change', () => {
    const reports = vi.fn<(labels: LabelInView[]) => void>();
    atlas.on('labelschange', reports);
    draw(10);
    expect(reports.mock.calls[0]?.[0].map(({ featureId }) => featureId)).toEqual([
      'feature/1',
      'feature/7',
      'feature/9',
    ]);
    reports.mockClear();
    atlas.setSelected('feature/7');
    hover(9);
    draw(11);
    expect(focus()).toEqual([7, 9]);
    atlas.setCamera({ lng: 0.00000001 });
    draw(12);
    atlas.setSelected(null);
    input.intents!.hover(null);
    draw(13);
    expect(focus()).toEqual([]);
    expect(reports).not.toHaveBeenCalled();
  });
  it('relabels once for selected/hovered priority without a cell pass or class readback', () => {
    draw(10);
    const labels = vi.fn<(labels: LabelInView[]) => void>();
    atlas.on('labelschange', labels);
    vi.mocked(cellPass).mockClear();
    vi.mocked(crownPass).mockClear();
    labelFixture.requests.mockClear();
    atlas.setSelected('feature/7');
    hover(9);
    draw(11);
    expect(focus()).toEqual([7, 9]);
    const placed = vi.mocked(overlayPass).mock.results.at(-1)?.value as
      ReturnType<typeof overlayPass> | undefined;
    expect(placed?.[0]?.id).toBe(7);
    expect(labels).not.toHaveBeenCalled();
    expect(cellPass).not.toHaveBeenCalled();
    expect(crownPass).not.toHaveBeenCalled();
    expect(labelFixture.requests).not.toHaveBeenCalled();
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
  it.each([false, true])(
    'changes hover and speech evidence only when focus changes layout: %s',
    async (changes) => {
      if (changes)
        labelFixture.loaded = {
          ...labelFixture.loaded!,
          labels: labelFixture.loaded!.labels.map((label) => ({ ...label, text: 'Shared' })),
        };
      const hoverFrames = vi
        .spyOn(LifeHoverController.prototype, 'update')
        .mockImplementation(() => {});
      const speechFrames = vi
        .spyOn(SpeechController.prototype, 'update')
        .mockImplementation(() => {});
      vi.spyOn(LifeWorld.prototype, 'visible').mockReturnValue([
        { kind: 'person', lng: 0, lat: 0, flap: 0 },
      ]);
      vi.mocked(lifePass).mockImplementation((...args) => {
        const targets = args[1],
          speakers = args[12],
          count = targets.cols * targets.rows;
        vi.mocked(lifeRaster).mockReturnValue({
          life: new Uint8Array(count * 4),
          owners: new Uint32Array(count),
          revision: 1,
          light: new Uint8Array(count * 4),
          lamps: null,
          ...vehicleBuffers(),
        });
        if (speakers) speakers.members = new Uint8Array(count);
        return args[6].length;
      });
      atlas.destroy();
      atlas = createAtlas(canvas, {
        tilesUrl: '/tiles/test.pmtiles',
        bounds: [-1, -1, 1, 1],
        initialCamera: { lng: 0, lat: 0, zoom: 18 },
        year: 2026,
        dialogue: { native: { code: 'en', label: 'English' }, translations: [], exchanges: [] },
      });
      await vi.dynamicImportSettled();
      input.intents!.hover([20, 20]);
      draw(1000);
      let previousHover = hoverFrames.mock.calls.at(-1)?.[0],
        previousSpeech = speechFrames.mock.calls.at(-1)?.[0];
      expect(previousHover).toBeTruthy();
      expect(previousSpeech).toBeTruthy();
      vi.mocked(cellPass).mockClear();
      const gl = canvas.getContext('webgl2')!;
      const texture = vi.spyOn(gl, 'texSubImage2D');
      const uploads = texture.mock.calls.length;
      for (const [selected, hovered] of [
        [7, 0],
        [0, 9],
        [0, 0],
      ] as const) {
        atlas.setSelected(selected ? `feature/${selected}` : null);
        hover(hovered);
        draw(++time);
        expect(focus()).toEqual([selected, hovered].filter((id) => id > 0));
        expect(cellPass).not.toHaveBeenCalled();
        const currentHover = hoverFrames.mock.calls.at(-1)?.[0];
        const currentSpeech = speechFrames.mock.calls.at(-1)?.[0];
        if (changes) {
          expect(currentHover?.geometry).not.toBe(previousHover?.geometry);
          expect(currentSpeech?.geometry).not.toBe(previousSpeech?.geometry);
        } else {
          expect(currentHover?.geometry).toBe(previousHover?.geometry);
          expect(currentSpeech?.geometry).toBe(previousSpeech?.geometry);
        }
        previousHover = currentHover;
        previousSpeech = currentSpeech;
      }
      input.intents!.hover(null);
      draw(++time);
      expect(texture).toHaveBeenCalledTimes(uploads + (changes ? 3 : 0));
    },
  );
  it('relabels after mouse leave and coalesces focus with a cell redraw', () => {
    draw(10);
    hover(7);
    draw(11);
    expect(focus()).toEqual([7]);
    input.intents!.hover(null);
    draw(12);
    expect(focus()).toEqual([]);
    const passes = vi.mocked(overlayPass).mock.calls.length;
    atlas.setSelected('feature/9');
    labelFixture.arrive!();
    draw(13);
    expect(overlayPass).toHaveBeenCalledTimes(passes + 1);
    expect(focus()).toEqual([9]);
  });
  it('resolves a selection set before its feature and tile arrive', () => {
    labelFixture.known = false;
    labelFixture.loaded = undefined;
    atlas.setSelected('feature/9');
    draw(10);
    expect(focus()).toEqual([]);
    labelFixture.known = true;
    labelFixture.loaded = {
      mesh: { crowns: { count: 0 } },
      labels: [
        { id: 9, text: 'Later', lng: 0, lat: 0, rank: LabelRank.landmark, band: { min: 17 } },
      ],
      life: new LifeBuilder().finish(),
    } as LoadedTile;
    labelFixture.arrive!();
    draw(11);
    expect(focus()).toEqual([9]);
  });
  it('reports changed text and anchors even when the visible feature ids stay the same', () => {
    const labels = vi.fn<(labels: LabelInView[]) => void>();
    atlas.on('labelschange', labels);
    draw(10);
    labels.mockClear();
    labelFixture.loaded = {
      ...labelFixture.loaded!,
      labels: labelFixture.loaded!.labels.map((label) =>
        label.id === 1 ? { ...label, text: 'New name', lng: 0.00000001 } : label,
      ),
    };
    labelFixture.arrive!();
    draw(11);
    expect(labels).toHaveBeenCalledOnce();
    expect(labels.mock.calls[0]?.[0]).toContainEqual({
      featureId: 'feature/1',
      name: 'New name',
      kind: 'landmark',
      lngLat: [0.00000001, 0],
    });
  });
  it('publishes only the final payload when a subcell pan and focus change share a frame', () => {
    draw(10);
    const labels = vi.fn<(labels: LabelInView[]) => void>();
    atlas.on('labelschange', labels);
    const visible = vi.mocked(labelsInView).getMockImplementation()!;
    // Model the old overlay crossing the screen edge during the shift. Once focus is
    // placed, model a changed final membership containing only name 7. Never publish the interim gap.
    vi.mocked(labelsInView).mockImplementation((...args) =>
      focus()?.includes(7) ? visible(...args).filter(({ id }) => id === 7) : [],
    );
    vi.mocked(cellPass).mockClear();
    const passes = vi.mocked(overlayPass).mock.calls.length;
    atlas.setCamera({ lng: 0.00000001 });
    hover(7);
    draw(11);
    expect(cellPass).not.toHaveBeenCalled();
    expect(overlayPass).toHaveBeenCalledTimes(passes + 1);
    expect(labels).toHaveBeenCalledOnce();
    expect(labels.mock.calls[0]?.[0]?.[0]?.featureId).toBe('feature/7');
    vi.mocked(labelsInView).mockImplementation(visible);
  });
  it('does not report unchanged pan payloads or share its comparison snapshot with consumers', () => {
    const labels = vi.fn<(labels: LabelInView[]) => void>();
    atlas.on('labelschange', labels);
    draw(10);
    const initial = labels.mock.calls[0]?.[0] as { name: string; lngLat: number[] }[];
    initial[0]!.name = 'consumer mutation';
    initial[0]!.lngLat[0] = 999;
    labels.mockClear();
    atlas.setCamera({ lng: 0.00000001 });
    draw(11);
    expect(labels).not.toHaveBeenCalled();
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
  it('redraws cursor crowns once on exact expiry even between ordinary animation frames', () => {
    atlas.setReducedMotion(false);
    atlas.setLife({ enabled: true, wind: 'calm' });
    draw(100);
    input.intents!.hover([100, 100]);
    draw(150);
    input.intents!.hover([150, 100]);
    draw(200);
    expect(vi.mocked(crownPass).mock.calls.at(-1)![8]!.strength).toBeGreaterThan(0);
    draw(749);
    vi.mocked(crownPass).mockClear();
    draw(751);
    expect(crownPass).toHaveBeenCalledOnce();
    expect(vi.mocked(crownPass).mock.calls[0]![8]).toBeUndefined();
    draw(752);
    expect(crownPass).toHaveBeenCalledOnce();
  });

  it('paces idle hover gusts and ripples at the ordinary animation cadence', () => {
    atlas.setReducedMotion(false);
    atlas.setLife({ enabled: true });
    draw(1000);
    vi.mocked(selectPass).mockClear();
    vi.mocked(crownPass).mockClear();
    for (let i = 1; i <= 30; i++) {
      input.intents!.hover([100 + i * 3, 100]);
      draw(1000 + i);
    }
    expect(selectPass).not.toHaveBeenCalled();
    expect(crownPass).not.toHaveBeenCalled();
    draw(1034);
    expect(selectPass).toHaveBeenCalledOnce();
    expect(crownPass).toHaveBeenCalledOnce();
    expect(vi.mocked(glyphPass).mock.calls.at(-1)![11]!.ripples!.length).toBeGreaterThan(0);
    draw(1040);
    expect(selectPass).toHaveBeenCalledOnce();
    draw(1068);
    expect(selectPass).toHaveBeenCalledTimes(2);
  });

  it.each(['low-zoom', 'low-quality'] as const)('does not admit cursor rings at %s', (mode) => {
    atlas.setReducedMotion(false);
    atlas.setLife({ enabled: true });
    if (mode === 'low-zoom') atlas.setCamera({ zoom: 17 });
    else atlas.setQuality('low');
    draw(1000);
    input.intents!.hover([100, 100]);
    draw(1050);
    input.intents!.hover([150, 100]);
    draw(1100);
    expect(vi.mocked(glyphPass).mock.calls.at(-1)![11]!.ripples).toEqual([]);
  });
  it('shifts subcell pans without placement and restores selection after context recreation', () => {
    const reports = vi.fn<(labels: LabelInView[]) => void>();
    atlas.on('labelschange', reports);
    draw(10);
    expect(reports.mock.calls[0]?.[0].length).toBeGreaterThan(0);
    atlas.setSelected('feature/9');
    draw(11);
    const passes = vi.mocked(overlayPass).mock.calls.length;
    atlas.setCamera({ lng: 0.00000001 });
    draw(12);
    expect(overlayPass).toHaveBeenCalledTimes(passes);
    const oldTargets = vi.mocked(overlayPass).mock.calls.at(-1)![1];
    expect(labelMemory(oldTargets)?.size).toBeGreaterThan(0);
    reports.mockClear();
    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    expect(reports.mock.calls).toEqual([[[]]]);
    expect(labelMemory(oldTargets)).toBeUndefined();
    canvas.dispatchEvent(new Event('webglcontextrestored'));
    draw(100);
    expect(focus()).toEqual([9]);
    expect(overlayPass).toHaveBeenCalledTimes(passes + 1);
  });
});
