import type { LifeSettings, WindChoice } from '@atlas/renderer';
import { WIND_STRENGTHS } from '@atlas/shared';
import { create } from 'zustand';

/**
 * The HUD's time-of-day choices: the real sun now, or a fixed amount of daylight (so "Dusk"
 * looks like dusk in every city and season).
 */
export type TimeChoice = 'live' | 'day' | 'dusk' | 'night';
export const TIME_CHOICES: readonly TimeChoice[] = ['live', 'day', 'dusk', 'night'];
const DAYLIGHT: Record<Exclude<TimeChoice, 'live'>, number> = { day: 1, dusk: 0.5, night: 0 };

/** The HUD's wind choices: the season's wind, or a strength (from the season's direction). */
export const WIND_CHOICES: readonly WindChoice[] = ['live', ...WIND_STRENGTHS];

/**
 * The life layer's settings (SPEC.md §4 "Life layer"): a viewer preference, not view state, so
 * it is remembered in this browser rather than mirrored in the URL.
 */
export type LifePrefs = { enabled: boolean; time: TimeChoice; wind: WindChoice };

const DEFAULTS: LifePrefs = { enabled: true, time: 'live', wind: 'live' };

export const useLifeStore = create<LifePrefs>()(() => ({ ...DEFAULTS }));

const KEY = 'atlas.life';

/** The saved preferences, or the defaults (storage can be missing or blocked). */
export function loadLifePrefs(): LifePrefs {
  try {
    const raw = window.localStorage.getItem(KEY);
    const saved = raw ? (JSON.parse(raw) as Partial<LifePrefs>) : {};
    return {
      enabled: typeof saved.enabled === 'boolean' ? saved.enabled : true,
      time: TIME_CHOICES.includes(saved.time as TimeChoice) ? (saved.time as TimeChoice) : 'live',
      wind: WIND_CHOICES.includes(saved.wind as WindChoice) ? (saved.wind as WindChoice) : 'live',
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
export const lifeSettings = ({ enabled, time, wind }: LifePrefs): LifeSettings => ({
  enabled,
  daylight: time === 'live' ? 'live' : DAYLIGHT[time],
  wind,
});
