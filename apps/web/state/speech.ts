import type { DialogueCatalog } from '@atlas/shared';
import { create } from 'zustand';

export type SpeechPrefs = { enabled: boolean; translation: string | null };
export const useSpeechStore = create<SpeechPrefs>()(() => ({ enabled: true, translation: null }));
const key = (slug: string) => `atlas.speech.${slug}`;
export function loadSpeechPrefs(slug: string, catalog: DialogueCatalog): SpeechPrefs {
  try {
    const saved = JSON.parse(
      localStorage.getItem(key(slug)) ?? '{}',
    ) as Partial<SpeechPrefs> | null;
    const translation = saved?.translation ?? null;
    return {
      enabled: typeof saved?.enabled === 'boolean' ? saved.enabled : true,
      translation: catalog.translations.some((entry) => entry.code === translation)
        ? translation
        : null,
    };
  } catch {
    return { enabled: true, translation: null };
  }
}
export function saveSpeechPrefs(slug: string, prefs: SpeechPrefs) {
  try {
    localStorage.setItem(key(slug), JSON.stringify(prefs));
  } catch {
    /* Storage is optional. */
  }
}
