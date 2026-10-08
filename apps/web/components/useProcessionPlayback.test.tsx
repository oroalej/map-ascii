import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Atlas } from '@atlas/renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { useUiStore } from '@/state/ui';
import { useAtlasInstance } from '@/state/store';
import { useLifeStore } from '@/state/life';
import { useProcessionPlayback } from './useProcessionPlayback';
import { eventFixtures } from './procession-fixtures.test-utils';
afterEach(() => {
  vi.unstubAllGlobals();
  useAtlasInstance.setState({ atlas: null });
  useUiStore.setState({ startup: null, processions: [] });
});
it.each([false, true])(
  'awaits installation and ignores atlas replacement (%s)',
  async (replace) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    let resolve!: (value: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((done) => {
            resolve = done;
          }),
      ),
    );
    const order: string[] = [];
    const atlas = {
      setProcessions: vi.fn(() => order.push('install')),
      playProcession: vi.fn(() => {
        order.push('play');
        return true;
      }),
      flyTo: vi.fn(() => order.push('fly')),
      getCamera: () => ({ zoom: 18 }),
    } as unknown as Atlas;
    const city = `play-${replace}`;
    useAtlasInstance.setState({ atlas });
    useUiStore.setState({ startup: { city, atlas, status: 'drawing' }, processions: [] });
    useLifeStore.setState({ enabled: true });
    let play!: (id: string) => Promise<void>;
    function Probe() {
      play = useProcessionPlayback().play;
      return null;
    }
    const root = createRoot(document.createElement('div'));
    act(() => root.render(createElement(Probe)));
    try {
      const pending = play(eventFixtures[0]!.id);
      expect(order).toEqual([]);
      if (replace) act(() => useAtlasInstance.setState({ atlas: {} as Atlas }));
      await act(async () => {
        resolve({
          ok: true,
          json: () => Promise.resolve({ processions: [eventFixtures[0]] }),
        } as Response);
        await pending;
      });
      expect(order).toEqual(replace ? [] : ['install', 'play', 'fly']);
    } finally {
      act(() => root.unmount());
    }
  },
);
