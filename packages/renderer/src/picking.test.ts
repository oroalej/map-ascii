import { describe, expect, it } from 'vitest';
import { isTap, TAP_SLOP } from './input';
import { cellState, CellState, pointerCell } from './picking';
import { packId, unpackId } from './raster/geometry';

describe('pointerCell', () => {
  const grid = { shiftX: 7, shiftY: 4, cellWidth: 20, cellHeight: 36 };

  it('inverts the glyph pass: floor((screen + shift) / cell)', () => {
    // At dpr 2, CSS (0, 0) is device (0, 0): grid (7, 4), inside cell (0, 0).
    expect(pointerCell([0, 0], 2, grid)).toEqual([0, 0]);
    // CSS (7, 16) → device (14, 32) → grid (21, 36): the first pixel of cell (1, 1).
    expect(pointerCell([7, 16], 2, grid)).toEqual([1, 1]);
    expect(pointerCell([6.4, 15.9], 2, grid)).toEqual([0, 0]);
  });
});

describe('feature ids in the id buffer', () => {
  it('round-trip through the four bytes', () => {
    for (const i of [0, 1, 255, 256, 70_000, 2 ** 31 + 5]) expect(unpackId(packId(i))).toBe(i);
    expect(unpackId(new Uint8Array(packId(123_456)))).toBe(123_456);
  });
});

describe('cellState', () => {
  it('ranks selected over highlighted over hovered, and ignores empty cells', () => {
    expect(cellState(0, 0, 0, [])).toBe(CellState.none);
    expect(cellState(5, 5, 5, [5])).toBe(CellState.selected);
    expect(cellState(5, 5, 9, [5])).toBe(CellState.highlight);
    expect(cellState(5, 5, 9, [])).toBe(CellState.hover);
    expect(cellState(5, 6, 9, [7])).toBe(CellState.none);
  });
});

describe('isTap', () => {
  it('is a short press that barely moved', () => {
    expect(isTap(0, 120)).toBe(true);
    expect(isTap(TAP_SLOP, 120)).toBe(false);
    expect(isTap(1, 900)).toBe(false);
  });
});
