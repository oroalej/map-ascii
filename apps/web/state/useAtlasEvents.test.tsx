// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { Atlas, AtlasEventMap } from '@atlas/renderer';
import type { Tour } from '@atlas/shared';
import { selectPlace } from './selection';
import { setTourRunner, tourControls, useTourStore } from './tour';
import { initialAtlasState, useAtlasInstance, useAtlasStore } from './store';
import { useUiStore } from './ui';
import { useAtlasEvents } from './useAtlasEvents';

it('initializes readiness from the subscribed atlas and resets it on loss, replacement and cleanup', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const listeners = new Map<string, () => void>();
  const off = vi.fn();
  const atlas = {
    getStats: () => ({ readyMs: 10 }),
    setSelected: vi.fn(),
    on: (event: string, handler: () => void) => {
      listeners.set(event, handler);
      return off;
    },
  } as unknown as Atlas;
  function Listener() {
    useAtlasEvents();
    return null;
  }
  const root = createRoot(document.createElement('div'));
  act(() => {
    useAtlasInstance.setState({ atlas });
    root.render(createElement(Listener));
  });
  expect(useUiStore.getState().ready).toBe(true);
  act(() => listeners.get('contextlost')!());
  expect(useUiStore.getState().ready).toBe(false);
  expect(listeners.has('contextrestored')).toBe(false);
  act(() => listeners.get('ready')!());
  expect(useUiStore.getState().ready).toBe(true);
  act(() =>
    useAtlasInstance.setState({
      atlas: { ...atlas, getStats: () => ({ readyMs: null }) } as Atlas,
    }),
  );
  expect(useUiStore.getState().ready).toBe(false);
  act(() => listeners.get('ready')!());
  expect(useUiStore.getState().ready).toBe(true);
  act(() => root.unmount());
  expect(useUiStore.getState().ready).toBe(false);
  expect(off).toHaveBeenCalled();
});

afterEach(() => {
  useAtlasInstance.setState({ atlas: null });
  useAtlasStore.setState(initialAtlasState());
  useUiStore.setState({ legendFocus: null });
  vi.unstubAllGlobals();
  setTourRunner(null);
  useTourStore.setState({ active: null, tours: [] });
});

it('a listed click pauses a same-ID tour hold and cancels motion without flying; misses and Escape clear its anchor', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let click: ((event: AtlasEventMap['click']) => void) | undefined;
  const camera = { lng: 1, lat: 2, zoom: 18 };
  const flyTo = vi.fn(),
    setCamera = vi.fn();
  const atlas = {
    getStats: () => ({ readyMs: null }),
    getCamera: () => camera,
    setCamera,
    flyTo,
    setSelected: vi.fn(),
    setHighlighted: vi.fn(),
    on: (event: string, handler: unknown) => {
      if (event === 'click') click = handler as typeof click;
      return () => {};
    },
  } as unknown as Atlas;
  const tour: Tour = {
    id: 'tour/test',
    title: { en: 'Test' },
    status: 'draft',
    steps: [{ camera, duration_ms: 1000, narration: { en: 'Test' } }],
  };
  const cancelHold = vi.fn();
  setTourRunner({ show: () => selectPlace('place'), hold: vi.fn(), cancelHold, stop: vi.fn() });
  useTourStore.setState({ tours: [tour] });
  tourControls.start('test');
  tourControls.flyEnd();
  cancelHold.mockClear();
  const root = createRoot(document.createElement('div'));
  function Listener() {
    useAtlasEvents();
    return null;
  }
  act(() => {
    useAtlasInstance.setState({ atlas });
    useUiStore.setState({ clickable: new Set(['listed']) });
    root.render(createElement(Listener));
  });
  try {
    act(() =>
      click!({
        featureId: 'place',
        feature: { id: 'place', class: 'monument', landmarkId: 'listed' },
        lngLat: [1, 2],
        point: [10, 20],
      }),
    );
    expect(flyTo).not.toHaveBeenCalled();
    expect(setCamera).toHaveBeenCalledWith(camera);
    expect(useTourStore.getState().active?.run).toMatchObject({
      grabbed: true,
      paused: true,
      since: null,
    });
    expect(cancelHold).toHaveBeenCalled();
    expect(useUiStore.getState().anchor).toMatchObject({ id: 'place', lngLat: [1, 2] });
    act(() =>
      click!({
        featureId: 'other',
        feature: { id: 'other', class: 'monument', landmarkId: 'unlisted' },
        lngLat: [1, 2],
        point: [10, 20],
      }),
    );
    expect(useAtlasStore.getState().selectedId).toBeNull();
    expect(useUiStore.getState().anchor).toBeNull();
    act(() => {
      selectPlace('place', { origin: 'pointer', anchor: [1, 2] });
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(useUiStore.getState().anchor).toBeNull();
  } finally {
    act(() => root.unmount());
  }
});

it('Escape clears selection and legend focus together, cancels flight, and respects consumed keys', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  const root = createRoot(container);
  function Listener() {
    useAtlasEvents();
    return null;
  }
  act(() => root.render(createElement(Listener)));
  const camera = { lng: 1, lat: 2, zoom: 18 };
  const setCamera = vi.fn();
  const atlas = {
    getStats: () => ({ readyMs: null }),
    getCamera: () => camera,
    setCamera,
    setSelected: vi.fn(),
    on: () => () => {},
    setHighlighted: vi.fn(),
  } as unknown as Atlas;
  act(() => {
    useAtlasInstance.setState({ atlas });
    useAtlasStore.setState({ selectedId: 'place' });
    useUiStore.setState({ legendFocus: 'class:road_mid' });
  });
  try {
    const consumed = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    consumed.preventDefault();
    act(() => {
      window.dispatchEvent(consumed);
    });
    expect(useAtlasStore.getState().selectedId).toBe('place');
    expect(useUiStore.getState().legendFocus).toBe('class:road_mid');
    expect(setCamera).not.toHaveBeenCalled();
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(useAtlasStore.getState().selectedId).toBeNull();
    expect(useUiStore.getState().legendFocus).toBeNull();
    expect(setCamera).toHaveBeenCalledWith(camera);
  } finally {
    act(() => root.unmount());
  }
  setCamera.mockClear();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  expect(setCamera).not.toHaveBeenCalled();
});
