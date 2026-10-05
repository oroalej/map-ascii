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
it('toggles simulated moods and explains Life, zoom and reduced motion', () => {
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
  expect(container.textContent).toContain('Turn Life on');
  act(() => {
    useLifeStore.setState({ enabled: true });
    useAtlasStore.setState({ camera: { lng: 0, lat: 0, zoom: 17 } });
  });
  expect(container.textContent).toContain('Zoom to z18');
  reduced = true;
  act(() => useAtlasStore.setState({ camera: { lng: 0, lat: 0, zoom: 19 } }));
  expect(container.textContent).toContain('reduced motion');
  act(() => container.querySelector('button')!.click());
  expect(useEmojiStore.getState().enabled).toBe(false);
  expect(container.querySelector('button')!.getAttribute('aria-pressed')).toBe('false');
  act(() => root.unmount());
  container.remove();
});
