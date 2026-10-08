import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useAtlasStore } from '@/state/store';
import { useEmojiStore } from '@/state/emoji';
import { useLifeStore } from '@/state/life';
import { EmojiControls } from './EmojiControls';
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('hides unavailable moods and retains the preference across zoom and Life changes', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let reduced = false;
  vi.stubGlobal('matchMedia', () => ({
    matches: reduced,
    addEventListener() {},
    removeEventListener() {},
  }));
  useEmojiStore.setState({ enabled: true });
  useLifeStore.setState({ enabled: false });
  useAtlasStore.setState({ camera: { lng: 0, lat: 0, zoom: 19 } });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(createElement(EmojiControls)));
  expect(container.textContent).toBe('');
  expect(container.querySelector('button')).toBeNull();
  act(() => {
    useLifeStore.setState({ enabled: true });
    useAtlasStore.setState({ camera: { lng: 0, lat: 0, zoom: 17 } });
  });
  expect(container.textContent).toBe('');
  expect(container.querySelector('button')).toBeNull();
  reduced = true;
  act(() => useAtlasStore.setState({ camera: { lng: 0, lat: 0, zoom: 19 } }));
  expect(container.textContent).toBe('');
  expect(container.querySelector('button')).toBeNull();
  reduced = false;
  act(() => useLifeStore.setState({ enabled: false }));
  act(() => useLifeStore.setState({ enabled: true }));
  expect(container.querySelector('button')).not.toBeNull();
  act(() => container.querySelector('button')!.click());
  expect(useEmojiStore.getState().enabled).toBe(false);
  expect(container.querySelector('button')!.getAttribute('aria-pressed')).toBe('false');
  act(() => useAtlasStore.setState({ camera: { lng: 0, lat: 0, zoom: 17 } }));
  expect(container.querySelector('button')).toBeNull();
  expect(useEmojiStore.getState().enabled).toBe(false);
  act(() => useAtlasStore.setState({ camera: { lng: 0, lat: 0, zoom: 18 } }));
  expect(container.querySelector('button')!.getAttribute('aria-pressed')).toBe('false');
  act(() => root.unmount());
  container.remove();
});
