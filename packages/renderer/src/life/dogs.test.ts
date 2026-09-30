import { describe, expect, it } from 'vitest';
import { dogFit, dogGlyph, dogGlyphs, dogInk, dogOf, dogPixels } from './dogs';
import { Heading } from './masters';

describe('dogs', () => {
  it('is drawn in one cell, then stamped from a cell and a half long', () => {
    expect(dogFit(0.3)).toBe('cell');
    expect(dogFit(1.4)).toBe('cell');
    expect(dogFit(2)).toBe('stamp');
  });

  it('has a glyph for each step and heading', () => {
    expect(dogGlyphs()).toHaveLength(12);
    const g = dogGlyph(1, Heading.left);
    expect(dogOf(g)).toEqual({ frame: 1, heading: Heading.left });
    expect(dogOf('x')).toBeUndefined();
  });

  it('turns its nose to its heading', () => {
    const up = dogPixels({ frame: 0, heading: Heading.up }, 10);
    const down = dogPixels({ frame: 0, heading: Heading.down }, 10);
    expect(up(4, 0)).toBe('o');
    expect(down(4, 9)).toBe('o');
    expect(down(4, 0)).not.toBe('o');
  });

  it('steps: its legs reach out on the other side each frame', () => {
    const differ = [5, 10, 20].some((detail) => {
      for (let u = 0.05; u < 1; u += 0.1) {
        for (let v = 0.05; v < 1; v += 0.1) {
          if (dogInk(0, u, v, detail) !== dogInk(1, u, v, detail)) return true;
        }
      }
      return false;
    });
    expect(differ).toBe(true);
  });

  it('appends a distinct resting pose, with four headings and matching stamped ink', () => {
    expect(dogGlyph(0, Heading.up).charCodeAt(0)).toBe(0xe200);
    expect(dogGlyph(1, Heading.left).charCodeAt(0)).toBe(0xe207);
    expect(new Set(dogGlyphs()).size).toBe(12);
    for (const box of [5, 10, 20]) {
      const rows = (frame: 0 | 1 | 2, heading: Heading) => {
        const at = dogPixels({ frame, heading }, box);
        return Array.from({ length: box }, (_, y) =>
          Array.from({ length: box }, (_, x) => at(x, y)).join(''),
        );
      };
      const up = rows(2, Heading.up);
      expect(up).not.toEqual(rows(0, Heading.up));
      expect(up).not.toEqual(rows(1, Heading.up));
      expect(rows(2, Heading.down)).toEqual(
        [...up].reverse().map((r) => [...r].reverse().join('')),
      );
      expect(new Set([0, 1, 2, 3].map((h) => rows(2, h as Heading).join(''))).size).toBe(4);
      for (let y = 0; y < box; y++)
        for (let x = 0; x < box; x++)
          expect(dogInk(2, 1 - (y + 0.5) / box, (x + 0.5) / box, box)).toBe(up[y]![x]);
    }
  });
});
