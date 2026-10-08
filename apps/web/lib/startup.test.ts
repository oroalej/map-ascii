// @vitest-environment node
import type { Atlas } from '@atlas/renderer';
import { expect, it, vi } from 'vitest';
import { useUiStore } from '@/state/ui';
import { useAtlasInstance } from '@/state/store';
import { afterFirstTileFrame, scheduleAutomaticJson } from './startup';
import { AUTOMATIC_JSON } from './automatic-json';
it('waits for the current city and atlas, supports late subscribers and cancels', () => {
  const atlas = {} as Atlas;
  useAtlasInstance.setState({ atlas });
  useUiStore.setState({ startup: { city: 'a', atlas, status: 'drawing' } });
  const first = vi.fn(),
    cancelled = vi.fn();
  const off = afterFirstTileFrame('a', first);
  afterFirstTileFrame('b', cancelled)();
  expect(first).not.toHaveBeenCalled();
  useUiStore.setState({ startup: { city: 'a', atlas: {} as Atlas, status: 'ready' } });
  expect(first).not.toHaveBeenCalled();
  useUiStore.setState({ startup: { city: 'a', atlas, status: 'ready' } });
  expect(first).toHaveBeenCalledOnce();
  const late = vi.fn();
  afterFirstTileFrame('a', late)();
  expect(late).toHaveBeenCalledOnce();
  expect(cancelled).not.toHaveBeenCalled();
  off();
  useUiStore.setState({ startup: null });
  useAtlasInstance.setState({ atlas: null });
});

it('enforces the same manifest for eager and deferred automatic loaders', () => {
  const atlas = {} as Atlas;
  useAtlasInstance.setState({ atlas });
  useUiStore.setState({ startup: { city: 'policy', atlas, status: 'drawing' } });
  const eager = vi.fn(),
    deferred = vi.fn();
  scheduleAutomaticJson('policy', 'subdivisions', eager, {
    ...AUTOMATIC_JSON,
    subdivisions: 'startup',
  })();
  const off = scheduleAutomaticJson('policy', 'landmarks', deferred);
  expect(eager).toHaveBeenCalledOnce();
  expect(deferred).not.toHaveBeenCalled();
  useUiStore.setState({ startup: { city: 'policy', atlas, status: 'ready' } });
  expect(deferred).toHaveBeenCalledOnce();
  off();
  useUiStore.setState({ startup: null });
  useAtlasInstance.setState({ atlas: null });
});
