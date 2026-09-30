import type { Atlas } from '@atlas/renderer';
import type { Tour } from '@atlas/shared';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initialAtlasState, useAtlasInstance, useAtlasStore } from './store';
import { setTourRunner, tourControls, useTourStore } from './tour';
import { attachUrlSync } from './useUrlSync';

let detach: (() => void) | undefined;
const camera = { lat: 1, lng: 2, zoom: 15 };
const tour: Tour = {
  id: 'tour/example',
  title: { en: 'Example' },
  status: 'draft',
  steps: [0, 1].map((i) => ({ camera, duration_ms: 1000, narration: { en: String(i) } })),
};
const atlas = { setCamera: vi.fn(), setHighlighted: vi.fn(), setYear: vi.fn() };
const runner = { show: vi.fn(), hold: vi.fn(), cancelHold: vi.fn(), stop: vi.fn() };

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  window.history.replaceState(null, '', '/example?lat=1&lng=2&z=15');
  useAtlasStore.setState({ ...initialAtlasState(), camera });
  useAtlasInstance.setState({ atlas: atlas as unknown as Atlas });
  useTourStore.setState({ tours: [tour], active: null, menuOpen: false });
  setTourRunner(runner);
  detach = attachUrlSync();
});
afterEach(() => {
  detach?.();
  useAtlasInstance.setState({ atlas: null });
  setTourRunner(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function history(search: string) {
  window.history.replaceState(null, '', `/example?${search}`);
  const push = vi.spyOn(window.history, 'pushState');
  const replace = vi.spyOn(window.history, 'replaceState');
  window.dispatchEvent(new PopStateEvent('popstate'));
  return { push, replace };
}

it('restores year and selection, cancels a pending write, and does not rewrite history', () => {
  useAtlasStore.getState().setCamera({ zoom: 16 });
  const { push, replace } = history('lat=3&lng=4&z=17&year=1990&sel=osm:way/1');
  expect(useAtlasStore.getState()).toMatchObject({ year: 1990, selectedId: 'osm:way/1' });
  expect(atlas.setCamera).toHaveBeenCalledWith({ lat: 3, lng: 4, zoom: 17 });
  expect(atlas.setYear).toHaveBeenCalledWith(1990, { animate: false });
  expect(atlas.setHighlighted).toHaveBeenCalledWith([]);
  vi.advanceTimersByTime(1000);
  expect(push).not.toHaveBeenCalled();
  expect(replace).not.toHaveBeenCalled();
});

it('restores another step of the same tour paused and cancels its old timer', () => {
  tourControls.start('example');
  tourControls.flyEnd();
  runner.cancelHold.mockClear();
  history('lat=1&lng=2&z=15&tour=example&step=1');
  expect(useAtlasStore.getState().tour).toEqual({ id: 'example', step: 1, paused: true });
  expect(useTourStore.getState().active?.run.step).toBe(1);
  expect(runner.cancelHold).toHaveBeenCalled();
});

it('uses defaults for missing or invalid values and exits unknown tours', () => {
  tourControls.start('example');
  useAtlasStore.getState().setYear(1990);
  history('year=nope&tour=missing&z=bad&pitch=50&mode=orbit');
  expect(useAtlasStore.getState().year).toBe(initialAtlasState().year);
  expect(useAtlasStore.getState().selectedId).toBeNull();
  expect(useAtlasStore.getState().tour).toBeNull();
  expect(useTourStore.getState().active).toBeNull();
  expect(atlas.setCamera).toHaveBeenCalledWith({});
});

it('resumes normal URL updates after history restoration and removes its listener on cleanup', () => {
  const { replace } = history('year=1990');
  useAtlasStore.getState().setCamera({ zoom: 18 });
  vi.advanceTimersByTime(250);
  expect(replace).toHaveBeenCalledTimes(1);
  detach?.();
  detach = undefined;
  atlas.setYear.mockClear();
  window.dispatchEvent(new PopStateEvent('popstate'));
  expect(atlas.setYear).not.toHaveBeenCalled();
});
