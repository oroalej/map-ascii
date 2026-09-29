/**
 * Picking (ARCHITECTURE.md §3 step 7): which cell of the cell grid is under the pointer, so the
 * renderer can read that one texel of the id buffer back.
 */

/** The grid placement the glyph pass uses: device pixels from the screen to the grid. */
export type GridPlacement = {
  /** Device-pixel offset of the screen's top-left corner inside the grid. */
  shiftX: number;
  shiftY: number;
  /** Cell size in device pixels. */
  cellWidth: number;
  cellHeight: number;
};

/**
 * The grid cell (column, row from the top) under a pointer at (x, y) CSS pixels from the
 * canvas's top left. It inverts the glyph pass: `cell = floor((screen + shift) / cell size)`.
 */
export function pointerCell(
  [x, y]: readonly [number, number],
  dpr: number,
  grid: GridPlacement,
): [number, number] {
  return [
    Math.floor((x * dpr + grid.shiftX) / grid.cellWidth),
    Math.floor((y * dpr + grid.shiftY) / grid.cellHeight),
  ];
}

/** Most features `setHighlighted` can light up at once (e.g. the ways of one street). */
export const MAX_HIGHLIGHT = 64;

/** Per-cell highlight state, written by the select pass and read by the glyph pass. */
export const CellState = { none: 0, hover: 1, highlight: 2, selected: 3 } as const;

/** The state of a cell whose feature index is `index` (0 = no feature). */
export function cellState(
  index: number,
  hover: number,
  selected: number,
  highlighted: readonly number[],
): number {
  if (index === 0) return CellState.none;
  if (index === selected) return CellState.selected;
  if (highlighted.includes(index)) return CellState.highlight;
  if (index === hover) return CellState.hover;
  return CellState.none;
}
