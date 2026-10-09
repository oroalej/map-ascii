import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import type { Atlas } from '@atlas/renderer';
import type { RuntimeCityLife } from '@atlas/shared';
import { afterEach, expect, it, vi } from 'vitest';
import { useAtlasStore, initialAtlasState, useAtlasInstance } from '@/state/store';
import { useUiStore } from '@/state/ui';
import { useTourStore } from '@/state/tour';
import { useLifeStore } from '@/state/life';
import fixture from '@/lib/__fixtures__/ui-payloads.json';
import { encodeInlineRuntime } from '@/lib/inline-runtime-server';
import { CityAtlas, type CityAtlasProps } from './CityAtlas';
const consumers = vi.hoisted(() => ({ canvas: vi.fn(), hud: vi.fn() }));
vi.mock('next/dynamic', () => ({
  default: (loader: () => unknown) => {
    const name = /m\.(\w+)/.exec(loader.toString())?.[1] ?? 'unknown';
    return (props: { landmarks?: unknown[] }) => {
      if (name === 'AtlasCanvas') {
        consumers.canvas(props);
        return null;
      }
      return createElement('span', { 'data-lazy': name, 'data-count': props.landmarks?.length });
    };
  },
}));
vi.mock('./Hud', () => ({
  Hud: (props: unknown) => {
    consumers.hud(props);
    return null;
  },
}));
vi.mock('./SearchBox', () => ({ SearchBox: () => null }));
vi.mock('./PlacesInView', () => ({ PlacesInView: () => null }));
vi.mock('./Attribution', () => ({ Attribution: () => null }));
vi.mock('@/state/useTourPlayer', () => ({ useTourPlayer: () => {} }));
vi.mock('@/state/useUrlSync', () => ({ useUrlSync: () => {} }));
vi.mock('@/state/useAtlasEvents', () => ({ useAtlasEvents: () => {} }));
vi.mock('./InteractionDetails', () => ({}));
const props: CityAtlasProps = {
  slug: 'fixture',
  name: 'Fixture City',
  hasTours: true,
  subdivisionLabel: 'district',
  runtimeGzip: encodeInlineRuntime({}),
  metaState: {
    status: 'ready',
    meta: {
      slug: 'fixture',
      name: { en: 'Fixture City' },
      subdivisionLabel: { en: 'district' },
      languages: ['en'],
      bounds: [0, 0, 1, 1],
      regionBounds: [0, 0, 1, 1],
      defaultCamera: { lat: 0, lng: 0, zoom: 15 },
      yearRange: [1900, 2026],
      attribution: [],
    },
  },
};
afterEach(() => {
  vi.unstubAllGlobals();
  useAtlasInstance.setState({ atlas: null });
  useUiStore.setState({ startup: null, selection: null, hover: null, lifeHover: null });
});
it('decodes inline Life before the canvas and server HUD consume it', () => {
  const cityLife: RuntimeCityLife = {
    source: 'https://example.com/history',
    rhythm: { person: [[0, 0.5]] },
  };
  const runtimeGzip = encodeInlineRuntime({ cityLife });
  renderToString(createElement(CityAtlas, { ...props, runtimeGzip }));
  expect(consumers.canvas).toHaveBeenLastCalledWith(expect.objectContaining({ cityLife }));
  expect(consumers.hud).toHaveBeenLastCalledWith(
    expect.objectContaining({ dialogue: undefined, seasons: undefined }),
  );
});
it('keeps Drawing and the Tours trigger in the server output before the canvas resolves', () => {
  const html = renderToString(createElement(CityAtlas, props));
  expect(html).toContain('Drawing Fixture City…');
  expect(html).toContain('aria-keyshortcuts="T"');
  expect(html).not.toContain('data-lazy');
  const missing = renderToString(
    createElement(CityAtlas, { ...props, hasTours: false, metaState: { status: 'missing' } }),
  );
  expect(missing).toContain('No map data');
  expect(missing).not.toContain('Drawing');
  expect(missing).not.toContain('aria-keyshortcuts="T"');
});
it('loads delayed selected facts before readiness, gates cues/agent tooltips, and suppresses Drawing on errors', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  let finish!: (response: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((done) => {
          finish = done;
        }),
    ),
  );
  useAtlasStore.setState({
    ...initialAtlasState(),
    selectedId: null,
    camera: { lat: 0, lng: 0, zoom: 17 },
  });
  useUiStore.setState({ selection: null, startup: null, hover: null, lifeHover: null });
  useTourStore.setState({ active: null, menuOpen: false });
  useLifeStore.setState({ enabled: true });
  const container = document.createElement('div'),
    root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(CityAtlas, props));
      await Promise.resolve();
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Drawing');
    act(() => {
      useAtlasStore.getState().setSelected(fixture.landmarks[0]!.osm_id);
      useUiStore.setState({
        selection: { id: fixture.landmarks[0]!.osm_id, origin: 'programmatic', sequence: 1 },
      });
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-lazy=LandmarkFacts]')?.getAttribute('data-count')).toBe(
      '0',
    );
    await act(async () => {
      finish({ ok: true, json: () => Promise.resolve(fixture.landmarks) } as Response);
      await Promise.resolve();
    });
    expect(container.querySelector('[data-lazy=LandmarkFacts]')?.getAttribute('data-count')).toBe(
      '1',
    );
    act(() => {
      useAtlasStore.getState().setCamera({ zoom: 18 });
      useUiStore.setState({ lifeHover: { label: 'Person (simulated)', point: [1, 1] } as never });
    });
    expect(container.querySelector('[data-lazy=HoverTooltip]')).not.toBeNull();
    expect(container.querySelector('[data-lazy=CueBubbles]')).not.toBeNull();
    const atlas = {} as Atlas;
    act(() => {
      useAtlasInstance.setState({ atlas });
      useUiStore.setState({ startup: { city: 'fixture', atlas, status: 'ready' } });
    });
    expect(container.textContent).not.toContain('Drawing');
    act(() => useUiStore.setState({ startup: { city: 'fixture', atlas, status: 'restoring' } }));
    expect(container.textContent).toContain('Restoring the map');
    expect(container.textContent).not.toContain('Drawing');
    act(() =>
      useUiStore.setState({ startup: { city: 'fixture', atlas: null, status: 'unsupported' } }),
    );
    expect(container.querySelector('[role=alert]')?.textContent).toContain('WebGL2');
    expect(container.textContent).not.toContain('Drawing');
    act(() => useUiStore.setState({ startup: { city: 'fixture', atlas: null, status: 'error' } }));
    expect(container.querySelector('[role=alert]')?.textContent).toContain('Unable to draw');
    expect(container.textContent).not.toContain('WebGL2');
    expect(container.textContent).not.toContain('Drawing');
    act(() => useUiStore.setState({ startup: null }));
    expect(container.textContent).toContain('Drawing');
  } finally {
    act(() => root.unmount());
  }
});
