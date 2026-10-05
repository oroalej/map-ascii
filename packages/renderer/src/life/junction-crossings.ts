import type { Arm, Junction, JunctionTable, Movement } from './junctions';
import type { TileLife } from './simulate';
import { frameBetween } from './frames';
import { EXTENT } from '../raster/geometry';
import { COS30, DEFAULT_ROAD_WIDTH_M, JUNCTION, PEDESTRIAN } from './config';
import { reach } from './occupancy';
import { transformCrossing, type PedestrianCrossing, type PedestrianView } from './pedestrians';

const NO_CROSSINGS: readonly PedestrianCrossing[] = [];
type Bounds = { x0: number; y0: number; x1: number; y1: number };
/** Uses prepared road associations, without a second crossing spatial index. */
export class JunctionCrossings {
  private sources: TileLife[] = [];
  private crossings: PedestrianCrossing[] = [];
  private associations = new WeakMap<Junction, Map<Arm, PedestrianCrossing[]>>();
  private revision?: number;
  private sourceBounds?: Bounds;
  constructor(private readonly life: TileLife) {}
  /** Geometry-change broad phase only; buffered geometry may extend beyond its owner's footprint. */
  private extent(): Bounds {
    if (this.sourceBounds) return this.sourceBounds;
    const bounds = {
      x0: 0,
      y0: 0,
      x1: EXTENT / this.life.perMeter,
      y1: EXTENT / this.life.perMeter,
    };
    for (const lines of [
      this.life.pedestrianCrossings.uncontrolledAssociations,
      this.life.pedestrianCrossings.controlledAssociations,
    ])
      for (const list of lines.values())
        for (const c of list) {
          const x = reach(c.body, 1, 0),
            y = reach(c.body, 0, 1);
          bounds.x0 = Math.min(bounds.x0, c.body.x - x);
          bounds.y0 = Math.min(bounds.y0, c.body.y - y);
          bounds.x1 = Math.max(bounds.x1, c.body.x + x);
          bounds.y1 = Math.max(bounds.y1, c.body.y + y);
        }
    return (this.sourceBounds = bounds);
  }
  bounds(table: JunctionTable): Bounds {
    const pm = this.life.perMeter,
      bounds = {
        x0: -JUNCTION.crossingReach,
        y0: -JUNCTION.crossingReach,
        x1: EXTENT / pm + JUNCTION.crossingReach,
        y1: EXTENT / pm + JUNCTION.crossingReach,
      };
    const include = (j: Junction) => {
      const reach = j.radius / pm + JUNCTION.crossingReach;
      for (const arm of j.arms) {
        const x = (arm.x ?? j.x) / pm,
          y = (arm.y ?? j.y) / pm;
        bounds.x0 = Math.min(bounds.x0, x - reach);
        bounds.y0 = Math.min(bounds.y0, y - reach);
        bounds.x1 = Math.max(bounds.x1, x + reach);
        bounds.y1 = Math.max(bounds.y1, y + reach);
      }
    };
    for (const j of this.life.junctionIndex.junctions) include(j);
    for (const m of this.life.movers) for (const r of table.holds(m)) include(r.movement.junction);
    return bounds;
  }
  relevant(source: TileLife, bounds: Bounds): boolean {
    const f = frameBetween(source.tile, this.life.tile),
      other = source.junctionCrossings.extent(),
      scale = (source.perMeter * f.scale) / this.life.perMeter,
      x = f.x / this.life.perMeter,
      y = f.y / this.life.perMeter;
    return (
      x + other.x1 * scale >= bounds.x0 &&
      x + other.x0 * scale <= bounds.x1 &&
      y + other.y1 * scale >= bounds.y0 &&
      y + other.y0 * scale <= bounds.y1
    );
  }
  prepare(sources: readonly TileLife[], revision?: number) {
    if (revision !== undefined && revision === this.revision) return;
    this.revision = revision;
    if (sources.length === this.sources.length && sources.every((s, i) => s === this.sources[i]))
      return;
    this.sources = [...sources];
    this.associations = new WeakMap();
    const unique = new Map<string, PedestrianCrossing>();
    for (const source of sources) {
      const f = frameBetween(source.tile, this.life.tile),
        frame = {
          x: f.x / this.life.perMeter,
          y: f.y / this.life.perMeter,
          scale: (source.perMeter * f.scale) / this.life.perMeter,
        };
      for (const lines of [
        source.pedestrianCrossings.uncontrolledAssociations,
        source.pedestrianCrossings.controlledAssociations,
      ])
        for (const list of lines.values())
          for (const c of list) {
            if (unique.has(c.identity.key)) continue;
            unique.set(c.identity.key, transformCrossing(c, frame));
          }
    }
    this.crossings = [...unique.values()];
  }
  private arms(j: Junction) {
    let found = this.associations.get(j);
    if (found) return found;
    found = new Map();
    const pm = this.life.perMeter;
    for (const c of this.crossings) {
      let selected: Arm | undefined,
        score = COS30;
      for (const arm of j.arms) {
        const x = (arm.x ?? j.x) / pm,
          y = (arm.y ?? j.y) / pm,
          dx = c.body.x - x,
          dy = c.body.y - y,
          distance = Math.hypot(dx, dy);
        if (!distance) continue;
        const outward = dx * arm.hx + dy * arm.hy;
        // The stripe's near edge belongs beside the box's admission/curb area,
        // rather than an arbitrary centre-distance range along the entire road.
        if (
          outward - reach(c.body, arm.hx, arm.hy) >
          j.radius / pm + PEDESTRIAN.curbReach + JUNCTION.gap + 1e-9
        )
          continue;
        const dot = (dx * arm.hx + dy * arm.hy) / distance;
        if (
          dot < COS30 ||
          Math.abs(arm.hx * c.body.hx + arm.hy * c.body.hy) < COS30 ||
          Math.abs(dx * arm.hy - dy * arm.hx) >
            (this.life.geo.widths[arm.line] || DEFAULT_ROAD_WIDTH_M) / 2 + 2
        )
          continue;
        if (!selected || dot > score + 1e-9) {
          selected = arm;
          score = dot;
        }
      }
      if (!selected) continue;
      let list = found.get(selected);
      if (!list) found.set(selected, (list = []));
      list.push(c);
    }
    this.associations.set(j, found);
    return found;
  }
  forArm(j: Junction, arm: Arm | undefined): readonly PedestrianCrossing[] {
    if (!arm) return NO_CROSSINGS;
    const associated = j.arms.find(
      (a) =>
        a === arm ||
        ((a.x ?? j.x) === (arm.x ?? j.x) &&
          (a.y ?? j.y) === (arm.y ?? j.y) &&
          a.hx * arm.hx + a.hy * arm.hy > COS30),
    );
    return associated ? (this.arms(j).get(associated) ?? NO_CROSSINGS) : NO_CROSSINGS;
  }
  clear(p: Movement, view: PedestrianView, controlled: boolean): boolean {
    if (view.empty) return true;
    const blocked = (list: readonly PedestrianCrossing[]) =>
      list.some((c) => this.life.pedestrianCrossings.blocked(c, view));
    if (!controlled && blocked(this.forArm(p.junction, p.entry))) return false;
    const turning = p.inHx * p.outHx + p.inHy * p.outHy < COS30;
    return !(!controlled || turning) || !blocked(this.forArm(p.junction, p.exit));
  }
  /** A denied car must leave the entrance stripes usable by the people it is yielding to. */
  holdAhead(p: Movement, controlled: boolean): void {
    p.boxAhead ??= p.ahead;
    if (controlled || !p.entry) return;
    const pm = this.life.perMeter,
      x = (p.entry.x ?? p.junction.x) / pm,
      y = (p.entry.y ?? p.junction.y) / pm;
    let extra = 0;
    for (const c of this.forArm(p.junction, p.entry)) {
      const outward = -(c.body.x - x) * p.inHx - (c.body.y - y) * p.inHy;
      const half = reach(c.body, p.inHx, p.inHy);
      extra = Math.max(extra, outward + half - p.junction.radius / pm);
    }
    p.ahead = p.boxAhead - extra * pm;
  }
}
