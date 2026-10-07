/** Safe, complete lattice cells and row compaction, independent of walker connectivity. */
import { pointInPolygon } from '@atlas/shared';
import { intersection } from 'polyclip-ts';
import type { localFrame } from './geo';
type Point = [number, number];
export function safeLattice(
  frame: ReturnType<typeof localFrame>,
  bounds: [number, number, number, number],
  safe: (point: Point) => boolean,
  blocked: Point[][],
  step = 2,
) {
  const cells = new Map<string, Point>();
  const exclusions = blocked.map((r) => {
    const ring = r.map(frame.toMeters);
    return {
      ring,
      w: Math.min(...ring.map((q) => q[0])),
      e: Math.max(...ring.map((q) => q[0])),
      s: Math.min(...ring.map((q) => q[1])),
      n: Math.max(...ring.map((q) => q[1])),
    };
  });
  const h = step / 2;
  for (let y = Math.ceil(bounds[1] / step); y <= Math.floor(bounds[3] / step); y++)
    for (let x = Math.ceil(bounds[0] / step); x <= Math.floor(bounds[2] / step); x++) {
      const ring: Point[] = [
        [x * step - h, y * step - h],
        [x * step + h, y * step - h],
        [x * step + h, y * step + h],
        [x * step - h, y * step + h],
        [x * step - h, y * step - h],
      ];
      if (!ring.every(safe) || !safe([x * step, y * step])) continue;
      if (
        exclusions.some(
          (r) =>
            r.w <= x * step + h &&
            r.e >= x * step - h &&
            r.s <= y * step + h &&
            r.n >= y * step - h &&
            intersection([ring], [r.ring]).length,
        )
      )
        continue;
      cells.set(`${x}/${y}`, [x * step, y * step]);
    }
  return cells;
}
export function compactLattice(
  frame: ReturnType<typeof localFrame>,
  cells: ReadonlyMap<string, Point>,
  step = 2,
): Point[][] {
  const rows = new Map<number, number[]>();
  for (const [x, y] of cells.values()) {
    const row = Math.round(y / step);
    let xs = rows.get(row);
    if (!xs) rows.set(row, (xs = []));
    xs.push(Math.round(x / step));
  }
  const rings: Point[][] = [];
  for (const [y, xs] of [...rows].sort((a, b) => a[0] - b[0])) {
    xs.sort((a, b) => a - b);
    for (let i = 0; i < xs.length; i++) {
      const start = xs[i]!;
      let end = start;
      while (xs[i + 1] === end + 1) end = xs[++i]!;
      rings.push(
        [
          [start - 0.5, y - 0.5],
          [end + 0.5, y - 0.5],
          [end + 0.5, y + 0.5],
          [start - 0.5, y + 0.5],
          [start - 0.5, y - 0.5],
        ].map(([x, y]) => frame.toLngLat([x! * step, y! * step])),
      );
    }
  }
  return rings;
}
export function bakeCrowdAreas(
  frame: ReturnType<typeof localFrame>,
  polygons: Point[][][],
  blocked: Point[][],
  step = 2,
): Point[][] {
  const points = polygons.flat(2).map(frame.toMeters);
  if (!points.length) return [];
  const bounds: [number, number, number, number] = [
    Math.min(...points.map((q) => q[0])),
    Math.min(...points.map((q) => q[1])),
    Math.max(...points.map((q) => q[0])),
    Math.max(...points.map((q) => q[1])),
  ];
  return compactLattice(
    frame,
    safeLattice(
      frame,
      bounds,
      (q) => polygons.some((p) => pointInPolygon(frame.toLngLat(q), p)),
      [...blocked, ...polygons.flatMap((p) => p.slice(1))],
      step,
    ),
    step,
  );
}
