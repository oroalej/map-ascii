import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadLifePrefs, saveLifePrefs } from './life';

const KEY = 'atlas.life';
const DEFAULTS = { enabled: true, time: 'live', wind: 'live' };

describe('life preferences', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('defaults to on, the live clock, and the season wind', () => {
    expect(loadLifePrefs()).toEqual(DEFAULTS);
  });

  it('remembers what was saved', () => {
    saveLifePrefs({ enabled: false, time: 'night', wind: 'breeze' });
    expect(loadLifePrefs()).toEqual({ enabled: false, time: 'night', wind: 'breeze' });
  });

  it('moves a time of day saved as daylight to an hour', () => {
    window.localStorage.setItem(KEY, '{"enabled":true,"time":"day"}');
    expect(loadLifePrefs().time).toBe('noon');
  });

  it('ignores unknown or malformed values', () => {
    window.localStorage.setItem(KEY, '{"enabled":"yes","time":"teatime","wind":"gale"}');
    expect(loadLifePrefs()).toEqual(DEFAULTS);
    window.localStorage.setItem(KEY, 'not json');
    expect(loadLifePrefs()).toEqual(DEFAULTS);
  });

  it('falls back to the defaults when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => saveLifePrefs({ enabled: false, time: 'noon', wind: 'live' })).not.toThrow();
    expect(loadLifePrefs()).toEqual(DEFAULTS);
  });
});
