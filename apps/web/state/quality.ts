import type { QualityChoice } from '@atlas/renderer';
import { create } from 'zustand';

export const QUALITY_CHOICES: readonly QualityChoice[] = ['auto', 'high', 'low'];
export const useQualityStore = create<{ choice: QualityChoice }>()(() => ({ choice: 'auto' }));
const KEY = 'atlas.quality';
const TIER_KEY = 'atlas.quality.tier';
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
/** The tier Auto last reached on this device, so a weak one needn't step down again each load. */
export function loadQualityTier(): number | undefined {
  try {
    const raw = window.localStorage.getItem(TIER_KEY);
    const saved: unknown = raw ? JSON.parse(raw) : undefined;
    return typeof saved === 'number' ? saved : undefined;
  } catch {
    return undefined;
  }
}
export function saveQualityTier(tier: number) {
  try {
    window.localStorage.setItem(TIER_KEY, JSON.stringify(tier));
  } catch {
    /* Auto starts from the top next time when storage is blocked. */
  }
}
