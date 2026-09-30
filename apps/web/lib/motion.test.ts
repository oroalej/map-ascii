import { afterEach, expect, it, vi } from 'vitest';
import { listenReducedMotion, prefersReducedMotion, subscribeReducedMotion } from './motion';

afterEach(() => vi.unstubAllGlobals());

it('shares the preference and detaches listeners without touching Life preferences', () => {
  const query = new EventTarget() as MediaQueryList;
  let matches = false;
  Object.defineProperty(query, 'matches', { get: () => matches });
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => query),
  );
  const atlas = { setReducedMotion: vi.fn() };
  const changed = vi.fn();
  const off = listenReducedMotion(atlas);
  const unsubscribe = subscribeReducedMotion(changed);
  expect(prefersReducedMotion()).toBe(false);
  expect(atlas.setReducedMotion).not.toHaveBeenCalled();
  matches = true;
  query.dispatchEvent(new Event('change'));
  expect(prefersReducedMotion()).toBe(true);
  expect(atlas.setReducedMotion).toHaveBeenLastCalledWith(true);
  matches = false;
  query.dispatchEvent(new Event('change'));
  expect(atlas.setReducedMotion).toHaveBeenLastCalledWith(false);
  expect(changed).toHaveBeenCalledTimes(2);
  off();
  unsubscribe();
  query.dispatchEvent(new Event('change'));
  expect(atlas.setReducedMotion).toHaveBeenCalledTimes(2);
  expect(changed).toHaveBeenCalledTimes(2);
});
