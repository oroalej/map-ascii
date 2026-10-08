import type { Atlas, AtlasStats } from '@atlas/renderer';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useAtlasInstance } from '@/state/store';
import DebugStatsPanel from './DebugStatsPanel';

vi.mock('@/lib/debug', () => ({ debugCaptureMs: () => 30_000 }));

const stats: AtlasStats = {
  hasDrawnTileFrame: true,
  quality: { choice: 'high', tier: 0, name: 'high' },
  fps: 60,
  frameMs: 1,
  gpuFrameMs: null,
  cellPassMs: 0,
  crownPassMs: 0,
  lifeMs: 0,
  decodeMs: 0,
  tilesLoaded: 1,
  tilesPending: 0,
  agents: 0,
};
const instance = () => ({
  getStats: vi.fn(() => stats),
  getProfile: vi.fn(() => null),
  getCamera: () => ({ lat: 0, lng: 0, zoom: 18 }),
  resetProfile: vi.fn(),
});
let container: HTMLDivElement, root: Root;
const button = (name: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent === name)!;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useAtlasInstance.setState({ atlas: null });
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('cancels a capture when the atlas is replaced and enables the next capture', () => {
  const previous = instance(),
    next = instance();
  useAtlasInstance.setState({ atlas: previous as unknown as Atlas });
  act(() => root.render(createElement(DebugStatsPanel)));
  act(() => {
    vi.advanceTimersByTime(500);
  });
  act(() => button('Capture 30 seconds').click());
  expect(button('Capturing…').disabled).toBe(true);
  act(() => useAtlasInstance.setState({ atlas: next as unknown as Atlas }));
  expect(button('Capture 30 seconds').disabled).toBe(false);
  act(() => {
    vi.advanceTimersByTime(30_000);
  });
  expect(previous.getStats).toHaveBeenCalledTimes(1);
  act(() => button('Capture 30 seconds').click());
  expect(next.resetProfile).toHaveBeenCalledOnce();
  expect(button('Capturing…').disabled).toBe(true);
});
