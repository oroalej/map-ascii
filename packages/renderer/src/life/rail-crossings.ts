/**
 * Level crossings (SPEC.md §4): where a running rail line meets a road, found from the tile's own
 * geometry, since crossings aren't tagged in the data. Road traffic holds at a stop on each side
 * while a train is near (`train-motion.ts` `crossingStates` says when).
 */
import { TILE_EXTENT as EXTENT, type TileAddress, type ZoomBand } from '@atlas/shared';
import { tileToLngLat } from '../raster/geometry';
import { CellBit, lifeClassFor } from './config';
import { LifeLine, type LifeGeometry } from './geometry';
import { kinematicsOf } from './config';
import { approach, type MotionLimit } from './motion';
import { Paint, VEHICLES } from './vehicles';
import type { Mover, VisibleAgent } from './simulate';
import type { LifeDiagnostics } from './diagnostics';

export const RAIL_CROSSING = {
  /** A road and a track this close at a vertex share a crossing, m. */
  vertexReach: 1.5,
  /** Hits this close on the same road are one crossing, m (a road split at the rail). */
  merge: 3,
  /** A vehicle's nose waits this far before the rail, m. */
  stopBack: 6,
  /** How far ahead a vehicle starts to brake for a closed crossing, m. */
  lookahead: 60,
  /** A train this many seconds off closes the crossing. */
  warnSeconds: 12,
  /** Closer than this a stop is firm; earlier, whoever can't stop in time goes on (amber). */
  firmSeconds: 6,
  /** Any part of a train this near keeps the crossing closed, m. */
  bodyReach: 6,
  /** A train's path this near a crossing runs over it, m. */
  pathReach: 3,
  /** The barriers show from here, and swap colors this often, s. */
  barrierZoom: { min: 17 } as ZoomBand,
  blinkSeconds: 0.5,
  /** How far a barrier sits on from the waiting nose toward the rail, and past the road's edge, m. */
  barrierAhead: 1.5,
  barrierOverhang: 0.5,
} as const;

/** One road's stop on one side of the rail, in the line's own `along` units. */
export type CrossingStop = {
  line: number;
  along: number;
  dir: 1 | -1;
  /** The road's center and heading at the stop, in tile units. */
  x: number;
  y: number;
  hx: number;
  hy: number;
  /** The road's width, m. */
  width: number;
  crossing: RailCrossing;
};

export type RailCrossing = {
  x: number;
  y: number;
  /** Whether this tile's half-open extent holds it, so one tile draws what neighbours share. */
  owned: boolean;
  closed: boolean;
  /** Closed, and past the moment anyone may still run it. */
  firm: boolean;
  stops: CrossingStop[];
};

const ROAD_KINDS: ReadonlySet<number> = new Set([
  LifeLine.roadMajor,
  LifeLine.roadMid,
  LifeLine.roadMinor,
]);

type Hit = { x: number; y: number; line: number; at: number };

/** Where road `a`–`b` properly crosses rail `c`–`d`: its share along the road, if it does. */
function properCrossing(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): number | undefined {
  const rx = bx - ax,
    ry = by - ay,
    sx = dx - cx,
    sy = dy - cy;
  const denominator = rx * sy - ry * sx;
  if (Math.abs(denominator) < 1e-9) return undefined;
  const t = ((cx - ax) * sy - (cy - ay) * sx) / denominator;
  const u = ((cx - ax) * ry - (cy - ay) * rx) / denominator;
  return t > 0 && t < 1 && u > 0 && u < 1 ? t : undefined;
}

export class RailCrossings {
  readonly crossings: RailCrossing[] = [];
  private readonly stops = new Map<number, CrossingStop[]>();

  constructor(
    private readonly geo: LifeGeometry,
    private readonly perMeter: number,
    private readonly along: Float64Array,
    deferred = false,
  ) {
    if (!deferred) {
      const steps = this.prepare();
      while (!steps.next().done);
    }
  }

  *prepare(): Generator<void, void, void> {
    const { geo, perMeter } = this;
    const rails: number[] = [];
    for (let line = 0; line < geo.kinds.length; line++)
      if (geo.kinds[line] === LifeLine.rail && !geo.navigationOnly?.[line]) rails.push(line);
    if (!rails.length) return;
    const hits: Hit[] = [];
    const reach = RAIL_CROSSING.vertexReach * perMeter;
    const { coords, starts } = geo;
    const box = (line: number) => {
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      for (let v = starts[line]!; v < starts[line + 1]!; v++) {
        minX = Math.min(minX, coords[v * 2]!);
        maxX = Math.max(maxX, coords[v * 2]!);
        minY = Math.min(minY, coords[v * 2 + 1]!);
        maxY = Math.max(maxY, coords[v * 2 + 1]!);
      }
      return { minX, minY, maxX, maxY };
    };
    const railBoxes = rails.map(box);
    for (let road = 0; road < geo.kinds.length; road++) {
      if (!ROAD_KINDS.has(geo.kinds[road]!) || geo.navigationOnly?.[road]) continue;
      yield;
      const roadBox = box(road);
      for (let r = 0; r < rails.length; r++) {
        const railBox = railBoxes[r]!;
        if (
          roadBox.maxX + reach < railBox.minX ||
          railBox.maxX + reach < roadBox.minX ||
          roadBox.maxY + reach < railBox.minY ||
          railBox.maxY + reach < roadBox.minY
        )
          continue;
        const rail = rails[r]!;
        for (let v = starts[road]!; v < starts[road + 1]!; v++) {
          const x = coords[v * 2]!,
            y = coords[v * 2 + 1]!;
          const hasNext = v + 1 < starts[road + 1]!;
          for (let w = starts[rail]!; w < starts[rail + 1]!; w++) {
            const cx = coords[w * 2]!,
              cy = coords[w * 2 + 1]!;
            if (Math.hypot(x - cx, y - cy) <= reach)
              hits.push({ x: cx, y: cy, line: road, at: this.along[v]! });
            if (!hasNext || w + 1 >= starts[rail + 1]!) continue;
            const nx = coords[v * 2 + 2]!,
              ny = coords[v * 2 + 3]!;
            const t = properCrossing(x, y, nx, ny, cx, cy, coords[w * 2 + 2]!, coords[w * 2 + 3]!);
            if (t !== undefined)
              hits.push({
                x: x + (nx - x) * t,
                y: y + (ny - y) * t,
                line: road,
                at: this.along[v]! + Math.hypot(nx - x, ny - y) * t,
              });
          }
        }
      }
    }
    const merge = RAIL_CROSSING.merge * perMeter;
    const seen = new Map<RailCrossing, Hit[]>();
    for (const hit of hits) {
      let crossing = this.crossings.find((c) => Math.hypot(c.x - hit.x, c.y - hit.y) <= merge);
      if (!crossing) {
        crossing = {
          x: hit.x,
          y: hit.y,
          owned: hit.x >= 0 && hit.y >= 0 && hit.x < EXTENT && hit.y < EXTENT,
          closed: false,
          firm: false,
          stops: [],
        };
        this.crossings.push(crossing);
        seen.set(crossing, []);
      }
      const earlier = seen.get(crossing)!;
      // The same road meets the rail once here, however many vertices the hit touched.
      if (earlier.some((h) => h.line === hit.line && Math.abs(h.at - hit.at) <= merge)) continue;
      earlier.push(hit);
      this.addStop(crossing, hit, 1);
      this.addStop(crossing, hit, -1);
    }
  }

  /** The stop on `dir`'s approach: skipped if the road starts at the rail on that side. */
  private addStop(crossing: RailCrossing, hit: Hit, dir: 1 | -1) {
    const { geo, along, perMeter } = this;
    const first = geo.starts[hit.line]!;
    const last = geo.starts[hit.line + 1]! - 1;
    const length = along[last]!;
    const room = dir === 1 ? hit.at : length - hit.at;
    if (room <= 0.01 * perMeter) return;
    // A short road reaches the rail from a junction: its stop is that road's own start.
    const at = hit.at - dir * Math.min(RAIL_CROSSING.stopBack * perMeter, room);
    let v = first;
    while (v + 1 < last && along[v + 1]! < at) v++;
    const x0 = geo.coords[v * 2]!,
      y0 = geo.coords[v * 2 + 1]!;
    const dx = geo.coords[v * 2 + 2]! - x0,
      dy = geo.coords[v * 2 + 3]! - y0;
    const segment = Math.hypot(dx, dy) || 1;
    const t = (at - along[v]!) / segment;
    const stop: CrossingStop = {
      line: hit.line,
      along: at,
      dir,
      x: x0 + dx * t,
      y: y0 + dy * t,
      hx: (dx / segment) * dir,
      hy: (dy / segment) * dir,
      width: geo.widths[hit.line] ?? 0,
      crossing,
    };
    crossing.stops.push(stop);
    const list = this.stops.get(hit.line);
    if (list) list.push(stop);
    else this.stops.set(hit.line, [stop]);
  }

  /**
   * Brake for a closed crossing ahead. A vehicle past its stop keeps going, and while a closure
   * is new, so does one that can't stop in time. Returns whether it stands held at a stop.
   */
  vehicleLimit(m: Mover, dt: number, out: MotionLimit, diagnostics?: LifeDiagnostics): boolean {
    const stops = this.stops.get(m.line);
    if (!stops) return false;
    const { perMeter } = this;
    let held = false;
    const progress = this.along[m.from]! + m.dir * m.d;
    const half = (m.vehicle ? VEHICLES[m.vehicle].length / 2 : 2) * perMeter;
    for (const stop of stops) {
      if (stop.dir !== m.dir || !stop.crossing.closed) continue;
      const ahead = m.dir * (stop.along - progress) - half;
      if (ahead < -0.5 * perMeter || ahead >= RAIL_CROSSING.lookahead * perMeter) continue;
      const brake = kinematicsOf(m.vehicle).brake * perMeter;
      const v = m.v ?? m.speed;
      if (!stop.crossing.firm && (v * v) / (2 * brake) > ahead) continue;
      if (ahead <= 0.5 * perMeter) {
        held = true;
        diagnostics?.hold(m, 'rail');
      }
      out.target = Math.min(out.target, approach(ahead, 0, brake));
      out.cap = Math.min(out.cap, Math.max(0, ahead) / dt);
    }
    return held;
  }

  /** Room to the next stop on `m`'s way, in tile units, closed or not. */
  protectedRoom(m: Mover): number {
    const stops = this.stops.get(m.line);
    if (!stops) return Infinity;
    let room = Infinity;
    const progress = this.along[m.from]! + m.dir * m.d;
    const half = (m.vehicle ? VEHICLES[m.vehicle].length / 2 : 2) * this.perMeter;
    for (const stop of stops) {
      if (stop.dir !== m.dir) continue;
      const ahead = m.dir * (stop.along - progress) - half;
      if (ahead >= -0.5 * this.perMeter) room = Math.min(room, Math.max(0, ahead));
    }
    return room;
  }
}

export const BARRIER_LABEL = 'Level crossing barrier (simulated)';

/**
 * A barrier across the road at each stop of every closed crossing this tile owns, blinking red and
 * white. It's kind `boat` as a procession's ropes are, because a ground agent would be denied its
 * cells by the very queue it holds.
 */
export function crossingBarriers(
  crossings: readonly RailCrossing[],
  tile: TileAddress,
  perMeter: number,
  clock: number,
  shows: (p: { x: number; y: number }) => boolean,
  out: VisibleAgent[],
  maxAgents: number,
) {
  const lit = Math.floor(clock / RAIL_CROSSING.blinkSeconds) % 2 === 0;
  const paints = lit ? [Paint.red, Paint.white] : [Paint.white, Paint.red];
  for (const crossing of crossings) {
    if (!crossing.closed || !crossing.owned || !shows(crossing)) continue;
    for (const stop of crossing.stops) {
      if (out.length >= maxAgents) return;
      const half = (stop.width / 2 + RAIL_CROSSING.barrierOverhang) * perMeter;
      const ahead = RAIL_CROSSING.barrierAhead * perMeter;
      const x = stop.x + stop.hx * ahead,
        y = stop.y + stop.hy * ahead;
      const a = tileToLngLat(tile, { x: x - stop.hy * half, y: y + stop.hx * half });
      const b = tileToLngLat(tile, { x: x + stop.hy * half, y: y - stop.hx * half });
      out.push({
        kind: 'boat',
        lng: (a[0] + b[0]) / 2,
        lat: (a[1] + b[1]) / 2,
        flap: 0,
        line: {
          points: [a, b],
          paints,
          layer: { cls: lifeClassFor.vehicle, bit: CellBit.vehicle },
          short: true,
        },
        fieldLabel: BARRIER_LABEL,
      });
    }
  }
}
