import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadLifePrefs, saveLifePrefs, type LifePrefs } from './life';

const KEY = 'atlas.life';
const DEFAULTS: LifePrefs = { enabled: true, time: 'live', wind: 'live', season: 'auto' };

describe('life preferences', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('defaults to on, the live clock, and the season wind', () => {
    expect(loadLifePrefs('city')).toEqual(DEFAULTS);
  });

  it('remembers what was saved', () => {
    saveLifePrefs('city', { enabled: false, time: 'night', wind: 'breeze' });
    expect(loadLifePrefs('city')).toEqual({
      enabled: false,
      time: 'night',
      wind: 'breeze',
      season: 'auto',
    });
  });

  it('moves a time of day saved as daylight to an hour', () => {
    window.localStorage.setItem(KEY, '{"enabled":true,"time":"day"}');
    expect(loadLifePrefs('city').time).toBe('noon');
  });
  it('validates preview ids against the current city and preserves old preferences', () => {
    saveLifePrefs('city', { enabled: true, time: 'night', wind: 'breeze', season: 'winter' });
    expect(loadLifePrefs('city', [{ id: 'winter' }]).season).toBe('winter');
    expect(loadLifePrefs('city', [{ id: 'feast' }]).season).toBe('auto');
    expect(loadLifePrefs('city').season).toBe('auto');
  });

  it('ignores unknown or malformed values', () => {
    window.localStorage.setItem(KEY, '{"enabled":"yes","time":"teatime","wind":"gale"}');
    expect(loadLifePrefs('city')).toEqual(DEFAULTS);
    window.localStorage.setItem(KEY, 'not json');
    expect(loadLifePrefs('city')).toEqual(DEFAULTS);
  });

  it('falls back to the defaults when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() =>
      saveLifePrefs('city', { enabled: false, time: 'noon', wind: 'live' }),
    ).not.toThrow();
    expect(loadLifePrefs('city')).toEqual(DEFAULTS);
  });
  it('isolates previews while sharing general preferences, including seasonless cities', () => {
    saveLifePrefs('a', { ...DEFAULTS, season: 'winter', time: 'night' });
    saveLifePrefs('b', { ...loadLifePrefs('b'), enabled: false });
    expect(loadLifePrefs('a', [{ id: 'winter' }])).toEqual({
      ...DEFAULTS,
      enabled: false,
      time: 'night',
      season: 'winter',
    });
    expect(loadLifePrefs('b', [{ id: 'winter' }]).season).toBe('auto');
    saveLifePrefs('b', { ...DEFAULTS, season: 'feast' });
    expect(loadLifePrefs('a', [{ id: 'winter' }]).season).toBe('winter');
    expect(loadLifePrefs('b', [{ id: 'feast' }]).season).toBe('feast');
  });
  it('retains a legacy preview through a seasonless city and migrates it once to a matching pack', () => {
    window.localStorage.setItem(KEY, JSON.stringify({ ...DEFAULTS, season: 'winter' }));
    const other = loadLifePrefs('other');
    saveLifePrefs('other', { ...other, enabled: false });
    expect(JSON.parse(window.localStorage.getItem(KEY)!)).toHaveProperty('season', 'winter');
    expect(loadLifePrefs('a', [{ id: 'winter' }]).season).toBe('winter');
    expect(JSON.parse(window.localStorage.getItem(KEY)!)).not.toHaveProperty('season');
    expect(loadLifePrefs('b', [{ id: 'winter' }]).season).toBe('auto');
    expect(loadLifePrefs('a', [{ id: 'winter' }]).season).toBe('winter');
  });
  it('applies a valid legacy choice even when migration writes are blocked', () => {
    window.localStorage.setItem(KEY, JSON.stringify({ season: 'winter' }));
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(loadLifePrefs('a', [{ id: 'winter' }]).season).toBe('winter');
  });
});
