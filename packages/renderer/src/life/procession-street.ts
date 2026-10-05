/** Deterministic street formations and connected arrival gatherings, independent of the camera. */
import {
  localMetricProjection,
  LEGACY_LOCAL_METERS_PER_DEGREE,
  type StreetRoute,
  type MassRoute,
} from '@atlas/shared';
import { PROCESSION, motionProfile, profileAt, type LngLatBounds } from './procession';
import { ProcessionGlyph } from './procession-glyphs';
import { eventGroundAllows, type EventGround } from './ground-events';
import { hashString, random } from './random';
import type { VisibleAgent } from './simulate';
import type { LifeInspection } from './inspection';
import { VEHICLES } from './vehicles';

type Point = [number, number];
type Actor = {
  id: string;
  back: number;
  off: number;
  paint: number;
  phase: number;
  candle: boolean;
  glyph?: string;
  vehicle?: 'truck' | 'car' | 'motorcycle';
  destination?: Point;
  approach?: Point[];
  adopted?: VisibleAgent;
};
export type EventSpan = { a: Point; b: Point; width: number };
export class GroundProcessionScene {
  readonly actors: Actor[] = [];
  readonly ground: EventGround;
  readonly frame: ReturnType<typeof localMetricProjection>;
  readonly points: Point[];
  readonly along: number[] = [0];
  readonly profile: Float64Array;
  private scope = '';
  private adopted: VisibleAgent[] = [];
  private massCells = new Map<string, Point>();
  private massParents = new Map<string, string | undefined>();
  private massPaths: Point[][] = [];
  constructor(readonly route: StreetRoute | MassRoute) {
    const origin = route.kind === 'mass' ? route.site.location : route.route[0]!;
    // Mass permissions were baked on this exact church-centred 2 m lattice.
    this.frame = localMetricProjection(
      origin,
      route.kind === 'mass'
        ? { east: LEGACY_LOCAL_METERS_PER_DEGREE, north: LEGACY_LOCAL_METERS_PER_DEGREE }
        : {},
    );
    this.points = route.kind === 'mass' ? [] : route.route.map(this.frame.to);
    for (let i = 1; i < this.points.length; i++)
      this.along.push(
        this.along.at(-1)! +
          Math.hypot(
            this.points[i]![0] - this.points[i - 1]![0],
            this.points[i]![1] - this.points[i - 1]![1],
          ),
      );
    this.profile = motionProfile(hashString(route.id), this.along.at(-1)!);
    this.ground = {
      regions: route.kind === 'mass' ? route.site.grounds : [],
      blocked: route.kind === 'mass' ? route.site.blocked : route.blocked,
    };
    if (route.kind !== 'mass')
      for (let i = 1; i < this.points.length; i++) {
        const a = this.points[i - 1]!,
          b = this.points[i]!,
          dx = b[0] - a[0],
          dy = b[1] - a[1],
          d = Math.hypot(dx, dy),
          reach = route.segments[i - 1]!.width_m / 2 + route.segments[i - 1]!.sidewalk_m;
        if (!d) continue;
        const nx = (-dy / d) * reach,
          ny = (dx / d) * reach;
        this.ground.regions.push(
          [
            [a[0] + nx, a[1] + ny],
            [b[0] + nx, b[1] + ny],
            [b[0] - nx, b[1] - ny],
            [a[0] - nx, a[1] - ny],
            [a[0] + nx, a[1] + ny],
          ].map((q) => this.frame.from(q as Point)),
        );
      }
    this.build();
  }
  get playDuration() {
    return Math.max(
      PROCESSION.playSeconds,
      (this.route.kind === 'mass' ? 0 : this.route.length_m) / PROCESSION.playSpeed,
    );
  }
  private build() {
    const rng = random(hashString(this.route.id));
    const add = (
      back: number,
      off: number,
      paint: number,
      glyph?: string,
      vehicle?: Actor['vehicle'],
    ) =>
      this.actors.push({
        id: `${this.route.id}/${this.actors.length}`,
        back,
        off,
        paint,
        phase: rng() * 6.28,
        candle: rng() < PROCESSION.candles,
        glyph,
        vehicle,
      });
    if (this.route.kind === 'mass') {
      const r = this.route;
      const key = (x: number, y: number) => `${x}/${y}`;
      const cells = new Map<string, Point>();
      for (const ring of r.site.grounds) {
        const permission = { regions: [ring], blocked: this.ground.blocked };
        const xy = ring.map(this.frame.to),
          xs = xy.map((q) => q[0]),
          ys = xy.map((q) => q[1]);
        for (let y = Math.ceil((Math.min(...ys) + 0.55) / 2); y * 2 < Math.max(...ys) - 0.55; y++)
          for (
            let x = Math.ceil((Math.min(...xs) + 0.55) / 2);
            x * 2 < Math.max(...xs) - 0.55;
            x++
          ) {
            const q: Point = [x * 2, y * 2];
            if (
              eventGroundAllows(
                permission,
                [
                  [q[0] - 0.55, q[1] - 0.55],
                  [q[0] + 0.55, q[1] + 0.55],
                ].map((q) => this.frame.from(q as Point)),
              )
            )
              cells.set(key(x, y), q);
          }
      }
      const anchor = this.frame.to(r.site.anchor),
        distance = (q: Point) => Math.hypot(q[0] - anchor[0], q[1] - anchor[1]);
      const root = [...cells.keys()].sort(
        (a, b) => distance(cells.get(a)!) - distance(cells.get(b)!),
      )[0];
      if (!root) return;
      const parents = new Map<string, string | undefined>([[root, undefined]]),
        queue = [root];
      for (let i = 0; i < queue.length; i++) {
        const [x, y] = queue[i]!.split('/').map(Number);
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const next = key(x! + dx!, y! + dy!);
          if (cells.has(next) && !parents.has(next)) {
            parents.set(next, queue[i]);
            queue.push(next);
          }
        }
      }
      this.massCells = cells;
      this.massParents = parents;
      // Closest church-facing destinations fill first; paths follow the connected outdoor grid.
      for (const id of queue.slice(0, PROCESSION.eventActors)) {
        add(0, 0, 3 + Math.floor(rng() * 5));
        const a = this.actors.at(-1)!,
          tail: Point[] = [];
        a.destination = this.frame.from(cells.get(id)!);
        for (let node: string | undefined = id; node !== undefined; node = parents.get(node))
          tail.push(cells.get(node)!);
        a.approach = [
          ...r.site.approaches[this.actors.length % r.site.approaches.length]!.map(this.frame.to),
          ...tail.reverse().slice(1),
        ];
        this.massPaths.push(a.approach);
      }
      return;
    }
    if (this.route.kind === 'procession') {
      const f = this.route.formation;
      add(0, 0, 4, ProcessionGlyph.andas);
      for (let i = 0; i < (f?.bearers ?? 8); i++)
        add(1 + Math.floor(i / 2) * 1.2, (i % 2 ? 1 : -1) * 1.6, 3);
      for (let i = 0; i < (f?.marshals ?? 4); i++)
        add(-8 - Math.floor(i / 2) * 3, (i % 2 ? 1 : -1) * 1.1, 6, ProcessionGlyph.flag);
      for (let r = 0; r < (f?.ranks ?? 12); r++)
        for (let c = 0; c < 4; c++) add(10 + r * 2, (c - 1.5) * 0.8, 3 + Math.floor(rng() * 5));
    } else {
      const f = this.route.formation;
      let back = 0;
      for (let i = 0; i < (f?.color_guard ?? 4); i++)
        add(back + Math.floor(i / 4) * 2, ((i % 4) - 1.5) * 0.8, 5, ProcessionGlyph.flag);
      back += 8;
      for (let i = 0; i < (f?.band ?? 12); i++)
        add(
          back + Math.floor(i / 4) * 2,
          ((i % 4) - 1.5) * 0.8,
          4,
          i % 2 ? ProcessionGlyph.bugle : ProcessionGlyph.drum,
        );
      back += Math.ceil((f?.band ?? 12) / 4) * 2 + 5;
      for (let k = 0; k < (f?.contingents ?? 3); k++) {
        for (let r = 0; r < (f?.ranks ?? 4); r++)
          for (let c = 0; c < 4; c++) add(back + r * 2, (c - 1.5) * 0.8, 3 + k);
        back += (f?.ranks ?? 4) * 2 + 6;
      }
      for (const vehicle of f?.vehicles ?? []) {
        add(back, 0, 5, undefined, vehicle);
        back += VEHICLES[vehicle].length + 6;
      }
    }
    // Both sidewalks; weight the start and arrival without independent random reseeding.
    const spacing = Math.max(5, this.route.length_m / PROCESSION.eventSpectators);
    for (
      let s = 0;
      s <= this.route.length_m && this.actors.length < PROCESSION.eventActors;
      s += spacing
    )
      for (const side of [-1, 1]) {
        const at = this.at(s),
          segment = this.route.segments[at.index]!;
        if (segment.sidewalk_m < 1) continue;
        add(
          -s,
          side * (segment.width_m / 2 + Math.min(segment.sidewalk_m / 2, 0.8)),
          3 + Math.floor(rng() * 5),
        );
        this.actors.at(-1)!.destination = this.frame.from([
          at.x - at.hy * this.actors.at(-1)!.off,
          at.y + at.hx * this.actors.at(-1)!.off,
        ]);
      }
  }
  adopt(actors: readonly VisibleAgent[]) {
    this.reset();
    if (this.route.kind !== 'mass') return;
    for (const actor of actors) {
      if (this.adopted.length >= this.actors.length) break;
      if (actor.kind !== 'person' || actor.prop || actor.vehicle || actor.aboard) continue;
      const q = this.frame.to([actor.lng, actor.lat]);
      const footprint = [
        [-0.55, -0.55],
        [-0.55, 0.55],
        [0.55, -0.55],
        [0.55, 0.55],
      ].map(([dx, dy]) => this.frame.from([q[0] + dx!, q[1] + dy!]));
      if (!eventGroundAllows(this.ground, footprint)) continue;
      const nearest = [...this.massParents.keys()].sort(
        (a, b) =>
          Math.hypot(this.massCells.get(a)![0] - q[0], this.massCells.get(a)![1] - q[1]) -
          Math.hypot(this.massCells.get(b)![0] - q[0], this.massCells.get(b)![1] - q[1]),
      )[0];
      if (
        !nearest ||
        Math.hypot(this.massCells.get(nearest)![0] - q[0], this.massCells.get(nearest)![1] - q[1]) >
          2
      )
        continue;
      const approach: Point[] = [q];
      for (
        let node: string | undefined = nearest;
        node !== undefined;
        node = this.massParents.get(node)
      )
        approach.push(this.massCells.get(node)!);
      const index = this.adopted.length,
        slot = this.actors[index]!,
        destination = this.frame.to(slot.destination!);
      const destKey = `${Math.round(destination[0] / 2)}/${Math.round(destination[1] / 2)}`,
        tail: Point[] = [];
      for (
        let node: string | undefined = destKey;
        node !== undefined;
        node = this.massParents.get(node)
      )
        tail.push(this.massCells.get(node)!);
      slot.approach = [...approach, ...tail.reverse().slice(1)];
      this.adopted.push(actor);
    }
  }
  reset() {
    this.scope = '';
    this.adopted = [];
    if (this.route.kind === 'mass') this.actors.forEach((a, i) => (a.approach = this.massPaths[i]));
  }
  private at(s: number) {
    s = Math.max(0, Math.min(this.along.at(-1)!, s));
    let i = 1;
    while (i < this.along.length - 1 && this.along[i]! < s) i++;
    const a = this.points[i - 1]!,
      b = this.points[i]!,
      d = this.along[i]! - this.along[i - 1]!,
      u = d ? (s - this.along[i - 1]!) / d : 0;
    return {
      x: a[0] + (b[0] - a[0]) * u,
      y: a[1] + (b[1] - a[1]) * u,
      hx: d ? (b[0] - a[0]) / d : 1,
      hy: d ? (b[1] - a[1]) / d : 0,
      index: i - 1,
    };
  }
  private head(progress: number) {
    return (
      (this.route.kind === 'parade' ? progress : profileAt(this.profile, progress)) *
        (this.along.at(-1)! + this.tail) -
      this.tail
    );
  }
  private get tail() {
    return Math.max(10, ...this.actors.filter((a) => !a.destination).map((a) => a.back)) + 10;
  }
  spans(progress: number): EventSpan[] {
    // Mass road overflow is reserved by its actual admitted bodies, not every nearby road.
    if (this.route.kind === 'mass') return [];
    const head = this.head(progress),
      from = Math.max(0, head - this.tail),
      to = Math.min(this.along.at(-1)!, head + 15);
    if (to < from) return [];
    return this.points.slice(1).flatMap((b, i) =>
      this.along[i + 1]! >= from && this.along[i]! <= to
        ? [
            {
              a: this.frame.from(this.points[i]!),
              b: this.frame.from(b),
              width: this.route.kind === 'mass' ? 0 : this.route.segments[i]!.width_m,
            },
          ]
        : [],
    );
  }
  agents(
    progress: number,
    time: number,
    options: {
      crowds?: boolean;
      bounds?: LngLatBounds;
      inspection?: LifeInspection;
      scope?: string;
      owner?: (id: string) => object;
    } = {},
  ): VisibleAgent[] {
    const out: VisibleAgent[] = [];
    const scope = options.scope ?? 'live/default';
    if (this.scope !== scope) {
      this.scope = scope;
    }
    for (let i = 0; i < this.actors.length; i++) {
      const a = this.actors[i]!;
      const adopted = this.adopted[i],
        id = adopted?.eventActor ?? `${scope}/${a.id}`;
      const owner = options.owner?.(id);
      const actorProgress =
        owner && options.inspection ? options.inspection.progress(owner, progress) : progress;
      const actorTime = owner && options.inspection ? options.inspection.clock(owner, time) : time;
      const head = this.route.kind === 'mass' ? 0 : this.head(actorProgress);
      if (a.destination && options.crowds === false) continue;
      let x: number, y: number, hx: number, hy: number;
      if (this.route.kind === 'mass') {
        const path = a.approach!;
        const t =
          actorProgress < 0.25
            ? actorProgress / 0.25
            : actorProgress > 0.75
              ? (1 - actorProgress) / 0.25
              : 1;
        const travel = Math.max(0, Math.min(1, t)) * (path.length - 1),
          k = Math.min(path.length - 2, Math.floor(travel)),
          u = travel - k,
          b = path[k + 1]!,
          c = path[k]!;
        x = c[0] + (b[0] - c[0]) * u;
        y = c[1] + (b[1] - c[1]) * u;
        const church = this.frame.to(this.route.site.location),
          d = Math.hypot(church[0] - x, church[1] - y) || 1;
        hx = (church[0] - x) / d;
        hy = (church[1] - y) / d;
      } else {
        const s = head - a.back;
        if (!a.destination && (s < 0 || s > this.along.at(-1)!)) continue;
        const at = this.at(a.destination ? -a.back : s);
        hx = at.hx;
        hy = at.hy;
        x = at.x - hy * a.off;
        y = at.y + hx * a.off;
      }
      const q = this.frame.from([x, y]);
      const radius =
        a.glyph === ProcessionGlyph.andas ? 1.7 : a.vehicle ? VEHICLES[a.vehicle].width / 2 : 0.55;
      const corners: Point[] = [
        [x - radius, y - radius],
        [x - radius, y + radius],
        [x + radius, y - radius],
        [x + radius, y + radius],
      ].map((q) => this.frame.from(q as Point));
      if (!eventGroundAllows(this.ground, [q, ...corners])) continue;
      out.push({
        kind: a.vehicle ? 'vehicle' : 'person',
        lng: q[0],
        lat: q[1],
        ahead: this.frame.from([x + hx, y + hy]),
        side: this.frame.from([x + hy, y - hx]),
        flap:
          this.route.kind === 'mass' && actorProgress >= 0.25 && actorProgress <= 0.75
            ? 0
            : Math.floor(actorTime * 2 + a.phase) & 1,
        ...(a.glyph && { prop: 'event', glyph: a.glyph }),
        ...(a.vehicle && { vehicle: a.vehicle }),
        candle: (adopted?.candle ?? a.candle) && !a.glyph && !a.vehicle,
        candleSeed: adopted?.candleSeed ?? hashString(a.id),
        paint: adopted?.paint ?? a.paint,
        eventActor: id,
        eventGround: this.ground,
      });
    }
    return out;
  }
}
