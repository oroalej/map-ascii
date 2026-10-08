import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useAtlasInstance, useAtlasStore } from '@/state/store';
import { useUiStore } from '@/state/ui';
import { AtlasCanvas } from './AtlasCanvas';
import { eventFixtures } from './procession-fixtures.test-utils';
import { emergencyFixture } from './emergency-fixtures.test-utils';
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

it.each(['absent', 'zero', 'late', '404', 'malformed', 'zoom-floor'] as const)(
  'creates the map before optional geography arrives (%s) and installs it in place',
  async (mode) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      {} as WebGL2RenderingContext,
    );
    const meta = {
      slug: 'fixture',
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
          : url.endsWith('.emergency.json')
            ? emergency
            : events,
      ),
    );
    const atlas = {
      getCamera: () => ({ ...meta.defaultCamera, zoom: mode === 'zoom-floor' ? 15 : 14 }),
      on: () => () => {},
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
            slug: 'fixture',
            tilesVersion: '1234abcd',
            name: 'Fixture',
            subdivisionLabel: 'district',
            cityLife,
          }),
        );
        await Promise.resolve();
      });
      expect(mock.createAtlas.mock.calls[0]![1]).toMatchObject({ tilesVersion: '1234abcd' });
      expect(mock.createAtlas).toHaveBeenCalledTimes(1);
      if (mode === 'zoom-floor') {
        expect(mock.createAtlas.mock.calls[0]![1]).toMatchObject({ initialCamera: { zoom: 10 } });
        expect(useAtlasStore.getState().camera?.zoom).toBe(15);
        act(() => {
          vi.advanceTimersByTime(250);
        });
        expect(new URLSearchParams(window.location.search).get('z')).toBe('15');
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
      expect(mock.createAtlas.mock.calls[0]![1]).toMatchObject({ tilesVersion: '1234abcd' });
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
          mode === 'late' || mode === 'zoom-floor' ? emergencyFixture : undefined,
        );
        expect(mock.createAtlas.mock.calls[0]![1]).toMatchObject({ tilesVersion: '1234abcd' });
        expect(mock.createAtlas).toHaveBeenCalledTimes(1);
      }
    } finally {
      detachUrlSync?.();
      act(() => root.unmount());
      container.remove();
    }
  },
);
