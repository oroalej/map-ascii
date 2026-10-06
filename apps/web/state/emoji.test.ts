import { afterEach, expect, it, vi } from 'vitest';
import { loadEmojiPrefs, saveEmojiPrefs } from './emoji';
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});
it('defaults on and remembers false independently per city', () => {
  expect(loadEmojiPrefs('one')).toEqual({ enabled: true });
  saveEmojiPrefs('one', { enabled: false });
  expect(loadEmojiPrefs('one')).toEqual({ enabled: false });
  expect(loadEmojiPrefs('two')).toEqual({ enabled: true });
  saveEmojiPrefs('one', { enabled: true });
  expect(loadEmojiPrefs('one').enabled).toBe(true);
});
it('tolerates malformed and denied storage', () => {
  for (const value of ['{', 'null', '[]', '{"enabled":"false"}']) {
    localStorage.setItem('atlas.emoji.one', value);
    expect(loadEmojiPrefs('one').enabled).toBe(true);
  }
  vi.stubGlobal('localStorage', {
    getItem() {
      throw Error('denied');
    },
    setItem() {
      throw Error('denied');
    },
  });
  expect(loadEmojiPrefs('one').enabled).toBe(true);
  expect(() => saveEmojiPrefs('one', { enabled: false })).not.toThrow();
});
