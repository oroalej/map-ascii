import { create } from 'zustand';
export type EmojiPrefs = { enabled: boolean };
export const useEmojiStore = create<EmojiPrefs>()(() => ({ enabled: true }));
export function loadEmojiPrefs(slug: string): EmojiPrefs {
  try {
    const saved = JSON.parse(
      localStorage.getItem(`atlas.emoji.${slug}`) ?? '{}',
    ) as Partial<EmojiPrefs> | null;
    return { enabled: typeof saved?.enabled === 'boolean' ? saved.enabled : true };
  } catch {
    return { enabled: true };
  }
}
export function saveEmojiPrefs(slug: string, prefs: EmojiPrefs) {
  try {
    localStorage.setItem(`atlas.emoji.${slug}`, JSON.stringify(prefs));
  } catch {
    /* Optional storage. */
  }
}
