import { describe, expect, it } from 'vitest';
import { cacheIsFresh } from './overpass';

const day = 24 * 60 * 60 * 1000;
const now = 100 * day;

describe('cacheIsFresh', () => {
  it('reuses a recent download made with the same query', () => {
    expect(cacheIsFresh({ mtimeMs: now - day, query: 'q' }, 'q', { offline: false, now })).toBe(
      true,
    );
  });

  it('downloads again when the query changed or the cache is a week old', () => {
    expect(cacheIsFresh({ mtimeMs: now - day, query: 'old' }, 'q', { offline: false, now })).toBe(
      false,
    );
    expect(
      cacheIsFresh({ mtimeMs: now - day, query: undefined }, 'q', { offline: false, now }),
    ).toBe(false);
    expect(cacheIsFresh({ mtimeMs: now - 8 * day, query: 'q' }, 'q', { offline: false, now })).toBe(
      false,
    );
  });

  it('always uses the cache offline', () => {
    expect(cacheIsFresh({ mtimeMs: 0, query: 'old' }, 'q', { offline: true, now })).toBe(true);
  });
});
