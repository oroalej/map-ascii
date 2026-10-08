import type { Atlas, AtlasEventMap, LegendFocus } from '@atlas/renderer';
import * as rendererExports from '@atlas/renderer';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initialAtlasState, useAtlasInstance, useAtlasStore } from '@/state/store';
import { useLifeStore } from '@/state/life';
import { useEmojiStore } from '@/state/emoji';
import { useUiStore } from '@/state/ui';
import { Hud } from './Hud';
import { eventFixtures } from './procession-fixtures.test-utils';
import { eventOccurrence, eventTime, type RuntimeSeasonConfig } from '@atlas/shared';

function renderer() {
  const focus = vi.fn<(descriptor: LegendFocus | null) => void>();
  const listeners = new Map<keyof AtlasEventMap, Set<(value: unknown) => void>>();
  const on: Atlas['on'] = (event, handler) => {
    const listener = (value: unknown) => handler(value as AtlasEventMap[typeof event]);
    const subscribers = listeners.get(event) ?? new Set();
    subscribers.add(listener);
    listeners.set(event, subscribers);
    return () => {
      subscribers.delete(listener);
    };
  };
  return {
    atlas: {
      on,
      getSeason: () => null,
      setFocus: focus,
      getStats: () => ({ quality: { choice: 'high', tier: 0, name: 'high' } }),
    } as unknown as Atlas,
    emit<K extends keyof AtlasEventMap>(event: K, value: AtlasEventMap[K]) {
      for (const listener of listeners.get(event) ?? []) listener(value);
    },
    listeners,
    focus,
  };
}

let container: HTMLDivElement, root: Root;
const legend = () => container.querySelector('details')!;
const labels = () => [...legend().querySelectorAll('li')].map((li) => li.textContent);
const select = (id: string | null) => act(() => useAtlasStore.getState().setSelected(id));

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([]) }));
  useAtlasStore.setState({ ...initialAtlasState(), camera: { lng: 0, lat: 0, zoom: 19 } });
  useLifeStore.setState({ enabled: false });
  useEmojiStore.setState({ enabled: true });
  useUiStore.setState({
    legendFocus: null,
    lifeHover: null,
    processions: [],
    procession: null,
    factsVisible: false,
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
it('passes the illustrative rice disclosure to the legend and restores the absent-calendar label', async () => {
  const instance = renderer();
  useAtlasInstance.setState({ atlas: instance.atlas });
  const climate = {
    wind: [],
    default: { from: 90, strength: 'breeze' as const },
    source: 'Fixture',
    crops: {
      rice: {
        calendar: [
          { from: '01-01', stage: 'fallow' as const },
          { from: '06-01', stage: 'growing' as const },
        ],
        source: 'Fixture',
      },
    },
  };
  await act(async () => {
    root.render(createElement(Hud, { city: 'test', subdivisionLabel: 'district', climate }));
    await Promise.resolve();
  });
  act(() => instance.emit('classeschange', ['farmland']));
  expect(labels().some((label) => label?.includes('Farmland (illustrative rice stages)'))).toBe(
    true,
  );
  await act(async () => {
    root.render(createElement(Hud, { city: 'test', subdivisionLabel: 'district' }));
    await Promise.resolve();
  });
  expect(labels().some((label) => label?.includes('illustrative rice'))).toBe(false);
  expect(labels().some((label) => label?.includes('Farmland'))).toBe(true);
});

it('keeps seasonal buttons in one row, preserves captions across seasons and restores the viewer clock', async () => {
  const instance = renderer(),
    stop = vi.fn(),
    play = vi.fn(() => true);
  Object.assign(instance.atlas, {
    stopProcession: stop,
    playProcession: play,
    flyTo: vi.fn(),
    getCamera: () => ({ zoom: 19 }),
  });
  const seasons: RuntimeSeasonConfig[] = [
    {
      id: 'feast',
      title: { en: 'Feast' },
      window: { from: { month: 9, day: 1 }, to: { month: 9, day: 30 } },
    },
    {
      id: 'winter',
      title: { en: 'Winter' },
      window: { from: { month: 12, day: 1 }, to: { month: 12, day: 31 } },
    },
  ];
  const legacy = {
    ...eventFixtures[3]!,
    id: 'legacy',
    season: undefined,
    label: undefined,
    title: { en: 'Legacy river' },
  };
  useAtlasInstance.setState({ atlas: instance.atlas });
  useLifeStore.setState({ enabled: true, time: 'night', season: 'feast' });
  useUiStore.setState({ processions: [...eventFixtures, legacy] });
  await act(async () => {
    root.render(createElement(Hud, { city: 'test', subdivisionLabel: 'district', seasons }));
    await Promise.resolve();
  });
  const buttons = () => [...container.querySelectorAll<HTMLButtonElement>('button')];
  expect(buttons().filter((b) => b.textContent === '▶ Fluvial')).toHaveLength(1);
  expect(buttons().some((b) => b.textContent === '▶ Legacy river')).toBe(true);
  const timing = eventOccurrence(eventFixtures[0]!.schedule, new Date('2026-06-01'));
  const run = (progress: number) => ({
    id: 'street',
    live: false,
    progress,
    time: eventTime(timing, progress),
  });
  act(() => useUiStore.setState({ procession: run(0) }));
  expect(container.textContent).toContain('draft: route and schedule not yet verified');
  expect(buttons().find((b) => b.textContent === '12:00 · event')?.disabled).toBe(true);
  act(() => useUiStore.setState({ procession: run(0.25) }));
  expect(buttons().find((b) => b.textContent === '13:00 · event')?.disabled).toBe(true);
  act(() => useLifeStore.setState({ season: 'winter' }));
  expect(buttons().some((b) => b.textContent === '▶ Procession')).toBe(false);
  expect(
    [...container.querySelectorAll('[role=status]')].some((s) =>
      s.textContent?.includes('(simulated)'),
    ),
  ).toBe(true);
  act(() =>
    buttons()
      .find((b) => b.textContent === 'Stop')!
      .click(),
  );
  expect(stop).toHaveBeenCalledOnce();
  for (const id of ['cathedral', 'basilica']) {
    act(() => useUiStore.setState({ procession: { ...run(0), id } }));
    expect(container.textContent).toContain('draft: gathering and schedule not yet verified');
    expect(container.textContent).not.toContain('draft: route and schedule not yet verified');
  }
  act(() => useUiStore.setState({ procession: null }));
  expect(buttons().find((b) => b.textContent === 'Time: 22:00')?.disabled).toBe(false);
  expect(useLifeStore.getState().time).toBe('night');
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useAtlasInstance.setState({ atlas: null });
  useAtlasStore.setState(initialAtlasState());
  useLifeStore.setState({ enabled: true });
  useEmojiStore.setState({ enabled: true });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([640, 640.5, 641])('matches the compact CSS breakpoint at %s CSS pixels', async (width) => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(max-width: 640px)' && width <= 640,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  await mount(renderer());
  expect(legend().open).toBe(width > 640);
});

it('suppresses phone bottom controls for visible facts and retains tour suppression after close', async () => {
  await mount(renderer());
  const controls = container.querySelector('[data-touring]')!;
  expect(controls.getAttribute('data-touring')).toBe('false');
  act(() => useUiStore.setState({ factsVisible: true }));
  expect(controls.getAttribute('data-touring')).toBe('true');
  act(() => useUiStore.setState({ factsVisible: false }));
  expect(controls.getAttribute('data-touring')).toBe('false');
  act(() => useAtlasStore.setState({ tour: { id: 'tour/test', step: 0, paused: true } }));
  expect(controls.getAttribute('data-touring')).toBe('true');
  act(() => useUiStore.setState({ factsVisible: true }));
  act(() => useUiStore.setState({ factsVisible: false }));
  expect(controls.getAttribute('data-touring')).toBe('true');
  act(() => useAtlasStore.setState({ tour: null }));
  expect(controls.getAttribute('data-touring')).toBe('false');
});

it('keeps a clear control outside the collapsed/hidden legend and preserves selection when cleared', async () => {
  const instance = renderer();
  await mount(instance);
  act(() => instance.emit('classeschange', ['road_mid']));
  const road = legend().querySelector<HTMLButtonElement>('button')!;
  const clear = () =>
    container.querySelector<HTMLButtonElement>('button[aria-label^="Clear legend focus:"]');
  act(() => road.click());
  expect(clear()?.textContent).toContain('Focus: Secondary road');
  expect(clear()?.closest('details')).toBeNull();
  act(() => legend().querySelector('summary')!.click());
  act(() => clear()!.click());
  expect(useUiStore.getState().legendFocus).toBeNull();
  expect(document.activeElement).toBe(legend().querySelector('summary'));
  expect(instance.focus).toHaveBeenLastCalledWith(null);
  act(() => road.click());
  select('place');
  act(() => useUiStore.setState({ factsVisible: true }));
  expect(legend().hidden).toBe(true);
  expect(clear()).not.toBeNull();
  const map = document.createElement('canvas');
  map.tabIndex = 0;
  document.body.append(map);
  act(() => clear()!.click());
  expect(useAtlasStore.getState().selectedId).toBe('place');
  expect(useUiStore.getState().legendFocus).toBeNull();
  expect(document.activeElement).toBe(map);
  expect(clear()).toBeNull();
  map.remove();
});

it('retains selected IDs and updates the clear label when display wording changes', async () => {
  const original = rendererExports.legendEntries;
  let name = 'Secondary road';
  vi.spyOn(rendererExports, 'legendEntries').mockImplementation((...args) =>
    original(...args).map((entry) =>
      entry.id === 'class:road_mid' ? { ...entry, label: name } : entry,
    ),
  );
  const instance = renderer();
  await mount(instance);
  act(() => instance.emit('classeschange', ['road_mid']));
  act(() => legend().querySelector<HTMLButtonElement>('button')!.click());
  expect(useUiStore.getState().legendFocus).toBe('class:road_mid');
  name = 'Translated road';
  act(() => useAtlasStore.setState({ theme: 'light' }));
  expect(useUiStore.getState().legendFocus).toBe('class:road_mid');
  expect(
    container.querySelector('button[aria-label="Clear legend focus: Translated road"]'),
  ).not.toBeNull();
  expect(legend().querySelector('button[aria-pressed="true"]')?.textContent).toContain(name);
});

it('publishes focus clearance for sheet layout and removes it on clear and unmount', async () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    bottom: 100,
  } as DOMRect);
  const instance = renderer();
  await mount(instance);
  const style = document.documentElement.style;
  expect(style.getPropertyValue('--hud-header-bottom')).toBe('100px');
  act(() => instance.emit('classeschange', ['road_mid']));
  act(() => legend().querySelector<HTMLButtonElement>('button')!.click());
  expect(style.getPropertyValue('--focus-header-bottom')).toBe('100px');
  act(() =>
    container
      .querySelector<HTMLButtonElement>('button[aria-label^="Clear legend focus:"]')!
      .click(),
  );
  expect(style.getPropertyValue('--focus-header-bottom')).toBe('');
  act(() => root.render(null));
  expect(style.getPropertyValue('--hud-header-bottom')).toBe('');
});

const mount = async (instance: ReturnType<typeof renderer>) => {
  useAtlasInstance.setState({ atlas: instance.atlas });
  await act(async () => {
    root.render(createElement(Hud, { city: 'test', subdivisionLabel: 'ward' }));
    await Promise.resolve();
  });
};
it('shows folklore at z15 and drops visibility on Life off, events and renderer replacement', async () => {
  const instance = renderer();
  useLifeStore.setState({ enabled: true });
  useAtlasStore.setState({ camera: { lng: 0, lat: 0, zoom: 15 } });
  await mount(instance);
  const shown = () => labels().some((l) => l?.includes('Folklore (simulated)'));
  expect(shown()).toBe(false);
  act(() => instance.emit('folklorechange', true));
  expect(shown()).toBe(true);
  act(() => useLifeStore.setState({ enabled: false }));
  expect(shown()).toBe(false);
  act(() => useLifeStore.setState({ enabled: true }));
  act(() => instance.emit('folklorechange', false));
  expect(shown()).toBe(false);
  act(() => instance.emit('folklorechange', true));
  const next = renderer();
  await mount(next);
  expect(shown()).toBe(false);
  act(() => instance.emit('folklorechange', true));
  expect(shown()).toBe(false);
});

it('updates the mood legend when emoji is toggled without replacing the atlas', async () => {
  const instance = renderer();
  useLifeStore.setState({ enabled: true });
  await mount(instance);
  const moods = () =>
    labels().some((label) => label?.includes('simulated') && /moods/i.test(label));
  expect(moods()).toBe(true);
  act(() => useEmojiStore.setState({ enabled: false }));
  expect(moods()).toBe(false);
  act(() => useEmojiStore.setState({ enabled: true }));
  expect(moods()).toBe(true);
  expect(useAtlasInstance.getState().atlas).toBe(instance.atlas);
});

it('toggles one focus, retains it through collapse and panels, and clears missing entries or atlas swaps', async () => {
  const instance = renderer();
  await mount(instance);
  act(() => instance.emit('classeschange', ['road_mid', 'water_river']));
  const buttons = () => [...legend().querySelectorAll<HTMLButtonElement>('button')];
  const road = buttons().find((button) => /road/i.test(button.textContent ?? ''))!;
  expect(road).toBeDefined();
  act(() => road.click());
  expect(road.getAttribute('aria-pressed')).toBe('true');
  expect(instance.focus).toHaveBeenLastCalledWith({ classes: ['road_mid'], life: [] });
  const key = useUiStore.getState().legendFocus;
  act(() => legend().querySelector('summary')!.click());
  select('place');
  select(null);
  expect(useUiStore.getState().legendFocus).toBe(key);
  act(() => road.click());
  expect(useUiStore.getState().legendFocus).toBeNull();
  act(() => road.click());
  act(() => instance.emit('classeschange', ['water_river']));
  expect(useUiStore.getState().legendFocus).toBeNull();
  act(() => buttons()[0]!.click());
  const next = renderer();
  act(() => useAtlasInstance.setState({ atlas: next.atlas }));
  expect(useUiStore.getState().legendFocus).toBeNull();
  expect(instance.focus).toHaveBeenLastCalledWith(null);
  expect(next.focus).toHaveBeenLastCalledWith(null);
});

it('retains fixture entries and the collapsed preference after a panel closes without new events', async () => {
  const instance = renderer();
  await mount(instance);
  act(() => {
    instance.emit('fixtureschange', { streetlights: true, trafficSignals: true, utilities: false });
    instance.emit('classeschange', ['road_mid']);
    instance.emit('lightschange', true);
  });
  expect(labels().join(' ')).toContain('Streetlights');
  expect(labels().join(' ')).toContain('Traffic signals');
  const before = labels();
  act(() => {
    legend().querySelector('summary')!.click();
  });
  // Flush the native details toggle event before opening the panel.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(legend().open).toBe(false);
  select('place');
  expect(legend().hidden).toBe(false);
  act(() => useUiStore.setState({ factsVisible: true }));
  expect(legend().hidden).toBe(true);
  act(() => useUiStore.setState({ factsVisible: false }));
  expect(useAtlasStore.getState().selectedId).toBe('place');
  expect(legend().hidden).toBe(false);
  act(() => useUiStore.setState({ factsVisible: true }));
  expect(legend().hidden).toBe(true);
  select(null);
  act(() => useUiStore.setState({ factsVisible: false }));
  expect(legend().hidden).toBe(false);
  expect(legend().open).toBe(false);
  expect(labels()).toEqual(before);
});

it('replaces focus, updates merged descriptors and clears Life focus when Life is disabled', async () => {
  const instance = renderer();
  useLifeStore.setState({ enabled: true });
  await mount(instance);
  const button = (name: string) =>
    [...legend().querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.endsWith(name),
    )!;
  act(() => instance.emit('classeschange', ['building_school', 'road_mid']));
  act(() => button('School').click());
  const label = useUiStore.getState().legendFocus;
  act(() => instance.emit('classeschange', ['building_school', 'marker_school', 'road_mid']));
  expect(useUiStore.getState().legendFocus).toBe(label);
  expect(instance.focus.mock.calls.at(-1)![0]?.classes).toContain('marker_school');
  act(() => button('Street vendors (simulated)').click());
  expect(button('School').getAttribute('aria-pressed')).toBe('false');
  expect(button('Street vendors (simulated)').getAttribute('aria-pressed')).toBe('true');
  act(() =>
    instance.emit('fixtureschange', { streetlights: true, trafficSignals: true, utilities: true }),
  );
  expect(button('Streetlights')).toBeUndefined();
  expect(button('Utility poles and wires (illustrative)')).toBeUndefined();
  act(() => useLifeStore.setState({ enabled: false }));
  expect(useUiStore.getState().legendFocus).toBeNull();
  expect(instance.focus).toHaveBeenLastCalledWith(null);
});

it('receives fixture changes while hidden and forgets the old atlas when replaced', async () => {
  const previous = renderer();
  await mount(previous);
  act(() =>
    previous.emit('fixtureschange', {
      streetlights: true,
      trafficSignals: false,
      utilities: false,
    }),
  );
  select('place');
  act(() =>
    previous.emit('fixtureschange', {
      streetlights: false,
      trafficSignals: true,
      utilities: false,
    }),
  );
  select(null);
  expect(labels().join(' ')).not.toContain('Streetlights');
  expect(labels().join(' ')).toContain('Traffic signals');

  select('place');
  const next = renderer();
  act(() => useAtlasInstance.setState({ atlas: next.atlas }));
  expect(previous.listeners.get('fixtureschange')?.size).toBe(0);
  select(null);
  expect(labels().join(' ')).not.toContain('Traffic signals');
  act(() =>
    next.emit('fixtureschange', { streetlights: true, trafficSignals: false, utilities: false }),
  );
  expect(labels().join(' ')).toContain('Streetlights');
  expect(labels().join(' ')).not.toContain('Traffic signals');
});
