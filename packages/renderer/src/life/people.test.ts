import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { UMBRELLA, umbrellaShare } from './config';
import { Heading } from './masters';
import {
  CANDLE_BIT,
  FIGURE_MASTERS,
  isCarrier,
  figureGlyph,
  figureOf,
  figurePixels,
  figureInk,
  PAINT_NONE,
  PersonPart,
  personByte,
  personGlyphs,
} from './people';
import { PAINT_COUNT, Paint, STALL_GLYPH } from './vehicles';

describe('people', () => {
  it('stamps distinct carriers while retaining every adult coarse glyph', () => {
    const carriers = ['pole-buckets', 'basket', 'head-tray', 'chest-tray'] as const;
    const masters = carriers.map((figure) => FIGURE_MASTERS[figure][10]!.join(''));
    expect(new Set(masters).size).toBe(4);
    for (const figure of carriers) {
      expect(isCarrier(figure)).toBe(true);
      expect(figureGlyph(figure, false, 0)).toBe(figureGlyph('adult', false, 0));
      expect(figureGlyph(figure, true, 1, { slice: 2 })).toBe(
        figureGlyph('adult', true, 1, { slice: 2 }),
      );
      expect(
        Array.from({ length: 100 }, (_, i) =>
          figureInk(figure, 0, (i % 10) / 10, Math.floor(i / 10) / 10, 10),
        ).some((ink) => ink !== '.'),
      ).toBe(true);
    }
    expect(personGlyphs()).toHaveLength(201);
  });
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
      expect(
        figureGlyph(f.figure, f.across, f.frame, at, f.stroke ?? 0, f.heading, f.pose, f.stage),
      ).toBe(g);
    }
    expect(figureOf('☺')).toBeUndefined();
  });

  it('draws figures the same turned half round, so heading down looks like heading up', () => {
    for (const [figure, masters] of Object.entries(FIGURE_MASTERS)) {
      for (const [size, rows] of Object.entries(masters)) {
        expect(rows, `${figure} ${size}`).toHaveLength(Number(size));
        for (const row of rows) expect(row).toMatch(new RegExp(`^[#o.]{${size}}$`));
        // Carried goods, paddlers and seated figures have directional masters.
        if (!['adult', 'child', 'umbrella'].includes(figure)) continue;
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

  it('appends age-preserving stationary poses with distinct cardinal directions and stamp ink', () => {
    expect(personGlyphs()).toHaveLength(201);
    for (const figure of ['adult', 'child'] as const)
      for (const pose of ['attentive', 'gesture'] as const)
        for (const box of [5, 10, 20]) {
          const rows = (heading: Heading) => {
            const pixels = figurePixels({ figure, pose, heading, across: false, frame: 0 }, box);
            return Array.from({ length: box }, (_, y) =>
              Array.from({ length: box }, (_, x) => pixels(x, y)).join(''),
            );
          };
          const up = rows(Heading.up);
          expect(new Set([0, 1, 2, 3].map((h) => rows(h as Heading).join(''))).size).toBe(4);
          expect(rows(Heading.down)).toEqual(
            [...up].reverse().map((r) => [...r].reverse().join('')),
          );
          for (let y = 0; y < box; y++)
            for (let x = 0; x < box; x++)
              expect(figureInk(figure, 1, 1 - (y + 0.5) / box, (x + 0.5) / box, box, 1, pose)).toBe(
                up[y]![x],
              );
          expect(
            figureOf(figureGlyph(figure, true, 1, { scale: 2 }, 0, Heading.left, pose)),
          ).toMatchObject({ figure, pose, heading: Heading.left });
        }
  });
  it('preserves every legacy descriptor and full canopy while appending fourteen stage glyphs', () => {
    const glyphs = personGlyphs();
    // Frozen pre-change descriptors and masters protect packed glyph meanings, including poses.
    const hash = (value: unknown) =>
      createHash('sha256').update(JSON.stringify(value)).digest('hex');
    expect(hash(glyphs.slice(0, 187).map(figureOf))).toBe(
      '64b2c30eabe6d6d56b84887e670ef71b10d6f21d77b046b9a0be174bc092b3d4',
    );
    expect(hash(FIGURE_MASTERS.umbrella)).toBe(
      'e41f2a96577ec044a1e3114c7aa3f0f5966e9ff8b109e8a04630b98a836d708e',
    );
    glyphs.forEach((glyph, index) => expect(glyph.charCodeAt(0)).toBe(0xe000 + index));
    for (const stage of [0, 1] as const) {
      const added = glyphs.slice(187 + stage * 7, 194 + stage * 7).map(figureOf);
      expect(added.map((g) => g!.stage)).toEqual(new Array(7).fill(stage));
      expect(added.slice(0, 3).map((g) => g!.scale)).toEqual([0, 1, 2]);
      expect(added.slice(3).map((g) => g!.slice)).toEqual([0, 1, 2, 3]);
    }
  });

  it('keeps both stage inks inside the full canopy across small and large pixel boxes', () => {
    for (const box of [5, 6, 8, 9, 10, 15, 20, 30]) {
      const full = figurePixels({ figure: 'umbrella', across: false, frame: 0 }, box);
      const counts: number[] = [];
      for (const stage of [0, 1] as const) {
        const pixels = figurePixels({ figure: 'umbrella', across: false, frame: 0, stage }, box);
        const marks: string[] = [];
        let fullCount = 0;
        for (let y = 0; y < box; y++)
          for (let x = 0; x < box; x++) {
            if (full(x, y) !== '.') fullCount++;
            if (pixels(x, y) === '.') continue;
            expect(full(x, y)).not.toBe('.');
            marks.push(pixels(x, y));
          }
        expect(marks).toContain('#');
        expect(marks).toContain('o');
        expect(marks.length).toBeLessThan(fullCount);
        counts.push(marks.length);
      }
      expect(counts[0]).toBeLessThan(counts[1]!);
    }
  });

  it('centers both stages when the pixel box has room for distinct symmetric insets', () => {
    for (const box of [7, 8, 9, 10, 11, 15, 20, 30])
      for (const stage of [0, 1] as const) {
        const pixels = figurePixels({ figure: 'umbrella', across: false, frame: 0, stage }, box);
        const xs: number[] = [],
          ys: number[] = [];
        for (let y = 0; y < box; y++)
          for (let x = 0; x < box; x++)
            if (pixels(x, y) !== '.') {
              xs.push(x);
              ys.push(y);
            }
        expect(Math.min(...xs) + Math.max(...xs)).toBe(box - 1);
        expect(Math.min(...ys) + Math.max(...ys)).toBe(box - 1);
      }
  });
});
