import { ADOPT, usableLines } from './config';
import { LifeLine, type LifeGeometry } from './geometry';
import { frameBetween } from './frames';
import { VEHICLES } from './vehicles';
import type { Mover, TileLife } from './simulate';
import type { ContinuityRejection } from './diagnostics';

export type AdoptionOptions = {
  snapM?: number;
  bearingDeg?: number;
  replace?: Mover;
  reject?: (reason: ContinuityRejection) => void;
  nudgeM?: number;
};
type Segment = {
  line: number;
  v: number;
  ax: number;
  ay: number;
  dx: number;
  dy: number;
  length: number;
};

/** Built only on a tile's first zoom transfer. Index actual crossed cells, not a diagonal AABB. */
export class SegmentGrid {
  private readonly bins = new Map<number, Map<number, Segment[]>>();
  private readonly cell: number;
  readonly identified: boolean;

  constructor(geo: LifeGeometry, perMeter: number) {
    this.cell = 16 * perMeter;
    this.identified = !!geo.lineIds?.some((id) => id !== 0);
    for (let line = 0; line < geo.kinds.length; line++) {
      for (let v = geo.starts[line]!; v + 1 < geo.starts[line + 1]!; v++) {
        const ax = geo.coords[v * 2]!,
          ay = geo.coords[v * 2 + 1]!;
        const dx = geo.coords[v * 2 + 2]! - ax,
          dy = geo.coords[v * 2 + 3]! - ay;
        const length = Math.hypot(dx, dy);
        if (!length) continue;
        const segment = { line, v, ax, ay, dx, dy, length };
        const cuts = [0, 1];
        for (const [a, delta] of [
          [ax, dx],
          [ay, dy],
        ]) {
          if (!delta) continue;
          const lo = Math.min(a!, a! + delta),
            hi = Math.max(a!, a! + delta);
          for (let edge = Math.floor(lo / this.cell) + 1; edge * this.cell < hi; edge++)
            cuts.push((edge * this.cell - a!) / delta);
        }
        cuts.sort((a, b) => a - b);
        const keys = new Map<number, Set<number>>();
        const put = (t: number) => {
          const row = Math.floor((ay + t * dy) / this.cell);
          const col = Math.floor((ax + t * dx) / this.cell);
          let cols = keys.get(row);
          if (!cols) keys.set(row, (cols = new Set()));
          cols.add(col);
        };
        put(0);
        put(1);
        for (let i = 1; i < cuts.length; i++) put((cuts[i - 1]! + cuts[i]!) / 2);
        for (const [row, cols] of keys) {
          let bins = this.bins.get(row);
          if (!bins) this.bins.set(row, (bins = new Map<number, Segment[]>()));
          for (const col of cols) {
            const bin = bins.get(col);
            if (bin) bin.push(segment);
            else bins.set(col, [segment]);
          }
        }
      }
    }
  }

  near(x: number, y: number, reach: number): readonly Segment[] {
    const found = new Set<Segment>();
    for (
      let row = Math.floor((y - reach) / this.cell);
      row <= Math.floor((y + reach) / this.cell);
      row++
    )
      for (
        let col = Math.floor((x - reach) / this.cell);
        col <= Math.floor((x + reach) / this.cell);
        col++
      )
        for (const segment of this.bins.get(row)?.get(col) ?? []) found.add(segment);
    // Legacy closest-segment ties are resolved by original geometry order.
    return [...found].sort((a, b) => a.line - b.line || a.v - b.v);
  }
}

/** No mutation or random draws: source and preview may coexist until an admission commits. */
export function projectMover(
  target: TileLife,
  source: TileLife,
  m: Mover,
  grid: SegmentGrid,
  options: AdoptionOptions = {},
): Mover | undefined {
  if (m.kind !== 'vehicle' && m.kind !== 'boat' && m.kind !== 'train' && m.kind !== 'person')
    return;
  const frame = frameBetween(source.tile, target.tile);
  const nudge = (options.nudgeM ?? 0) * source.perMeter;
  const x = frame.x + (m.x + m.hx * nudge) * frame.scale,
    y = frame.y + (m.y + m.hy * nudge) * frame.scale;
  const oldPose = source.pose(m);
  const oldX = frame.x + oldPose.x * frame.scale,
    oldY = frame.y + oldPose.y * frame.scale;
  const reach =
    Math.min(options.snapM ?? ADOPT.snap, m.kind === 'person' ? 2 : Infinity) * target.perMeter;
  const bearing = Math.cos(((options.bearingDeg ?? ADOPT.bearing) * Math.PI) / 180);
  const id = source.geo.lineIds?.[m.line];
  let best: { segment: Segment; t: number; dir: 1 | -1; distance: number } | undefined;
  let rejection: ContinuityRejection = 'geometry';
  for (const segment of grid.near(x, y, reach)) {
    const { line, ax, ay, dx, dy, length } = segment;
    const kind = target.geo.kinds[line]! as LifeLine;
    if (!usableLines[m.kind].includes(kind)) continue;
    if (id && grid.identified && target.geo.lineIds?.[line] !== id) continue;
    if (m.kind === 'boat' && kind === LifeLine.canal && m.vehicle === 'motorboat') {
      rejection = 'directionCraft';
      continue;
    }
    const width = target.geo.widths[line];
    if (m.kind === 'vehicle' && m.vehicle && width && VEHICLES[m.vehicle].width > width) {
      rejection = 'directionCraft';
      continue;
    }
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / length ** 2));
    const distance = Math.hypot(ax + dx * t - x, ay + dy * t - y);
    if (distance > reach || (best && distance >= best.distance)) continue;
    const dir: 1 | -1 = m.hx * dx + m.hy * dy >= 0 ? 1 : -1;
    if (m.kind === 'vehicle' && target.geo.oneway?.[line] && target.geo.oneway[line] !== dir) {
      rejection = 'directionCraft';
      continue;
    }
    if (!m.train && ((oldPose.hx * dx + oldPose.hy * dy) * dir) / length < bearing) {
      rejection = 'pose';
      continue;
    }
    best = { segment, t, dir, distance };
  }
  if (!best) {
    options.reject?.(rejection);
    return;
  }
  const { segment: s, t, dir } = best;
  const scale = target.perMeter / source.perMeter;
  // A stable preview shape avoids spread/override transitions for the 600-agent batch.
  // A preview shares immutable group members; ownership commits retain the original array.
  const preview: Mover = {
    kind: m.kind,
    line: s.line,
    from: dir === 1 ? s.v : s.v + 1,
    dir,
    d: (dir === 1 ? t : 1 - t) * s.length,
    x: s.ax + t * s.dx,
    y: s.ay + t * s.dy,
    hx: (s.dx * dir) / s.length,
    hy: (s.dy * dir) / s.length,
    speed: m.speed * scale,
    v: m.v === undefined ? undefined : m.v * scale,
    vehicle: m.vehicle,
    paint: m.paint,
    lane: m.lane,
    roadShift: m.roadShift,
    pause: m.pause,
    rank: m.rank,
    group: m.group,
    walked: m.walked,
    avoid: m.avoid,
    waiting: m.waiting,
  };
  if (m.routing) {
    preview.routing = {
      seed: m.routing.seed,
      turns: m.routing.turns,
      signal: m.routing.signal,
      indicating: false,
    };
  }
  if (m.train)
    preview.train = {
      ...m.train,
      trail: m.train.trail.map((value, i) => (i % 2 ? frame.y : frame.x) + value * frame.scale),
      stopX: frame.x + m.train.stopX * frame.scale,
      stopY: frame.y + m.train.stopY * frame.scale,
      edge: false,
    };
  const pose = target.pose(preview);
  if (
    !m.train &&
    (Math.hypot(pose.x - oldX, pose.y - oldY) > reach ||
      pose.hx * oldPose.hx + pose.hy * oldPose.hy < bearing)
  ) {
    options.reject?.('pose');
    return;
  }
  if (m.kind === 'person') {
    const before = source.groundBodies(m),
      after = target.groundBodies(preview);
    const ratio = (frame.scale * source.perMeter) / target.perMeter;
    if (
      before.length !== after.length ||
      after.some((b, i) => {
        const a = before[i]!;
        return (
          Math.hypot(
            b.x - frame.x / target.perMeter - a.x * ratio,
            b.y - frame.y / target.perMeter - a.y * ratio,
          ) > 2 || b.hx * a.hx + b.hy * a.hy < bearing
        );
      })
    ) {
      options.reject?.('pose');
      return;
    }
  }
  return preview;
}

/** Stable nearest replacement: candidates are grouped once for a destination transaction. */
export function nearestReplacement<T>(
  candidates: ReadonlySet<T>,
  point: { x: number; y: number },
  position: (item: T) => { x: number; y: number },
) {
  let selected: T | undefined,
    nearest = Infinity;
  for (const item of candidates) {
    const p = position(item);
    const distance = (p.x - point.x) ** 2 + (p.y - point.y) ** 2;
    if (distance < nearest) {
      nearest = distance;
      selected = item;
    }
  }
  return selected;
}

export function walkingBefore(
  target: TileLife,
  source: TileLife,
  mover: Mover,
  preview: Mover,
): Mover {
  const f = frameBetween(source.tile, target.tile);
  return {
    ...preview,
    x: f.x + mover.x * f.scale,
    y: f.y + mover.y * f.scale,
    hx: mover.hx,
    hy: mover.hy,
  };
}
export function walkingTransfer(target: TileLife, source: TileLife, mover: Mover, preview: Mover) {
  const f = frameBetween(source.tile, target.tile),
    ratio = (f.scale * source.perMeter) / target.perMeter;
  const before = source.groundBodies(mover),
    after = target.groundBodies(preview);
  return after.every((b, i) => {
    const a = before[i]!;
    return target.scenes.walkable(
      { x: f.x + a.x * ratio * target.perMeter, y: f.y + a.y * ratio * target.perMeter },
      { x: b.x * target.perMeter, y: b.y * target.perMeter },
    );
  });
}
