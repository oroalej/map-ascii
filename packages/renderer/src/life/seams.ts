import { EXTENT } from '../raster/geometry';
import type { TileId } from '../tiles';
import { frameBetween, masked } from './frames';
import type { Mover, TileLife } from './simulate';

export const SEAMS = { missingSeconds: 3, rejectedSeconds: 8 } as const;

/** First geographic ownership boundary along this line, without choosing turns or drawing RNG. */
export function seamAhead(life: TileLife, m: Mover, covers: readonly TileId[], reach: number) {
  const { coords, starts } = life.geo;
  const rects = [
    { x0: 0, y0: 0, x1: EXTENT, y1: EXTENT },
    ...covers.map((tile) => {
      const f = frameBetween(tile, life.tile);
      return { x0: f.x, y0: f.y, x1: f.x + EXTENT * f.scale, y1: f.y + EXTENT * f.scale };
    }),
  ];
  const owns = (x: number, y: number) =>
    x >= 0 && x < EXTENT && y >= 0 && y < EXTENT && !masked(life.tile, { x, y }, covers);
  let from = m.from,
    traveled = 0,
    x = m.x,
    y = m.y;
  const end = m.dir === 1 ? starts[m.line + 1]! - 1 : starts[m.line]!;
  for (let n = 0; n < 256 && from !== end && traveled <= reach; n++) {
    const to = from + m.dir;
    const bx = coords[to * 2]!,
      by = coords[to * 2 + 1]!;
    const dx = bx - x,
      dy = by - y,
      length = Math.hypot(dx, dy);
    if (length > 0) {
      const cuts = [0, 1];
      for (const r of rects) {
        if (dx) for (const edge of [r.x0, r.x1]) cuts.push((edge - x) / dx);
        if (dy) for (const edge of [r.y0, r.y1]) cuts.push((edge - y) / dy);
      }
      cuts.sort((a, b) => a - b);
      for (const t of cuts) {
        if (t < 0 || t > 1 || traveled + t * length > reach) continue;
        const probe = t + (0.001 * life.perMeter) / length;
        const px = x + dx * probe,
          py = y + dy * probe;
        if (owns(px, py)) continue;
        const heading = { hx: dx / length, hy: dy / length };
        const preview: Mover = {
          ...m,
          ...heading,
          x: px,
          y: py,
          from,
          d: (from === m.from ? m.d : 0) + probe * length,
        };
        return { distance: traveled + t * length, preview };
      }
    }
    traveled += length;
    from = to;
    x = bx;
    y = by;
  }
  return undefined;
}
