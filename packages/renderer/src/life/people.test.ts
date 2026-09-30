import { describe, expect, it } from 'vitest';
import { UMBRELLA, umbrellaShare } from './config';
import { Heading } from './masters';
import {
  CANDLE_BIT,
  FIGURE_MASTERS,
  figureGlyph,
  figureOf,
  figurePixels,
  PAINT_NONE,
  PersonPart,
  personByte,
  personGlyphs,
} from './people';
import { PAINT_COUNT, Paint, STALL_GLYPH } from './vehicles';

describe('people', () => {
  it('packs paint, part, and candle into one byte', () => {
    expect(personByte(Paint.red, PersonPart.figure)).toBe(Paint.red);
    expect(personByte(Paint.red, PersonPart.canopy, true)).toBe(Paint.red | 16 | CANDLE_BIT);
    // No paint is past the last paint, so it can't be mistaken for one.
    expect(PAINT_NONE).toBeGreaterThanOrEqual(PAINT_COUNT);
    expect(personByte(PAINT_NONE, PersonPart.figure) & 15).toBe(PAINT_NONE);
  });

  it('draws with Private Use glyphs of its own, each naming its figure', () => {
    const glyphs = personGlyphs();
    expect(new Set(glyphs).size).toBe(glyphs.length);
    expect(glyphs).not.toContain(STALL_GLYPH);
    for (const g of glyphs) {
      expect(g.charCodeAt(0)).toBeGreaterThanOrEqual(0xe000);
      expect(g.charCodeAt(0)).toBeLessThan(0xf900);
      const f = figureOf(g)!;
      const at = f.slice === undefined ? { scale: f.scale! } : { slice: f.slice };
      expect(figureGlyph(f.figure, f.across, f.frame, at, f.stroke ?? 0, f.heading)).toBe(g);
    }
    expect(figureOf('☺')).toBeUndefined();
  });

  it('draws figures the same turned half round, so heading down looks like heading up', () => {
    for (const [figure, masters] of Object.entries(FIGURE_MASTERS)) {
      for (const [size, rows] of Object.entries(masters)) {
        expect(rows, `${figure} ${size}`).toHaveLength(Number(size));
        for (const row of rows) expect(row).toMatch(new RegExp(`^[#o.]{${size}}$`));
        // A paddler turned round is the other side's paddler at the other end of the stroke.
        if (figure === 'rower' || figure === 'seated') continue;
        const turned = [...rows].reverse().map((row) => [...row].reverse().join(''));
        expect(turned, `${figure} ${size}`).toEqual(rows);
      }
    }
  });

  it('draws a paddler turned half round as the other side’s, at the other end of the stroke', () => {
    const box = 10;
    const pixels = (frame: 0 | 1, stroke: 0 | 1) => {
      const at = figurePixels({ figure: 'rower', across: false, frame, stroke }, box);
      return Array.from({ length: box }, (_, y) =>
        Array.from({ length: box }, (_, x) => at(x, y)).join(''),
      );
    };
    const turn = (rows: string[]) => [...rows].reverse().map((row) => [...row].reverse().join(''));
    for (const frame of [0, 1] as const) {
      for (const stroke of [0, 1] as const) {
        expect(turn(pixels(frame, stroke))).toEqual(
          pixels((1 - frame) as 0 | 1, (1 - stroke) as 0 | 1),
        );
      }
    }
    // Paddle on the left at the reach: its blade is ahead and out to the left.
    expect(pixels(0, 0)[0]![0]).toBe('o');
    expect(pixels(0, 1)[box - 1]![0]).toBe('o');
    expect(pixels(1, 0)[0]![box - 1]).toBe('o');
  });

  it('opens more umbrellas in the rain and under a high sun, a few otherwise', () => {
    expect(umbrellaShare(1, 20)).toBe(UMBRELLA.rain);
    expect(umbrellaShare(0, 70)).toBeGreaterThan(umbrellaShare(0, 40));
    expect(umbrellaShare(0, 40)).toBeGreaterThan(umbrellaShare(0, 20));
    expect(umbrellaShare(0, -10)).toBe(UMBRELLA.base);
  });

  it('keeps legacy characters and turns the static seated silhouette through all headings', () => {
    expect(figureGlyph('adult', false, 0, { scale: 0 }).charCodeAt(0)).toBe(0xe000);
    expect(figureGlyph('umbrella', false, 0, { scale: 0 }).charCodeAt(0)).toBe(0xe008);
    for (const box of [5, 10, 20]) {
      const rows = (heading: Heading) => {
        const at = figurePixels({ figure: 'seated', across: false, frame: 0, heading }, box);
        return Array.from({ length: box }, (_, y) =>
          Array.from({ length: box }, (_, x) => at(x, y)).join(''),
        );
      };
      const up = rows(Heading.up);
      expect(rows(Heading.down)).toEqual([...up].reverse().map((r) => [...r].reverse().join('')));
      expect(rows(Heading.right)).toEqual(
        Array.from({ length: box }, (_, y) =>
          Array.from({ length: box }, (_, x) => up[box - 1 - x]![y]).join(''),
        ),
      );
      expect(new Set([0, 1, 2, 3].map((h) => rows(h as Heading).join(''))).size).toBe(4);
      expect(up).not.toEqual(FIGURE_MASTERS.adult[box]);
    }
  });
});
