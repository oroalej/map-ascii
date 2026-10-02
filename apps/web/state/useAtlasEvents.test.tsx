// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { Atlas } from '@atlas/renderer';
import { initialAtlasState, useAtlasInstance, useAtlasStore } from './store';
import { useUiStore } from './ui';
import { useAtlasEvents } from './useAtlasEvents';

afterEach(() => {
  useAtlasInstance.setState({ atlas: null });
  useAtlasStore.setState(initialAtlasState());
  useUiStore.setState({ legendFocus: null });
  vi.unstubAllGlobals();
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
