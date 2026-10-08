import type { CityMeta } from '@atlas/shared';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useAtlasInstance, useAtlasStore } from '@/state/store';
import { useUiStore } from '@/state/ui';
import { AtlasCanvas } from './AtlasCanvas';
import { eventFixtures } from './procession-fixtures.test-utils';
import { emergencyFixture } from './emergency-fixtures.test-utils';
import { loadLandmarks } from '@/lib/content';
import { attachUrlSync } from '@/state/useUrlSync';

const mock = vi.hoisted(() => ({ createAtlas: vi.fn() }));
vi.mock('@atlas/renderer', () => ({ createAtlas: mock.createAtlas, DEFAULT_CELLS: { steps: [] } }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  mock.createAtlas.mockReset();
  vi.useRealTimers();
  window.history.replaceState(null, '', '/');
});

it.each([
  'absent',
  'zero',
  'late',
  '404',
  'malformed',
  'zoom-floor',
  'pointer',
  'recovery',
] as const)(
  'creates the map before optional geography arrives (%s) and installs it in place',
  async (mode) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    let tileFrame = false;
    let frame!: FrameRequestCallback;
    const handlers = new Map<string, () => void>();
    vi.stubGlobal('requestAnimationFrame', (next: FrameRequestCallback) => {
      frame = next;
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      {} as WebGL2RenderingContext,
    );
    const meta: CityMeta = {
      slug: `fixture-${mode}`,
      name: { en: 'Fixture' },
      subdivisionLabel: { en: 'district' },
      languages: ['en'],
      bounds: [1, 2, 3, 4],
      regionBounds: [0, 1, 4, 5],
      defaultCamera: { lat: 3, lng: 2, zoom: 14 },
      yearRange: [1900, 2026],
      attribution: ['A credit'],
    };
    let finishEvents!: (value: Response) => void;
    const events = new Promise<Response>((resolve) => {
      finishEvents = resolve;
    });
    const routes = [eventFixtures[0]!];
    let finishEmergency!: (value: Response) => void;
    const emergency = new Promise<Response>((done) => {
      finishEmergency = done;
    });
    const cityLife =
      mode === 'absent'
        ? undefined
        : {
            source: 'Fixture',
            emergency: {
              source: 'Fixture',
              ambulance: {
                max: mode === 'zero' ? 0 : 1,
                interval_s: [1, 1] as [number, number],
                dwell_s: [1, 1] as [number, number],
              },
            },
          };
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        url.endsWith('.meta.json')
          ? Promise.resolve({ ok: true, json: () => Promise.resolve(meta) })
          : url.endsWith('.landmarks.json')
            ? Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
            : url.endsWith('.emergency.json')
              ? emergency
              : events,
      ),
    );
    const atlas = {
      getStats: () => ({ hasDrawnTileFrame: tileFrame }),
      getCamera: () => ({ ...meta.defaultCamera, zoom: mode === 'zoom-floor' ? 15 : 14 }),
      on: (event: string, handler: () => void) => {
        handlers.set(event, handler);
        return () => {
          handlers.delete(event);
        };
      },
      setProcessions: vi.fn(),
      setEmergency: vi.fn(),
      destroy: vi.fn(),
      setQuality: vi.fn(),
      setSpeech: vi.fn(),
      setLife: vi.fn(),
      setReducedMotion: vi.fn(),
    };
    mock.createAtlas.mockReturnValue(atlas);
    useAtlasInstance.setState({ atlas: null });
    useAtlasStore.setState({ camera: null, selectedId: null, tour: null });
    let detachUrlSync: (() => void) | undefined;
    if (mode === 'zoom-floor') {
      vi.useFakeTimers();
      window.history.replaceState(null, '', '/fixture?z=10');
      detachUrlSync = attachUrlSync();
    }
    const container = document.createElement('div'),
      root = createRoot(container);
    document.body.append(container);
    try {
      await act(async () => {
        root.render(
          createElement(AtlasCanvas, {
            requestLandmarks:
              mode === 'pointer'
                ? () => {
                    void loadLandmarks(`fixture-${mode}`);
                  }
                : undefined,
            metaState: { status: 'ready', meta },
            slug: `fixture-${mode}`,
            name: 'Fixture',
            subdivisionLabel: 'district',
            cityLife,
          }),
        );
        await Promise.resolve();
      });
      expect(mock.createAtlas).toHaveBeenCalledTimes(1);
      if (mode === 'zoom-floor') {
        expect(mock.createAtlas.mock.calls[0]![1]).toMatchObject({ initialCamera: { zoom: 10 } });
        expect(useAtlasStore.getState().camera?.zoom).toBe(15);
        act(() => {
          vi.advanceTimersByTime(250);
        });
        expect(new URLSearchParams(window.location.search).get('z')).toBe('15');
      }
      if (mode === 'pointer') {
        const { interactive } = mock.createAtlas.mock.calls[0]![1] as {
          interactive: (feature: unknown) => boolean;
        };
        const feature = { id: 'osm:way/1', class: 'landmark', landmarkId: 'landmark/test' };
        expect(interactive(feature)).toBe(false);
        expect(interactive(feature)).toBe(false);
        expect(fetch).toHaveBeenCalledTimes(1);
      } else expect(fetch).not.toHaveBeenCalled();
      await act(async () => {
        useUiStore.setState({
          startup: { city: `fixture-${mode}`, atlas: atlas as never, status: 'ready' },
        });
        await Promise.resolve();
      });
      if (mode === 'recovery') {
        act(() => handlers.get('contextlost')!());
        expect(useUiStore.getState().startup?.status).toBe('restoring');
        act(() => handlers.get('contextrestored')!());
        expect(useUiStore.getState().startup?.status).toBe('drawing');
        await act(async () => {
          tileFrame = true;
          frame(100);
          await Promise.resolve();
        });
        expect(useUiStore.getState().startup?.status).toBe('ready');
      }
      const requests = vi
        .mocked(fetch)
        .mock.calls.map(([url]) =>
          typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
        );
      expect(requests.some((url) => url.endsWith('.emergency.json'))).toBe(
        mode !== 'absent' && mode !== 'zero',
      );
      expect(useUiStore.getState().processions).toEqual([]);
      await act(async () => {
        finishEvents({
          ok: true,
          json: () => Promise.resolve({ processions: routes }),
        } as Response);
        await events;
      });
      expect(atlas.setProcessions).toHaveBeenLastCalledWith(routes);
      expect(useUiStore.getState().processions).toEqual(routes);
      expect(mock.createAtlas).toHaveBeenCalledTimes(1);
      expect(atlas.destroy).not.toHaveBeenCalled();
      if (mode !== 'absent' && mode !== 'zero') {
        await act(async () => {
          finishEmergency({
            ok: mode !== '404',
            json: () => Promise.resolve(mode === 'malformed' ? { version: 8 } : emergencyFixture),
          } as Response);
          await emergency;
        });
        expect(atlas.setEmergency).toHaveBeenLastCalledWith(
          mode === 'late' || mode === 'zoom-floor' || mode === 'pointer' || mode === 'recovery'
            ? emergencyFixture
            : undefined,
        );
        expect(mock.createAtlas).toHaveBeenCalledTimes(1);
      }
    } finally {
      detachUrlSync?.();
      act(() => root.unmount());
      container.remove();
    }
  },
);

it.each([true, false])(
  'reports initialization failure according to the actual canvas context (available %s)',
  async (available) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      available ? ({} as WebGL2RenderingContext) : null,
    );
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = new Error('shader compilation failed');
    mock.createAtlas.mockImplementation(() => {
      throw error;
    });
    useAtlasInstance.setState({ atlas: null });
    useAtlasStore.setState({ camera: null });
    const root = createRoot(document.createElement('div'));
    const meta: CityMeta = {
      slug: 'error',
      name: { en: 'Error fixture' },
      subdivisionLabel: { en: 'district' },
      languages: ['en'],
      bounds: [0, 0, 1, 1],
      regionBounds: [0, 0, 1, 1],
      defaultCamera: { lat: 0.5, lng: 0.5, zoom: 15 },
      yearRange: [1900, 2026],
      attribution: [],
    };
    try {
      await act(async () => {
        root.render(
          createElement(AtlasCanvas, {
            slug: 'error',
            name: 'Error fixture',
            subdivisionLabel: 'district',
            metaState: { status: 'ready', meta },
          }),
        );
        await Promise.resolve();
      });
      expect(logged).toHaveBeenCalledWith('Could not initialize the atlas', error);
      expect(useUiStore.getState().startup?.status).toBe(available ? 'error' : 'unsupported');
      expect(useAtlasInstance.getState().atlas).toBeNull();
    } finally {
      act(() => root.unmount());
    }
    expect(useUiStore.getState().startup).toBeNull();
  },
);
