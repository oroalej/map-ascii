import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadQualityPref, loadQualityTier, saveQualityPref, saveQualityTier } from './quality';
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
it('remembers the tier Auto reached, and treats a bad value as none', () => {
  expect(loadQualityTier()).toBeUndefined();
  saveQualityTier(2);
  expect(loadQualityTier()).toBe(2);
  for (const raw of ['not json', 'null', '"2"', '{}']) {
    window.localStorage.setItem('atlas.quality.tier', raw);
    expect(loadQualityTier()).toBeUndefined();
  }
});
it('has no remembered tier when browser storage is unavailable', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  expect(loadQualityTier()).toBeUndefined();
  expect(() => saveQualityTier(1)).not.toThrow();
});
