import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useAtlasInstance } from './store';
import { useTourStore } from './tour';
import { useTourPlayer } from './useTourPlayer';
afterEach(() => {
  vi.unstubAllGlobals();
});
it.each([false, true])(
  'keeps T available before tour data loads (has tours %s)',
  async (hasTours) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    let finish!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((done) => {
            finish = done;
          }),
      ),
    );
    useAtlasInstance.setState({ atlas: null });
    function Probe() {
      useTourPlayer(`keyboard-${hasTours}`, hasTours);
      return null;
    }
    const root = createRoot(document.createElement('div'));
    try {
      act(() => root.render(createElement(Probe)));
      expect(fetch).not.toHaveBeenCalled();
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'T', cancelable: true }));
      });
      expect(useTourStore.getState().menuOpen).toBe(hasTours);
      expect(fetch).toHaveBeenCalledTimes(hasTours ? 1 : 0);
      if (hasTours) {
        await act(async () => {
          finish({ ok: true, json: () => Promise.resolve([]) } as Response);
          await Promise.resolve();
        });
        expect(useTourStore.getState()).toMatchObject({
          menuOpen: true,
          dataStatus: 'ready',
          tours: [],
        });
      }
    } finally {
      act(() => root.unmount());
    }
    expect(useTourStore.getState().city).toBeNull();
  },
);
