import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useAtlasInstance, useAtlasStore } from '@/state/store';
import { useUiStore } from '@/state/ui';
import { AtlasCanvas } from './AtlasCanvas';
import { eventFixtures } from './procession-fixtures.test-utils';

const mock = vi.hoisted(() => ({ createAtlas: vi.fn() }));
vi.mock('@atlas/renderer', () => ({ createAtlas: mock.createAtlas, DEFAULT_CELLS: { steps: [] } }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  mock.createAtlas.mockReset();
});

it('creates the map before optional events arrive and installs them on the same instance', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as WebGL2RenderingContext);
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
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      url.endsWith('.meta.json')
        ? Promise.resolve({ ok: true, json: () => Promise.resolve(meta) })
        : events,
    ),
  );
  const atlas = {
    getCamera: () => meta.defaultCamera,
    on: () => () => {},
    setProcessions: vi.fn(),
    destroy: vi.fn(),
    setQuality: vi.fn(),
    setSpeech: vi.fn(),
    setLife: vi.fn(),
    setReducedMotion: vi.fn(),
  };
  mock.createAtlas.mockReturnValue(atlas);
  useAtlasInstance.setState({ atlas: null });
  useAtlasStore.setState({ camera: null });
  const container = document.createElement('div'),
    root = createRoot(container);
  document.body.append(container);
  try {
    await act(async () => {
      root.render(
        createElement(AtlasCanvas, {
          slug: 'fixture',
          name: 'Fixture',
          subdivisionLabel: 'district',
        }),
      );
      await Promise.resolve();
    });
    expect(mock.createAtlas).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().processions).toEqual([]);
    await act(async () => {
      finishEvents({ ok: true, json: () => Promise.resolve({ processions: routes }) } as Response);
      await events;
    });
    expect(atlas.setProcessions).toHaveBeenLastCalledWith(routes);
    expect(useUiStore.getState().processions).toEqual(routes);
    expect(mock.createAtlas).toHaveBeenCalledTimes(1);
    expect(atlas.destroy).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
