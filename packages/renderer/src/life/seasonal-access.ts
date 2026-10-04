import {
  localMetricProjection,
  seasonalAccessRing,
  type SeasonalAccessRecord,
} from '@atlas/shared';
import type { FixtureGrid } from './fixtures';
import { SeasonalPart } from './seasonal-glyphs';
import { seasonalStroke as stroke, type SeasonalWrite as Write } from './seasonal-packing';

export const AccessInk = { paving: 0, curb: 1, joint: 2, marking: 3 } as const;

/** Metric paving and parking markings, sampled from complete segments rather than viewport cells. */
export function packAccess(record: SeasonalAccessRecord, grid: FixtureGrid, write: Write): boolean {
  const projection = localMetricProjection(record.from);
  const end = projection.to(record.to),
    length = Math.hypot(...end),
    half = record.width_m / 2;
  const a = grid.toCell(...record.from),
    b = grid.toCell(...record.to);
  const east = grid.toCell(...projection.from([1, 0])),
    north = grid.toCell(...projection.from([0, 1]));
  const ex = east[0] - a[0],
    ey = east[1] - a[1],
    nx = north[0] - a[0],
    ny = north[1] - a[1];
  const det = ex * ny - ey * nx;
  if (!Number.isFinite(length + det) || length === 0 || Math.abs(det) < 1e-12) return false;
  const ux = end[0] / length,
    uy = end[1] / length;
  const ring = seasonalAccessRing(record).map((p) => grid.toCell(...p));
  const x0 = Math.max(0, Math.floor(Math.min(...ring.map((p) => p[0])))),
    x1 = Math.min(grid.cols - 1, Math.ceil(Math.max(...ring.map((p) => p[0])))),
    y0 = Math.max(0, Math.floor(Math.min(...ring.map((p) => p[1])))),
    y1 = Math.min(grid.rows - 1, Math.ceil(Math.max(...ring.map((p) => p[1]))));
  if (!Number.isFinite(x0 + x1 + y0 + y1) || (x1 - x0 + 1) * (y1 - y0 + 1) > 200000) return false;
  const longitudinal = stroke((b[0] - a[0]) * grid.cellWidth, (b[1] - a[1]) * grid.cellHeight);
  const transverse = stroke(
    (-uy * ex + ux * nx) * grid.cellWidth,
    (-uy * ey + ux * ny) * grid.cellHeight,
  );
  const crossCell = (Math.abs(uy * ny + ux * ey) + Math.abs(uy * nx + ux * ex)) / Math.abs(det);
  const alongCell = (Math.abs(ux * ny - uy * ey) + Math.abs(-ux * nx + uy * ex)) / Math.abs(det);
  const edge = Math.min(half * 0.35, Math.max(0.1, crossCell * 0.5));
  const style = record.style === 'walkway' ? 0 : record.style === 'driveway' ? 1 : 2;
  const bayWidth = 2.4,
    divider = -half + bayWidth;
  const bays = Math.max(0, Math.floor((length - 1) / 5.8)),
    bayLength = bays ? (length - 1) / bays : 0;
  let visible = false;
  const put = (x: number, y: number, glyph: string, role: number) => {
    if (x < 0 || y < 0 || x >= grid.cols || y >= grid.rows) return;
    visible = write(x, y, glyph, SeasonalPart.accessSurface, style | (role << 2), true) || visible;
  };
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - a[0],
        dy = y + 0.5 - a[1];
      const mx = (dx * ny - dy * nx) / det,
        my = (dy * ex - dx * ey) / det;
      const t = mx * ux + my * uy,
        q = -mx * uy + my * ux;
      // Flat ends avoid the previous blob-like caps; reserved envelopes stay conservative.
      if (t < 0 || t > length || Math.abs(q) > half) continue;
      if (half - Math.abs(q) < edge) put(x, y, longitudinal, AccessInk.curb);
      else if (t < alongCell * 0.5 || length - t < alongCell * 0.5)
        put(x, y, transverse, AccessInk.curb);
      else if (style === 0) {
        const row = Math.floor((q + half) / 0.6);
        const phase = (((t + (row % 2) * 0.5) % 1) + 1) % 1;
        if (Math.min(phase, 1 - phase) < Math.max(0.08, alongCell * 0.55))
          put(x, y, transverse, AccessInk.joint);
        else put(x, y, '·', AccessInk.paving);
      } else {
        const bayLine =
          bays &&
          q < divider + edge &&
          t >= 0.5 &&
          t <= length - 0.5 &&
          Math.min((t - 0.5) % bayLength, bayLength - ((t - 0.5) % bayLength)) < alongCell * 0.5;
        if (style === 2 && (Math.abs(q - divider) < edge * 0.55 || bayLine))
          put(x, y, bayLine ? transverse : longitudinal, AccessInk.marking);
        else put(x, y, '·', AccessInk.paving);
      }
    }
  if (style === 2 && bays) {
    const along = (x: number, y: number) =>
      ((x - a[0]) * (ux * ny - uy * ey) + (y - a[1]) * (-ux * nx + uy * ex)) / det;
    const visibleRange = [
      along(0, 0),
      along(grid.cols, 0),
      along(0, grid.rows),
      along(grid.cols, grid.rows),
    ];
    const first = Math.max(0, Math.ceil((Math.min(...visibleRange) - 0.5) / bayLength - 0.5));
    const last = Math.min(
      bays - 1,
      Math.floor((Math.max(...visibleRange) - 0.5) / bayLength - 0.5),
    );
    for (let i = first; i <= last; i++) {
      const t = 0.5 + bayLength * (i + 0.5),
        q = -half + bayWidth / 2;
      put(
        ...grid.toCell(...projection.from([ux * t - uy * q, uy * t + ux * q])),
        'P',
        AccessInk.marking,
      );
    }
    const t = length / 2,
      q = (divider + half) / 2;
    const angle = Math.atan2(-(b[1] - a[1]) * grid.cellHeight, (b[0] - a[0]) * grid.cellWidth);
    const arrow = ['→', '↗', '↑', '↖', '←', '↙', '↓', '↘'][
      (Math.round(angle / (Math.PI / 4)) + 8) % 8
    ]!;
    put(
      ...grid.toCell(...projection.from([ux * t - uy * q, uy * t + ux * q])),
      arrow,
      AccessInk.marking,
    );
  }
  return visible;
}
