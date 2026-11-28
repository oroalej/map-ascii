import { describe, expect, it } from 'vitest';
import {
  cellStep,
  coarsened,
  DEFAULT_CELLS,
  detailZoom,
  STEP_HYSTERESIS,
  stepCell,
} from './density';

describe('cell size by zoom', () => {
  it('shrinks the cells in steps as the camera zooms in', () => {
    const widths = [8, 12.9, 13, 15, 16.4, 16.5, 18.9, 19, 20, 21].map(
      (z) => stepCell(DEFAULT_CELLS, cellStep(DEFAULT_CELLS, z)).width,
    );
    expect(widths).toEqual([8, 8, 7, 6, 6, 5, 5, 4, 3, 3]);
    expect(stepCell(DEFAULT_CELLS, 3)).toEqual({ width: 5, height: 9 });
  });

  it('draws the fine steps closer to square', () => {
    expect(stepCell(DEFAULT_CELLS, 4)).toEqual({ width: 4, height: 6 });
    expect(stepCell(DEFAULT_CELLS, 5)).toEqual({ width: 3, height: 5 });
  });

  it('drops the steps a lower quality tier cannot afford', () => {
    const coarse = coarsened(DEFAULT_CELLS, 5);
    expect(stepCell(coarse, cellStep(coarse, 21))).toEqual({ width: 5, height: 9 });
    expect(coarsened(DEFAULT_CELLS, 3)).toBe(DEFAULT_CELLS);
  });

  it('holds the current step until the zoom is clearly past its edge', () => {
    const edge = 15;
    expect(cellStep(DEFAULT_CELLS, edge + 0.1, 1)).toBe(1);
    expect(cellStep(DEFAULT_CELLS, edge + STEP_HYSTERESIS, 1)).toBe(2);
    expect(cellStep(DEFAULT_CELLS, edge - 0.1, 2)).toBe(2);
    expect(cellStep(DEFAULT_CELLS, edge - STEP_HYSTERESIS - 0.01, 2)).toBe(1);
    // A jump (a flight, a shared URL) goes straight to its step.
    expect(cellStep(DEFAULT_CELLS, 18, 0)).toBe(3);
  });
});

describe('detail zoom', () => {
  it('adds a level for each halving of the cell width', () => {
    expect(detailZoom(17, 10)).toBe(17);
    expect(detailZoom(17, 5)).toBe(18);
    expect(detailZoom(14, 20)).toBe(13);
  });
});
