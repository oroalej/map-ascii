import type { QualityChoice } from '@atlas/renderer';
import { create } from 'zustand';

export const QUALITY_CHOICES: readonly QualityChoice[] = ['auto', 'high', 'low'];
export const useQualityStore = create<{ choice: QualityChoice }>()(() => ({ choice: 'auto' }));
const KEY = 'atlas.quality';
export function loadQualityPref(): QualityChoice {
  try {
    const raw = window.localStorage.getItem(KEY);
    const saved: unknown = raw ? JSON.parse(raw) : null;
    return QUALITY_CHOICES.includes(saved as QualityChoice) ? (saved as QualityChoice) : 'auto';
  } catch {
    return 'auto';
  }
}
export function saveQualityPref(choice: QualityChoice) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(choice));
  } catch {
    /* The choice still applies when storage is blocked. */
  }
}
