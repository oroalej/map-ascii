/**
 * Map cell size by zoom (SPEC.md §2 "Cell size"): characters get smaller as the camera zooms
 * in, in steps, so close views fit more cells and more detail. Labels keep their own, fixed cell
 * size. Cell-sized detail (outlines, road strips, roofs) follows the ground each cell covers,
 * as a "detail zoom".
 */

/**
 * A step of the schedule: from `minZoom` on, map cells are `width` CSS px wide. `height` overrides
 * the schedule's aspect, for the fine steps whose cells are closer to square.
 */
export type CellStep = { minZoom: number; width: number; height?: number };

export type CellSchedule = {
  /** Ordered by `minZoom`; the first applies below every other. */
  steps: readonly CellStep[];
  /** Cell height ÷ width, for steps without their own `height`. */
  aspect: number;
};

export const DEFAULT_CELLS: CellSchedule = {
  steps: [
    { minZoom: -Infinity, width: 8 },
    { minZoom: 13, width: 7 },
    { minZoom: 15, width: 6 },
    { minZoom: 16.5, width: 5 },
    // Fine steps: too small for letters, so the map reads as a dot grid (glyphs/atlas.ts) and each
    // zoom level past the last detail threshold still resolves more of the ground.
    { minZoom: 19, width: 4, height: 6 },
    { minZoom: 20, width: 3, height: 5 },
  ],
  aspect: 1.8,
};

/** Labels' cell size in CSS px: readable text whatever the map's density. */
export const DEFAULT_LABEL_CELL = { width: 10, height: 18 } as const;

/** Zooming this far past a step's edge before it switches, so it doesn't flicker there. */
export const STEP_HYSTERESIS = 0.15;

/**
 * The step for `zoom`. With the `current` step, it switches only once the zoom is
 * `STEP_HYSTERESIS` past the current step's range.
 */
export function cellStep(schedule: CellSchedule, zoom: number, current?: number): number {
  const { steps } = schedule;
  let step = 0;
  for (let i = 1; i < steps.length; i++) if (zoom >= steps[i]!.minZoom) step = i;
  if (current === undefined || current === step || !steps[current]) return step;
  const from = steps[current].minZoom - STEP_HYSTERESIS;
  const to = (steps[current + 1]?.minZoom ?? Infinity) + STEP_HYSTERESIS;
  return zoom >= from && zoom < to ? current : step;
}

/** A step's cell size in CSS px. */
export function stepCell(schedule: CellSchedule, step: number) {
  const { width, height } = schedule.steps[step]!;
  return { width, height: height ?? Math.round(width * schedule.aspect) };
}

/** Cells narrower than this cannot show a character; their glyphs draw as dots and tones. */
export const FINE_CELL_WIDTH = 5;

/**
 * The schedule with no step finer than `minWidth`: lower quality tiers keep larger cells, since
 * the cell-resolution passes cost in proportion to the cell count.
 */
export function coarsened(schedule: CellSchedule, minWidth: number): CellSchedule {
  const steps = schedule.steps.filter((s, i) => i === 0 || s.width >= minWidth);
  return steps.length === schedule.steps.length ? schedule : { ...schedule, steps };
}

/** The cell width detail thresholds (`OUTLINE_ZOOM` etc.) were set for. */
export const REFERENCE_CELL_WIDTH = 10;

/**
 * The zoom at which a `REFERENCE_CELL_WIDTH` cell covers the ground a `cellWidth` cell covers
 * at `zoom`: half-size cells add one level of detail.
 */
export const detailZoom = (zoom: number, cellWidth: number): number =>
  zoom + Math.log2(REFERENCE_CELL_WIDTH / cellWidth);
