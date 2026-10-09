import { describe, expect, it } from 'vitest';
import { RecentKeys } from './recent-keys';

describe('RecentKeys', () => {
  it('holds the current keys plus the most recent `cap` others', () => {
    const keys = new RecentKeys(2);
    expect(keys.touch(['a', 'b'])).toEqual([]);
    // Two keys left the view; both fit within the cap beyond the current one.
    expect(keys.touch(['c'])).toEqual([]);
    expect(keys.touch(['d'])).toEqual(['a']);
    expect(['a', 'b', 'c', 'd'].map((k) => keys.has(k))).toEqual([false, true, true, true]);
    // Returning keys move to the most recent end.
    expect(keys.touch(['b', 'e'])).toEqual([]);
    expect(keys.touch(['f'])).toEqual(['c', 'd']);
    expect(['b', 'e', 'f'].every((k) => keys.has(k))).toBe(true);
    // A large current set is always held whole.
    expect(keys.touch(['g', 'h', 'i', 'j', 'k'])).toEqual(['b']);
    expect(['e', 'f', 'g', 'h', 'i', 'j', 'k'].every((k) => keys.has(k))).toBe(true);
    keys.clear();
    expect(keys.has('k')).toBe(false);
  });
});
