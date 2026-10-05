import { ADOPT, usableLines } from './config';
import { LifeLine, type LifeGeometry } from './geometry';
import { frameBetween } from './frames';
import { VEHICLES } from './vehicles';
import type { Mover, TileLife } from './simulate';
import type { ContinuityRejection } from './diagnostics';
import { EXTENT } from '../raster/geometry';
import { copyVehicleEffects } from './vehicle-effects';

export type AdoptionOptions = {
  snapM?: number;
  bearingDeg?: number;
  replace?: Mover;
  reject?: (reason: ContinuityRejection) => void;
  nudgeM?: number;
  /** Geographic seam transfers must project onto an owned portion of a buffered line. */
  insideTile?: boolean;
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
    let lo = 0,
      hi = 1;
    if (options.insideTile) {
      // Tile vertices are independently quantized. The closest buffered point can
      // lie just outside even after the source cursor crosses the edge.
      const inset = 0.001 * target.perMeter;
      for (const [a, delta] of [
        [ax, dx],
        [ay, dy],
      ]) {
        if (!delta) {
          if (a! < inset || a! > EXTENT - inset) lo = 2;
        } else {
          const first = (inset - a!) / delta,
            last = (EXTENT - inset - a!) / delta;
          lo = Math.max(lo, Math.min(first, last));
          hi = Math.min(hi, Math.max(first, last));
        }
      }
      if (lo > hi) continue;
    }
    const t = Math.max(lo, Math.min(hi, ((x - ax) * dx + (y - ay) * dy) / length ** 2));
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
  if (m.roadShift !== undefined) preview.roadShift = m.roadShift;
  if (m.roadSteering !== undefined) preview.roadSteering = m.roadSteering;
  if (m.curveLengthM !== undefined) preview.curveLengthM = m.curveLengthM;
  if (m.curveCorner) {
    const x = frame.x + m.curveCorner.x * frame.scale;
    const y = frame.y + m.curveCorner.y * frame.scale;
    for (let v = target.geo.starts[s.line]!; v < target.geo.starts[s.line + 1]!; v++) {
      const point = { x: target.geo.coords[v * 2]!, y: target.geo.coords[v * 2 + 1]! };
      if (Math.hypot(point.x - x, point.y - y) <= 2) {
        preview.curveCorner = point;
        break;
      }
    }
    if (!preview.curveCorner) delete preview.curveLengthM;
  }
  if (m.junctionRoute) {
    const exits: number[] = [];
    let shared = m.dir === 1 ? source.geo.starts[m.line + 1]! - 1 : source.geo.starts[m.line]!;
    for (const code of m.junctionRoute.exits) {
      const old = source.directedExit(code, shared),
        id = source.geo.lineIds?.[old.line];
      if (!id) break;
      const x = frame.x + source.geo.coords[old.vertex * 2]! * frame.scale;
      const y = frame.y + source.geo.coords[old.vertex * 2 + 1]! * frame.scale;
      const hx =
        source.geo.coords[(old.vertex + old.dir) * 2]! - source.geo.coords[old.vertex * 2]!;
      const hy =
        source.geo.coords[(old.vertex + old.dir) * 2 + 1]! - source.geo.coords[old.vertex * 2 + 1]!;
      let mapped: number | undefined;
      for (let line = 0; line < target.geo.kinds.length && mapped === undefined; line++) {
        if (target.geo.lineIds?.[line] !== id) continue;
        for (
          let v = target.geo.starts[line]!;
          v < target.geo.starts[line + 1]! && mapped === undefined;
          v++
        ) {
          if (Math.hypot(target.geo.coords[v * 2]! - x, target.geo.coords[v * 2 + 1]! - y) > 2)
            continue;
          for (const direction of [1, -1] as const) {
            const next = v + direction;
            if (
              next < target.geo.starts[line]! ||
              next >= target.geo.starts[line + 1]! ||
              (target.geo.oneway?.[line] && target.geo.oneway[line] !== direction)
            )
              continue;
            const dx = target.geo.coords[next * 2]! - target.geo.coords[v * 2]!;
            const dy = target.geo.coords[next * 2 + 1]! - target.geo.coords[v * 2 + 1]!;
            if (hx * dx + hy * dy > 0) {
              mapped = line * 2 + (direction === 1 ? 0 : 1);
              break;
            }
          }
        }
      }
      if (mapped === undefined) break;
      exits.push(mapped);
      shared = old.dir === 1 ? source.geo.starts[old.line + 1]! - 1 : source.geo.starts[old.line]!;
    }
    if (exits.length === m.junctionRoute.exits.length)
      preview.junctionRoute = { key: m.junctionRoute.key, exits };
  }
  if (m.entered) {
    const x = frame.x + source.geo.coords[m.entered.vertex * 2]! * frame.scale;
    const y = frame.y + source.geo.coords[m.entered.vertex * 2 + 1]! * frame.scale;
    for (let v = target.geo.starts[s.line]!; v < target.geo.starts[s.line + 1]!; v++) {
      if (Math.hypot(target.geo.coords[v * 2]! - x, target.geo.coords[v * 2 + 1]! - y) > 2)
        continue;
      preview.entered = {
        vertex: v,
        x: frame.x + m.entered.x * frame.scale,
        y: frame.y + m.entered.y * frame.scale,
        offset: m.entered.offset,
      };
      break;
    }
  }
  if (m.routing) {
    preview.routing = {
      seed: m.routing.seed,
      turns: m.routing.turns,
      signal: m.routing.signal,
      indicating: false,
    };
    const plan = m.routing.plan;
    const exitId = plan && source.geo.lineIds?.[plan.exit >> 1];
    if (plan && exitId && plan.line === m.line && plan.dir === m.dir) {
      const vertex = dir === 1 ? target.geo.starts[s.line + 1]! - 1 : target.geo.starts[s.line]!;
      const px = frame.x + source.geo.coords[plan.vertex * 2]! * frame.scale;
      const py = frame.y + source.geo.coords[plan.vertex * 2 + 1]! * frame.scale;
      if (
        Math.hypot(target.geo.coords[vertex * 2]! - px, target.geo.coords[vertex * 2 + 1]! - py) <=
        2
      ) {
        const oldLine = plan.exit >> 1,
          oldDir = plan.exit & 1 ? -1 : 1;
        const oldVertex =
          plan.target?.vertex ??
          (oldDir === 1 ? source.geo.starts[oldLine]! : source.geo.starts[oldLine + 1]! - 1);
        const hx = source.geo.coords[(oldVertex + oldDir) * 2]! - source.geo.coords[oldVertex * 2]!;
        const hy =
          source.geo.coords[(oldVertex + oldDir) * 2 + 1]! - source.geo.coords[oldVertex * 2 + 1]!;
        for (let line = 0; line < target.geo.kinds.length; line++) {
          if (target.geo.lineIds?.[line] !== exitId) continue;
          for (const direction of [1, -1] as const) {
            const ref = target.directedExit(line * 2 + (direction === 1 ? 0 : 1), vertex);
            const to = ref.vertex + direction;
            if (to < target.geo.starts[line]! || to >= target.geo.starts[line + 1]!) continue;
            if (
              target.geo.coords[ref.vertex * 2] !== target.geo.coords[vertex * 2] ||
              target.geo.coords[ref.vertex * 2 + 1] !== target.geo.coords[vertex * 2 + 1]
            )
              continue;
            const dx = target.geo.coords[to * 2]! - target.geo.coords[ref.vertex * 2]!;
            const dy = target.geo.coords[to * 2 + 1]! - target.geo.coords[ref.vertex * 2 + 1]!;
            if (
              dx * hx + dy * hy <= 0 ||
              (target.geo.oneway?.[line] && target.geo.oneway[line] !== direction)
            )
              continue;
            preview.routing = {
              ...preview.routing,
              indicating: m.routing.indicating,
              plan: {
                ...plan,
                line: s.line,
                dir,
                vertex,
                exit: line * 2 + (direction === 1 ? 0 : 1),
                target: ref,
              },
            };
            break;
          }
        }
      }
    }
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
  copyVehicleEffects(m, preview);
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
