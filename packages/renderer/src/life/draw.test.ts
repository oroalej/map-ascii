import { describe, expect, it } from 'vitest';
import { classId } from '../classes';
import { themes } from '../theme';
import { agentBit } from './config';
import { packLife, type LifeGrid } from './draw';

const glyphs = ['', '▬', '▮', '☺', '◊', 'v', '-'];
const glyphIndex = (g: string) => Math.max(0, glyphs.indexOf(g));
/** lng → column and lat → row, one cell per degree. */
const grid: LifeGrid = {
  cols: 10,
  rows: 5,
  cellWidth: 10,
  cellHeight: 18,
  toCell: (lng, lat) => [lng, lat],
};
const cell = (out: Uint8Array, col: number, row: number) =>
  Array.from(out.subarray((row * grid.cols + col) * 4, (row * grid.cols + col) * 4 + 4));

describe('packLife', () => {
  it('writes the glyph, the life class, and the agent bit', () => {
    const out = new Uint8Array(grid.cols * grid.rows * 4);
    const drawn = packLife(
      out,
      grid,
      [{ kind: 'person', lng: 2.5, lat: 1.2, flap: 0 }],
      themes.dark,
      glyphIndex,
    );
    expect(drawn).toBe(1);
    expect(cell(out, 2, 1)).toEqual([
      glyphIndex('☺'),
      classId('life_person'),
      agentBit.person,
      255,
    ]);
  });

  it('turns vehicles with their heading on screen', () => {
    const out = new Uint8Array(grid.cols * grid.rows * 4);
    packLife(
      out,
      grid,
      [
        { kind: 'vehicle', lng: 1, lat: 1, ahead: [1.5, 1.1], flap: 0 },
        { kind: 'vehicle', lng: 4, lat: 1, ahead: [4.1, 1.5], flap: 0 },
      ],
      themes.dark,
      glyphIndex,
    );
    expect(cell(out, 1, 1)[0]).toBe(glyphIndex('▬'));
    expect(cell(out, 4, 1)[0]).toBe(glyphIndex('▮'));
  });

  it('beats birds’ wings, skips agents off the grid, and clears what was there', () => {
    const out = new Uint8Array(grid.cols * grid.rows * 4).fill(9);
    const drawn = packLife(
      out,
      grid,
      [
        { kind: 'bird', lng: 3, lat: 3, flap: 1 },
        { kind: 'boat', lng: -1, lat: 3, flap: 0 },
        { kind: 'boat', lng: 3, lat: 9, flap: 0 },
      ],
      themes.dark,
      glyphIndex,
    );
    expect(drawn).toBe(1);
    expect(cell(out, 3, 3)[0]).toBe(glyphIndex('-'));
    expect(cell(out, 0, 0)).toEqual([0, 0, 0, 0]);
  });
});
