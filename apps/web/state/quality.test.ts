import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadQualityPref, saveQualityPref } from './quality';
beforeEach(() => window.localStorage.clear());
afterEach(() => vi.restoreAllMocks());
it('defaults to Auto and remembers each quality choice', () => {
  expect(loadQualityPref()).toBe('auto');
  for (const choice of ['auto', 'high', 'low'] as const) {
    saveQualityPref(choice);
    expect(loadQualityPref()).toBe(choice);
  }
});
it('rejects malformed or unknown preferences', () => {
  for (const raw of ['not json', 'null', '{}', '"ultra"']) {
    window.localStorage.setItem('atlas.quality', raw);
    expect(loadQualityPref()).toBe('auto');
  }
});
it('works when browser storage is unavailable', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  expect(loadQualityPref()).toBe('auto');
  expect(() => saveQualityPref('low')).not.toThrow();
});
