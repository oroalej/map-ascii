import type { Atlas, SeasonState } from '@atlas/renderer';
import type { SeasonConfig } from '@atlas/shared';
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useAtlasInstance } from '@/state/store';
import { useLifeStore } from '@/state/life';
import { SeasonControl, SeasonEvents } from './SeasonControl';
import { useUiStore } from '@/state/ui';
import { eventFixtures } from './procession-fixtures.test-utils';
const seasons: SeasonConfig[] = ['winter', 'feast'].map((id) => ({
  id,
  title: { en: id === 'winter' ? 'Winter' : 'Feast' },
  window: { from: { month: 12, day: 1 }, to: { month: 12, day: 31 } },
  sources: [{ title: 'Calendar', url: 'https://example.com/calendar' }],
  lanterns: { label: 'Stars', shape: 'star' },
}));
let container: HTMLDivElement, root: Root, snapshot: SeasonState | null, change: () => void;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  useUiStore.setState({ processions: [], procession: null });
  snapshot = null;
  change = () => {};
  useAtlasInstance.setState({
    atlas: {
      getSeason: () => snapshot,
      on: (_event: string, handler: () => void) => {
        change = handler;
        return () => {};
      },
    } as unknown as Atlas,
  });
  useLifeStore.setState({ season: 'auto', enabled: false, time: 'night', wind: 'calm' });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
it('shows the five events in occurrence order for picked and Today seasons, and plays only when available', () => {
  const play = vi.fn(() => true),
    fly = vi.fn();
  Object.assign(useAtlasInstance.getState().atlas!, {
    playProcession: play,
    flyTo: fly,
    getCamera: () => ({ zoom: 18 }),
  });
  useUiStore.setState({ processions: [...eventFixtures].reverse() });
  const render = () =>
    root.render(
      createElement(
        Fragment,
        null,
        createElement(SeasonControl, { seasons }),
        createElement(SeasonEvents, { seasons }),
      ),
    );
  act(() => {
    useLifeStore.setState({ season: 'feast', enabled: true });
    render();
  });
  const buttons = () =>
    [...container.querySelectorAll<HTMLButtonElement>('button')].filter((b) =>
      b.textContent?.startsWith('▶'),
    );
  expect(buttons().map((b) => b.textContent)).toEqual(eventFixtures.map((p) => `▶ ${p.label!.en}`));
  act(() => buttons()[0]!.click());
  expect(play).toHaveBeenLastCalledWith('street');
  expect(fly).toHaveBeenLastCalledWith({ lng: 1, lat: 2, zoom: 18 });
  act(() => buttons()[1]!.click());
  expect(fly).toHaveBeenLastCalledWith({ lng: 1.0001, lat: 2.0001, zoom: 18 });
  play.mockReturnValue(false);
  fly.mockClear();
  act(() => buttons()[0]!.click());
  expect(fly).not.toHaveBeenCalled();
  act(() => useLifeStore.setState({ enabled: false }));
  expect(buttons().every((b) => b.disabled)).toBe(true);
  act(() => useLifeStore.setState({ season: 'winter' }));
  expect(buttons()).toHaveLength(0);
  act(() => {
    useLifeStore.setState({ season: 'auto' });
    snapshot = { id: 'feast', title: 'Feast', labels: {} };
    change();
  });
  expect(buttons()).toHaveLength(5);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useAtlasInstance.setState({ atlas: null });
  useLifeStore.setState({ season: 'auto' });
  vi.unstubAllGlobals();
});
it('cycles Today and pack titles, shows the active season, and preserves other preferences', () => {
  act(() => root.render(createElement(SeasonControl, { seasons })));
  const button = () => container.querySelector('button')!;
  expect(button().textContent).toBe('Today');
  act(() => {
    snapshot = { id: 'winter', title: 'Winter', labels: { lanterns: 'Stars' } };
    change();
  });
  expect(button().textContent).toBe('Today · Winter');
  expect(button().title).toBe('Preview seasonal decorations');
  act(() => button().click());
  expect(useLifeStore.getState().season).toBe('winter');
  expect(button().textContent).toBe('Winter');
  act(() => button().click());
  expect(button().textContent).toBe('Feast');
  act(() => button().click());
  expect(button().textContent).toBe('Today · Winter');
  expect(useLifeStore.getState()).toMatchObject({ enabled: false, time: 'night', wind: 'calm' });
});
it('hides for a pack with no seasons and tolerates an obsolete choice', () => {
  act(() => root.render(createElement(SeasonControl, {})));
  expect(container.querySelector('button')).toBe(null);
  act(() => {
    useLifeStore.setState({ season: 'obsolete' });
    root.render(createElement(SeasonControl, { seasons }));
  });
  expect(container.querySelector('button')!.textContent).toBe('Today');
  act(() => container.querySelector('button')!.click());
  expect(useLifeStore.getState().season).toBe('winter');
});
