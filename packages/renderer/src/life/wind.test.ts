import type { ClimateConfig } from '@atlas/shared';
import { describe, expect, it } from 'vitest';
import { windFrom } from '../glyphs/select';
import {
  onScreen,
  prevailingWind,
  RAIN,
  rainDrop,
  rainFor,
  rainGlyphIndex,
  stillWind,
  WIND_PRESETS,
  WIND_VARIATION,
  windAt,
} from './wind';

const climate: ClimateConfig = {
  wind: [
    { months: [11, 12, 1, 2, 3], from: 45, strength: 'breeze' },
    { months: [6, 7, 8, 9], from: 225, strength: 'gusty' },
  ],
  default: { from: 90, strength: 'calm' },
  source: 'test',
};

describe('prevailingWind', () => {
  it("follows the season's wind", () => {
    expect(prevailingWind('live', climate, 1)).toEqual({ from: 45, strength: 'breeze' });
    expect(prevailingWind('live', climate, 7)).toEqual({ from: 225, strength: 'gusty' });
    expect(prevailingWind('live', climate, 5)).toEqual({ from: 90, strength: 'calm' });
  });

  it("keeps the season's direction when the visitor picks a strength", () => {
    expect(prevailingWind('storm', climate, 7)).toEqual({ from: 225, strength: 'storm' });
  });

  it('blows a breeze from the east without a climate', () => {
    expect(prevailingWind('live', undefined, 7)).toEqual({ from: 90, strength: 'breeze' });
  });
});

describe('windAt', () => {
  const base = { from: 45, strength: 'breeze' } as const;

  it('veers around the prevailing direction and breathes around its strength', () => {
    const froms = new Set<number>();
    for (let t = 0; t < 600; t += 7) {
      const wind = windAt(t, base);
      expect(Math.abs(wind.from - 45)).toBeLessThanOrEqual(WIND_VARIATION.veer);
      const s = wind.strength / WIND_PRESETS.breeze;
      expect(s).toBeGreaterThanOrEqual(1 - WIND_VARIATION.breathe);
      expect(s).toBeLessThanOrEqual(1 + WIND_VARIATION.breathe);
      expect(Math.hypot(...wind.dir)).toBeCloseTo(1);
      froms.add(Math.round(wind.from));
    }
    expect(froms.size).toBeGreaterThan(5);
  });

  it('changes smoothly', () => {
    for (let t = 0; t < 300; t += 1) {
      expect(Math.abs(windAt(t + 0.1, base).from - windAt(t, base).from)).toBeLessThan(0.5);
    }
  });

  it('stills the wind for reduced motion, keeping its direction', () => {
    expect(stillWind(base).strength).toBe(0);
    expect(stillWind(base).dir).toEqual(windFrom(45));
  });

  it('turns the direction with a tilted view', () => {
    const [x, y] = onScreen(windFrom(270), 90); // blowing east, the map turned to face east
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(-1); // up the screen
  });
});

describe('rain', () => {
  const cells = Array.from({ length: 64 * 64 }, (_, i) => [i % 64, 1_000_000 + Math.floor(i / 64)]);

  it('falls only in a storm, and never with reduced motion', () => {
    expect(rainFor({ from: 45, strength: 'storm' }, false)).toBe(1);
    expect(rainFor({ from: 45, strength: 'gusty' }, false)).toBe(0);
    expect(rainFor({ from: 45, strength: 'storm' }, true)).toBe(0);
    for (const [x, y] of cells.slice(0, 200)) expect(rainDrop(x!, y!, 3, 0)).toBe(false);
  });

  it('covers a sparse share of the cells, and moves down as it falls', () => {
    const at = (t: number) => cells.filter(([x, y]) => rainDrop(x!, y!, t, 1));
    const share = at(4).length / cells.length;
    expect(share).toBeGreaterThan(0.02);
    expect(share).toBeLessThan(0.15);
    // A drop one moment is `speed × dt` rows lower a moment later.
    const dt = 1 / RAIN.speed;
    for (const [x, y] of at(4).slice(0, 50)) expect(rainDrop(x!, y! + 1, 4 + dt, 1)).toBe(true);
  });

  it('slants its glyph with the wind', () => {
    expect(rainGlyphIndex(windFrom(270))).toBe(1); // blowing east: \
    expect(rainGlyphIndex(windFrom(90))).toBe(2); // blowing west: /
    expect(rainGlyphIndex(windFrom(0))).toBe(0); // straight down: |
  });
});
