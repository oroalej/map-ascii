/**
 * Picking (ARCHITECTURE.md §3 step 7): which cell of the cell grid is under the pointer, so the
 * renderer can read that one texel of the id buffer back.
 */
import type { CameraState } from '@atlas/shared';
import type { Size } from './camera';
import type { Readback } from './readback';
import { unpackId } from './raster/geometry';

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

/**
 * Most features that can light up at once: the ways of one street, or a legend entry's members
 * with their parts. A multiple of 4, since the select shader packs four indices per uniform.
 */
export const MAX_HIGHLIGHT = 128;

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

/** A pick the renderer answers once the GPU has the id buffer texel. */
export type PickResult = {
  point: [number, number];
  click: boolean;
  /** The id-buffer feature index under the point (0 = none). */
  index: number;
  /** The camera and view size (CSS px) when the texel was drawn, for unprojecting the point. */
  camera: CameraState;
  size: Size;
};

/** What `Picker.issue` needs to know about the frame just drawn. */
export type PickFrame = {
  fbo: WebGLFramebuffer;
  attachment: number;
  cols: number;
  rows: number;
  dpr: number;
  grid: GridPlacement;
  camera: CameraState;
  size: Size;
  /** Bumped whenever the cell targets are recreated; reads from older targets are dropped. */
  generation: number;
};

/**
 * Pointer picks, answered asynchronously: at most one id-buffer read is issued per frame, after
 * drawing. A click always wins over a hover waiting in the same frame.
 */
export class Picker {
  private queued: { point: [number, number]; click: boolean } | null = null;

  constructor(
    private readonly readback: Readback,
    private readonly generation: () => number,
    private readonly onResult: (result: PickResult) => void,
  ) {}

  hover(point: [number, number]) {
    if (!this.queued?.click) this.queued = { point, click: false };
  }

  click(point: [number, number]) {
    this.queued = { point, click: true };
  }

  /** Forget a hover that hasn't been read yet (the pointer left). */
  cancelHover() {
    if (this.queued && !this.queued.click) this.queued = null;
  }

  /** Read the queued pick's texel from the frame just drawn. */
  issue(frame: PickFrame) {
    if (!this.queued) return;
    const { point, click } = this.queued;
    this.queued = null;
    const { camera, size, generation } = frame;
    const [col, row] = pointerCell(point, frame.dpr, frame.grid);
    if (col < 0 || row < 0 || col >= frame.cols || row >= frame.rows) {
      this.onResult({ point, click, index: 0, camera, size });
      return;
    }
    this.readback.request(
      frame.fbo,
      frame.attachment,
      { x: col, y: row, width: 1, height: 1 },
      (data) => {
        if (generation !== this.generation()) return;
        this.onResult({ point, click, index: unpackId(data), camera, size });
      },
    );
  }
}
