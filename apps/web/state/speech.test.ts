import { afterEach, expect, it, vi } from 'vitest';
import type { DialogueCatalog } from '@atlas/shared';
import { loadSpeechPrefs, saveSpeechPrefs } from './speech';
const catalog = { translations: [{ code: 'en' }, { code: 'fil' }] } as DialogueCatalog;
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});
it('defaults to Bikol only, remembers display choices per city and rejects unsupported languages', () => {
  expect(loadSpeechPrefs('test', catalog)).toEqual({ enabled: true, translation: null });
  saveSpeechPrefs('test', { enabled: false, translation: 'fil' });
  expect(loadSpeechPrefs('test', catalog)).toEqual({ enabled: false, translation: 'fil' });
  expect(loadSpeechPrefs('other', catalog)).toEqual({ enabled: true, translation: null });
  saveSpeechPrefs('test', { enabled: true, translation: 'de' });
  expect(loadSpeechPrefs('test', catalog).translation).toBeNull();
});
it('tolerates invalid or blocked storage', () => {
  for (const value of ['{', 'null', '[]']) {
    localStorage.setItem('atlas.speech.test', value);
    expect(loadSpeechPrefs('test', catalog)).toEqual({ enabled: true, translation: null });
  }
  vi.stubGlobal('localStorage', {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
  });
  expect(loadSpeechPrefs('test', catalog)).toEqual({ enabled: true, translation: null });
  expect(() => saveSpeechPrefs('test', { enabled: false, translation: null })).not.toThrow();
});
