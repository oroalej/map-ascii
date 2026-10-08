// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CityMeta, Tour } from '@atlas/shared';
import { useUiStore } from '@/state/ui';
import { initialAtlasState, useAtlasInstance, useAtlasStore } from '@/state/store';
import { useAtlasEvents } from '@/state/useAtlasEvents';
import { useTourPlayer } from '@/state/useTourPlayer';
import { tourControls, useTourStore } from '@/state/tour';
import { Attribution } from './Attribution';

const tours: readonly Tour[] = [];
function WithGlobalEscapeHandlers() {
  useAtlasEvents();
  useTourPlayer(tours);
  return createElement(Attribution);
}
let container: HTMLDivElement, root: Root;
const observe = vi.fn(),
  disconnect = vi.fn();
const button = () => container.querySelector<HTMLButtonElement>('button')!;
const region = () => container.querySelector<HTMLElement>('[role="region"]');
const setCredits = (attribution: string[]) =>
  useUiStore.setState({ meta: { attribution } as CityMeta });
const mount = (globalHandlers = false) =>
  act(() => root.render(createElement(globalHandlers ? WithGlobalEscapeHandlers : Attribution)));

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = observe;
      disconnect = disconnect;
    },
  );
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(16);
  observe.mockClear();
  disconnect.mockClear();
  useAtlasInstance.setState({ atlas: null });
  useAtlasStore.setState(initialAtlasState());
  useUiStore.setState({ meta: null, legendFocus: null });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('always links OSM and omits Sources when there are no additional credits', () => {
  setCredits(['© OpenStreetMap contributors']);
  mount();
  const link = container.querySelector('a')!;
  expect(link.textContent).toBe('OpenStreetMap contributors');
  expect(link.href).toBe('https://www.openstreetmap.org/copyright');
  expect(container.querySelector('button')).toBeNull();
  expect(region()).toBeNull();
});

it('opens every additional credit and link above a separately measured OSM row', () => {
  setCredits([
    '© OpenStreetMap contributors',
    'Terrain https://example.com/dem',
    'Details https://example.com/details',
  ]);
  mount();
  expect(region()).toBeNull();
  expect(button().getAttribute('aria-expanded')).toBe('false');
  const measuredRow = observe.mock.calls[0]![0] as HTMLElement;
  expect(measuredRow).not.toBe(container.querySelector('footer'));
  expect(document.documentElement.style.getPropertyValue('--attribution-height')).toBe('16px');
  act(() => button().click());
  expect(button().getAttribute('aria-expanded')).toBe('true');
  expect(button().getAttribute('aria-controls')).toBe(region()!.id);
  expect(region()!.getAttribute('aria-label')).toBe('Additional map sources');
  expect(region()!.tabIndex).toBe(0);
  expect([...region()!.querySelectorAll('a')].map((a) => a.href)).toEqual([
    'https://example.com/dem',
    'https://example.com/details',
  ]);
  expect(region()!.textContent).toContain('Terrain');
  expect(region()!.textContent).toContain('Details');
  expect(measuredRow.contains(region())).toBe(false);
  expect(container.querySelector('footer')!.dataset.open).toBe('true');
  act(() => {
    region()!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  });
  expect(region()).not.toBeNull();
  act(() => button().click());
  expect(region()).toBeNull();
  expect(container.querySelector('footer')!.dataset.open).toBe('false');
});

it('closes on outside press and owns Escape before global map and tour handlers', () => {
  setCredits(['Terrain source']);
  mount(true);
  const tour = { id: 'fixture', step: 0, paused: true };
  act(() => {
    useTourStore.setState({
      tours: [
        {
          id: 'tour/fixture',
          title: { en: 'Fixture' },
          status: 'draft',
          steps: [
            {
              camera: { lng: 0, lat: 0, zoom: 19 },
              duration_ms: 4000,
              narration: { en: 'Fixture' },
            },
          ],
        },
      ],
    });
    tourControls.restore('fixture', 0);
    useAtlasStore.setState({ selectedId: 'osm:way/1', tour });
    useUiStore.setState({ legendFocus: 'info:folklore' });
    button().click();
  });
  region()!.focus();
  const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  act(() => {
    region()!.dispatchEvent(escape);
  });
  expect(escape.defaultPrevented).toBe(true);
  expect(region()).toBeNull();
  expect(document.activeElement).toBe(button());
  expect(useAtlasStore.getState()).toMatchObject({ selectedId: 'osm:way/1', tour });
  expect(useUiStore.getState().legendFocus).toBe('info:folklore');
  expect(useTourStore.getState().active?.tour.id).toBe('tour/fixture');
  act(() => button().click());
  act(() => {
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  });
  expect(region()).toBeNull();
  expect(button().getAttribute('aria-expanded')).toBe('false');
  // Once closed, the capture listener is gone and global Escape works again.
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
  });
  expect(useAtlasStore.getState().selectedId).toBeNull();
  expect(useAtlasStore.getState().tour).toBeNull();
  expect(useUiStore.getState().legendFocus).toBeNull();
});
