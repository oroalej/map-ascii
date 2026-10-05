import type { Arm, Junction, Movement } from './junctions';
import type { TileLife } from './simulate';
import { frameBetween } from './frames';
import { transformCrossing, type PedestrianCrossing, type PedestrianView } from './pedestrians';

const COS30 = Math.cos(Math.PI / 6),
  NO_CROSSINGS: readonly PedestrianCrossing[] = [];
/** Uses prepared road associations, without a second crossing spatial index. */
export class JunctionCrossings {
  private sources: TileLife[] = [];
  private crossings: PedestrianCrossing[] = [];
  private associations = new WeakMap<Junction, Map<Arm, PedestrianCrossing[]>>();
  constructor(private readonly life: TileLife) {}
  prepare(sources: readonly TileLife[]) {
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
        if (!distance || distance > j.radius / pm + 30) continue;
        const dot = (dx * arm.hx + dy * arm.hy) / distance;
        if (
          dot < COS30 ||
          Math.abs(arm.hx * c.body.hx + arm.hy * c.body.hy) < COS30 ||
          Math.abs(dx * arm.hy - dy * arm.hx) > (this.life.geo.widths[arm.line] || 12) / 2 + 2
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
      const half =
        (Math.abs(c.body.hx * p.inHx + c.body.hy * p.inHy) * c.body.length +
          Math.abs(c.body.hy * p.inHx - c.body.hx * p.inHy) * c.body.width) /
        2;
      extra = Math.max(extra, outward + half - p.junction.radius / pm);
    }
    p.ahead = p.boxAhead - extra * pm;
  }
}
