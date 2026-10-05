import { labelVisibility, type LabelCandidate } from './labels';
import { KEEP_OVERHANG } from './label-stability';
import { screenArea, type GridPlacement, type View } from './grid';
import type { LabelArea } from './labels';
import type { TileLabel } from './raster/geometry';

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
  area: LabelArea = screenArea(view, placement.grid, view.labelDev),
): LabelCandidate | undefined {
  const vis = labelVisibility(label.band, view.camera.zoom);
  if (vis <= 0) return;
  const [col, row] = placement.toCell(label.lng, label.lat);
  // No slot extends farther than the text's length plus its anchor offset and retention
  // margin. Keep near-edge anchors for exact slot checks; reject only impossible reaches.
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
