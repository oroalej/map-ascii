import type { LifeSettings, WindChoice } from '@atlas/renderer';
import { WIND_STRENGTHS } from '@atlas/shared';
import { create } from 'zustand';

/**
 * The HUD's time-of-day choices: the city's clock now, or a fixed hour in the city today, lit by
 * the sun at that hour and with the traffic of that hour (the city's daily rhythm).
 */
export type TimeChoice = 'live' | 'dawn' | 'morning' | 'noon' | 'dusk' | 'night';
export const TIME_CHOICES: readonly TimeChoice[] = [
  'live',
  'dawn',
  'morning',
  'noon',
  'dusk',
  'night',
];
/** Each fixed choice's local time, in minutes past midnight. */
export const TIME_MINUTES: Record<Exclude<TimeChoice, 'live'>, number> = {
  dawn: 5 * 60 + 30,
  morning: 8 * 60,
  noon: 12 * 60,
  dusk: 18 * 60,
  night: 22 * 60,
};
/** Choices saved before the fixed times were hours (they were amounts of daylight). */
const RENAMED: Record<string, TimeChoice> = { day: 'noon' };

const timeChoice = (saved: unknown): TimeChoice => {
  const choice = typeof saved === 'string' ? (RENAMED[saved] ?? saved) : saved;
  return TIME_CHOICES.includes(choice as TimeChoice) ? (choice as TimeChoice) : 'live';
};

/** The HUD's wind choices: the season's wind, or a strength (from the season's direction). */
export const WIND_CHOICES: readonly WindChoice[] = ['live', ...WIND_STRENGTHS];

/**
 * The life layer's settings (SPEC.md §4 "Life layer"): a viewer preference, not view state, so
 * it is remembered in this browser rather than mirrored in the URL.
 */
export type LifePrefs = { enabled: boolean; time: TimeChoice; wind: WindChoice; season?: string };

const DEFAULTS: LifePrefs = { enabled: true, time: 'live', wind: 'live', season: 'auto' };

export const useLifeStore = create<LifePrefs>()(() => ({ ...DEFAULTS }));

const KEY = 'atlas.life';

/** The saved preferences, or the defaults (storage can be missing or blocked). */
export function loadLifePrefs(seasons: readonly { id: string }[] = []): LifePrefs {
  try {
    const raw = window.localStorage.getItem(KEY);
    const saved = raw ? (JSON.parse(raw) as Partial<LifePrefs>) : {};
    return {
      enabled: typeof saved.enabled === 'boolean' ? saved.enabled : true,
      time: timeChoice(saved.time),
      wind: WIND_CHOICES.includes(saved.wind as WindChoice) ? (saved.wind as WindChoice) : 'live',
      season: seasons.some((s) => s.id === saved.season) ? saved.season : 'auto',
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveLifePrefs(prefs: LifePrefs) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Not remembered; the setting still applies until the page closes.
  }
}

/** The renderer's settings for the preferences. */
export const lifeSettings = ({ enabled, time, wind, season }: LifePrefs): LifeSettings => ({
  enabled,
  time: time === 'live' ? 'live' : TIME_MINUTES[time],
  wind,
  season: season ?? 'auto',
});
