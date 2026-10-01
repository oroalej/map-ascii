import { labelVisibility, type LabelCandidate } from './labels';
import { KEEP_OVERHANG } from './label-stability';
import type { GridPlacement, View } from './grid';
import type { TileLabel } from './raster/geometry';

/** The conservative whole-cell area used to admit new text. */
export function labelArea(view: View, placement: GridPlacement) {
  const { shiftX, shiftY } = placement.grid;
  const { w, h } = view.labelDev;
  return {
    left: Math.ceil(shiftX / w),
    top: Math.ceil(shiftY / h),
    right: Math.floor((shiftX + view.width) / w),
    bottom: Math.floor((shiftY + view.height) / h),
  };
}

/** Includes partially visible cells when reporting text actually on screen. */
export function labelScreenArea(view: View, grid: GridPlacement['grid']) {
  const { w, h } = view.labelDev;
  return {
    left: grid.shiftX / w,
    top: grid.shiftY / h,
    right: (grid.shiftX + view.width) / w,
    bottom: (grid.shiftY + view.height) / h,
  };
}

/** Prepare identically for copy collection, focus eligibility and overlay placement. */
export function labelCandidate(
  label: TileLabel,
  view: View,
  placement: GridPlacement,
): LabelCandidate | undefined {
  const vis = labelVisibility(label.band, view.camera.zoom);
  if (vis <= 0) return;
  const [col, row] = placement.toCell(label.lng, label.lat);
  const area = labelArea(view, placement);
  const reach = label.text.length + 3 + KEEP_OVERHANG;
  if (
    col < area.left - reach ||
    col >= area.right + reach ||
    row < area.top - reach ||
    row >= area.bottom + reach
  )
    return;
  let runCells: number | undefined;
  if (label.run) {
    const a = placement.toCell(...label.run[0]),
      b = placement.toCell(...label.run[1]);
    runCells =
      Math.hypot((b[0] - a[0]) * view.labelDev.w, (b[1] - a[1]) * view.labelDev.h) /
      view.labelDev.w;
  }
  return {
    id: label.id,
    text: label.text,
    rank: label.rank,
    vis,
    col: Math.floor(col),
    row: Math.floor(row),
    mode: label.angle !== undefined ? 'rotated' : 'beside',
    angle: label.angle,
    runCells,
  };
}
