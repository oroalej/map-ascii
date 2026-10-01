import type { Atlas, AtlasEventMap } from '@atlas/renderer';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initialAtlasState, useAtlasInstance, useAtlasStore } from '@/state/store';
import { useLifeStore } from '@/state/life';
import { Hud } from './Hud';

function renderer() {
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
      getStats: () => ({ quality: { choice: 'high', tier: 0, name: 'high' } }),
    } as unknown as Atlas,
    emit<K extends keyof AtlasEventMap>(event: K, value: AtlasEventMap[K]) {
      for (const listener of listeners.get(event) ?? []) listener(value);
    },
    listeners,
  };
}

let container: HTMLDivElement, root: Root;
const legend = () => container.querySelector('details')!;
const labels = () => [...legend().querySelectorAll('li')].map((li) => li.textContent);
const select = (id: string | null) => act(() => useAtlasStore.getState().setSelected(id));

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(min-width: 640px)',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([]) }));
  useAtlasStore.setState({ ...initialAtlasState(), camera: { lng: 0, lat: 0, zoom: 19 } });
  useLifeStore.setState({ enabled: false });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useAtlasInstance.setState({ atlas: null });
  useAtlasStore.setState(initialAtlasState());
  useLifeStore.setState({ enabled: true });
  vi.unstubAllGlobals();
});

const mount = async (instance: ReturnType<typeof renderer>) => {
  useAtlasInstance.setState({ atlas: instance.atlas });
  await act(async () => {
    root.render(createElement(Hud, { city: 'test', subdivisionLabel: 'ward' }));
    await Promise.resolve();
  });
};

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
  expect(legend().hidden).toBe(true);
  select(null);
  expect(legend().hidden).toBe(false);
  expect(legend().open).toBe(false);
  expect(labels()).toEqual(before);
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
