/**
 * The wind right now (SPEC.md §4): the season's prevailing wind from the city pack's climate
 * (`seasonalWind`), or the visitor's choice of strength, veering slowly around its direction and
 * breathing around its strength. Grass, trees, and water read it every frame (glyphs/select.ts
 * `windGust` and the rest, through `u_windDir` and `u_wind`).
 */
import {
  seasonalWind,
  type ClimateConfig,
  type PrevailingWind,
  type WindStrength,
} from '@atlas/shared';
import { cellHash, windFrom, type WindDir } from '../glyphs/select';

/** How hard each strength blows: it scales every gust (grass bends, crowns swing). */
export const WIND_PRESETS: Readonly<Record<WindStrength, number>> = {
  calm: 0.25,
  breeze: 0.7,
  gusty: 1,
  storm: 1.5,
};

/** The visitor's wind: the season's (`live`), or a strength from the season's direction. */
export type WindChoice = 'live' | WindStrength;

/**
 * How the wind varies: its direction veers up to `veer` degrees either way over about `veerPeriod`
 * seconds, and its strength breathes up to `breathe` (a share) over about `breathePeriod`.
 */
export const WIND_VARIATION = {
  veer: 25,
  veerPeriod: 90,
  breathe: 0.3,
  breathePeriod: 20,
} as const;

/** The wind at one moment. */
export type WindNow = {
  /** Where it blows from, in compass degrees. */
  from: number;
  /** Where it blows, as a unit vector in world cells (x east, y south). */
  dir: WindDir;
  /** How hard, scaling the gusts (0 is still: reduced motion). */
  strength: number;
};

/** Smooth noise over time, −1 to 1: hashed values every `period` seconds, eased between. */
function drift(time: number, period: number, seed: number): number {
  const t = time / period;
  const k = Math.floor(t);
  const f = t - k;
  const at = (i: number) => ((cellHash(i, seed) >>> 8) / 16777216) * 2 - 1;
  const s = f * f * (3 - 2 * f);
  return at(k) + (at(k + 1) - at(k)) * s;
}

/** The prevailing wind for the visitor's `choice` in `month` (1–12). */
export function prevailingWind(
  choice: WindChoice,
  climate: ClimateConfig | undefined,
  month: number,
): PrevailingWind {
  const season = seasonalWind(climate, month);
  return choice === 'live' ? season : { from: season.from, strength: choice };
}

/** The wind at `time` (seconds) around a prevailing wind. */
export function windAt(time: number, base: PrevailingWind): WindNow {
  const { veer, veerPeriod, breathe, breathePeriod } = WIND_VARIATION;
  const from = base.from + veer * drift(time, veerPeriod, 7);
  const strength = WIND_PRESETS[base.strength] * (1 + breathe * drift(time, breathePeriod, 11));
  return { from, dir: windFrom(from), strength };
}

/** A still wind (reduced motion): the direction stays, nothing moves. */
export const stillWind = (base: PrevailingWind): WindNow => ({
  from: base.from,
  dir: windFrom(base.from),
  strength: 0,
});

/**
 * A world direction as it points on a screen turned to `bearing` degrees (tilted views, whose
 * cells are the screen's): turned back by the bearing.
 */
export function onScreen(dir: WindDir, bearing: number): WindDir {
  const b = (bearing * Math.PI) / 180;
  const [x, y] = dir;
  return [x * Math.cos(b) + y * Math.sin(b), -x * Math.sin(b) + y * Math.cos(b)];
}

/**
 * Rain (SPEC.md §4, with a storm): drops fall `speed` cells a second, `length` cells long, one
 * every `spacing` cells down a column; `density` of the columns carry rain at full strength.
 * They draw at `ink` over the map, which dims by `dim`. Their glyph leans with the wind.
 */
export const RAIN = {
  speed: 16,
  length: 2,
  spacing: 11,
  density: 0.4,
  ink: 0.55,
  dim: 0.22,
  /** Rows are taken modulo this (a multiple of `spacing`) first, to stay exact in float32. */
  wrap: 11 * 186,
} as const;

/** How hard it rains (0–1) for a prevailing wind: only in a storm, never with reduced motion. */
export const rainFor = (base: PrevailingWind, reducedMotion: boolean): number =>
  !reducedMotion && base.strength === 'storm' ? 1 : 0;

/** Which rain glyph (theme.ts `rainGlyphs`) a wind blowing along `dir` (grid cells) slants to. */
export const rainGlyphIndex = (dir: WindDir): number => (dir[0] > 0.3 ? 1 : dir[0] < -0.3 ? 2 : 0);

/**
 * Whether a drop covers world cell (`x`, `y`) at `time` in rain of strength `rain`: the CPU twin
 * of the glyph pass. A drop drifts sideways `slant / 2` columns per row (the wind's x).
 */
export function rainDrop(x: number, y: number, time: number, rain: number, slant = 0): boolean {
  if (rain <= 0) return false;
  const row = ((y % RAIN.wrap) + RAIN.wrap) % RAIN.wrap;
  const column = x - Math.floor(row * slant * 0.5 + 0.5);
  const h = cellHash(column, 7919);
  if (((h >>> 8) & 255) >= RAIN.density * rain * 256) return false;
  const along = row - time * RAIN.speed + (h & 1023);
  const phase = ((along % RAIN.spacing) + RAIN.spacing) % RAIN.spacing;
  return phase < RAIN.length;
}
