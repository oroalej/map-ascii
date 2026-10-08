import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initialAtlasState, useAtlasStore } from './store';
import { tourControls, useTourStore } from './tour';
import { attachUrlSync } from './useUrlSync';
const camera = { lat: 1, lng: 2, zoom: 15 };
const tours = [
  {
    id: 'tour/example',
    title: { en: 'Example' },
    status: 'draft',
    steps: [0, 1].map((i) => ({ camera, duration_ms: 1000, narration: { en: String(i) } })),
  },
];
let finish!: (response: Response) => void,
  detach: (() => void) | undefined,
  serial = 0;
const complete = async () => {
  finish({ ok: true, json: () => Promise.resolve(tours) } as Response);
  await tourControls.load();
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((done) => {
          finish = done;
        }),
    ),
  );
  useAtlasStore.setState({ ...initialAtlasState(), camera });
  tourControls.configure(`lazy-${serial++}`, true);
  window.history.replaceState(null, '', '/example?tour=example&step=1');
});
afterEach(() => {
  detach?.();
  detach = undefined;
  tourControls.configure(null, false);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it('preserves initial tour intent during camera normalization and restores it paused without a push', async () => {
  const push = vi.spyOn(window.history, 'pushState');
  detach = attachUrlSync();
  useAtlasStore.getState().setCamera({ zoom: 17 });
  vi.advanceTimersByTime(250);
  expect(window.location.search).toContain('tour=example&step=1');
  await complete();
  expect(useTourStore.getState().active?.run).toMatchObject({ step: 1, paused: true });
  expect(push).not.toHaveBeenCalled();
});
it('restores the latest Back/Forward request while data is delayed', async () => {
  detach = attachUrlSync();
  window.history.replaceState(null, '', '/example?tour=example&step=0');
  const push = vi.spyOn(window.history, 'pushState');
  window.dispatchEvent(new PopStateEvent('popstate'));
  await complete();
  expect(useTourStore.getState().active?.run.step).toBe(0);
  expect(push).not.toHaveBeenCalled();
});
it.each(['history', 'exit'])('cancels pending restoration through %s', async (mode) => {
  detach = attachUrlSync();
  if (mode === 'exit') tourControls.exit();
  else {
    window.history.replaceState(null, '', '/example');
    window.dispatchEvent(new PopStateEvent('popstate'));
  }
  await complete();
  expect(useTourStore.getState().active).toBeNull();
  expect(useTourStore.getState().pending).toBeNull();
});
it('keeps the menu open and the URL retryable after failure, then installs data without cleanup', async () => {
  detach = attachUrlSync();
  tourControls.setMenuOpen(true);
  finish({ ok: false, status: 503 } as Response);
  await tourControls.load();
  expect(useTourStore.getState()).toMatchObject({
    dataStatus: 'error',
    menuOpen: true,
    pending: { id: 'example' },
  });
  const retry = tourControls.load();
  finish({ ok: true, json: () => Promise.resolve(tours) } as Response);
  await retry;
  expect(useTourStore.getState()).toMatchObject({ dataStatus: 'ready', menuOpen: true });
  expect(useTourStore.getState().active?.run.paused).toBe(true);
});
it('discards data belonging to a replaced city', async () => {
  detach = attachUrlSync();
  const pending = tourControls.load();
  tourControls.configure('replacement', false);
  finish({ ok: true, json: () => Promise.resolve(tours) } as Response);
  await pending;
  expect(useTourStore.getState()).toMatchObject({ city: 'replacement', tours: [], active: null });
});
