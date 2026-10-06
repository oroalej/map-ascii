/** Deterministic street formations and connected arrival gatherings, independent of the camera. */
import {
  localMetricProjection,
  PROCESSION_DEFAULTS,
  PROCESSION_GEOMETRY,
  LEGACY_LOCAL_METERS_PER_DEGREE,
  type StreetRoute,
  type MassRoute,
} from '@atlas/shared';
import { PROCESSION, motionProfile, profileAt, routePolyline } from './procession';
import { ProcessionGlyph } from './procession-glyphs';
import { eventGroundAllows, groundForRoute, type EventGround } from './ground-events';
import { hashString, random } from './random';
import type { VisibleAgent } from './simulate';
import type { LifeInspection } from './inspection';
import { VEHICLES } from './vehicles';
import { eventActor, identifyEventActor, eventBodySize } from './event-actors';
import { bodyCorners, segmentBody } from './occupancy';

type Point = [number, number];
const MASS_CELL = PROCESSION_GEOMETRY.massCell;
const PERSON_REACH =
  Math.max(PROCESSION_GEOMETRY.person.length, PROCESSION_GEOMETRY.person.width) / 2 +
  PROCESSION_GEOMETRY.probePadding;
// Mass walkers face the church throughout approach/exit, so sweeps enclose every heading.
const PERSON_RADIUS = Math.hypot(
  PROCESSION_GEOMETRY.person.length / 2 + PROCESSION_GEOMETRY.probePadding,
  PROCESSION_GEOMETRY.person.width / 2 + PROCESSION_GEOMETRY.probePadding,
);
type Actor = {
  id: string;
  seed: number;
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
  readonly along: number[];
  private readonly polyline: ReturnType<typeof routePolyline>;
  readonly profile: Float64Array;
  private readonly tail: number;
  private scopedIds?: { scope: string; ids: string[] };
  private adopted: VisibleAgent[] = [];
  private massCells = new Map<string, Point>();
  private massParents = new Map<string, string | undefined>();
  private massOrder = new Map<string, number>();
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
    this.polyline = routePolyline(this.points);
    this.along = this.polyline.along;
    this.profile = motionProfile(hashString(route.id), this.along.at(-1)!);
    this.ground = groundForRoute(route);
    this.build();
    this.tail =
      this.actors.reduce<number>(
        (tail, actor) => (actor.destination ? tail : Math.max(tail, actor.back)),
        PROCESSION.street.tailPadding,
      ) + PROCESSION.street.tailPadding;
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
    ) => {
      const id = `${this.route.id}/${this.actors.length}`;
      this.actors.push({
        id,
        seed: hashString(id),
        back,
        off,
        paint,
        phase: rng() * 6.28,
        candle: rng() < PROCESSION.candles,
        glyph,
        vehicle,
      });
    };
    if (this.route.kind === 'mass') {
      const r = this.route;
      const key = (x: number, y: number) => `${x}/${y}`;
      const cells = new Map<string, Point>();
      for (const ring of r.site.grounds) {
        const permission = { regions: [ring], blocked: this.ground.blocked };
        const xy = ring.map(this.frame.to),
          xs = xy.map((q) => q[0]),
          ys = xy.map((q) => q[1]);
        for (
          let y = Math.ceil((Math.min(...ys) + PERSON_REACH) / MASS_CELL);
          y * MASS_CELL < Math.max(...ys) - PERSON_REACH;
          y++
        )
          for (
            let x = Math.ceil((Math.min(...xs) + PERSON_REACH) / MASS_CELL);
            x * MASS_CELL < Math.max(...xs) - PERSON_REACH;
            x++
          ) {
            const q: Point = [x * MASS_CELL, y * MASS_CELL];
            const footprint = bodyCorners({
              x: q[0],
              y: q[1],
              hx: 1,
              hy: 0,
              length: MASS_CELL,
              width: MASS_CELL,
            }).map((p) => this.frame.from([p.x, p.y]));
            // Quantized row edges can shift slightly around a 2 m lattice cell. Require
            // every heading's padded body inside the row, and the whole cell clear of roofs.
            const probes = bodyCorners({
              x: q[0],
              y: q[1],
              hx: 1,
              hy: 0,
              length: 2 * PERSON_RADIUS,
              width: 2 * PERSON_RADIUS,
            }).map((p) => this.frame.from([p.x, p.y]));
            if (eventGroundAllows(permission, probes, footprint)) cells.set(key(x, y), q);
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
      this.massOrder = new Map(queue.map((id, i) => [id, i]));
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
      for (let i = 0; i < (f?.bearers ?? PROCESSION_DEFAULTS.procession.bearers); i++)
        add(
          PROCESSION.street.bearerStart + Math.floor(i / 2) * PROCESSION.street.bearerGap,
          (i % 2 ? 1 : -1) * PROCESSION_GEOMETRY.bearerOffset,
          3,
        );
      for (let i = 0; i < (f?.marshals ?? PROCESSION_DEFAULTS.procession.marshals); i++)
        add(
          -PROCESSION.street.marshalLead - Math.floor(i / 2) * PROCESSION.street.marshalGap,
          (i % 2 ? 1 : -1) * PROCESSION_GEOMETRY.marshalOffset,
          6,
          ProcessionGlyph.flag,
        );
      for (let r = 0; r < (f?.ranks ?? PROCESSION_DEFAULTS.procession.ranks); r++)
        for (let c = 0; c < PROCESSION_GEOMETRY.columns; c++)
          add(
            PROCESSION.street.devoteeStart + r * PROCESSION.street.rankGap,
            (c - (PROCESSION_GEOMETRY.columns - 1) / 2) * PROCESSION_GEOMETRY.columnPitch,
            3 + Math.floor(rng() * 5),
          );
    } else {
      const f = this.route.formation;
      let back = 0;
      for (let i = 0; i < (f?.color_guard ?? PROCESSION_DEFAULTS.parade.color_guard); i++)
        add(
          back + Math.floor(i / PROCESSION_GEOMETRY.columns) * PROCESSION.street.rankGap,
          ((i % PROCESSION_GEOMETRY.columns) - (PROCESSION_GEOMETRY.columns - 1) / 2) *
            PROCESSION_GEOMETRY.columnPitch,
          5,
          ProcessionGlyph.flag,
        );
      back += PROCESSION.street.guardGap;
      for (let i = 0; i < (f?.band ?? PROCESSION_DEFAULTS.parade.band); i++)
        add(
          back + Math.floor(i / PROCESSION_GEOMETRY.columns) * PROCESSION.street.rankGap,
          ((i % PROCESSION_GEOMETRY.columns) - (PROCESSION_GEOMETRY.columns - 1) / 2) *
            PROCESSION_GEOMETRY.columnPitch,
          4,
          i % 2 ? ProcessionGlyph.bugle : ProcessionGlyph.drum,
        );
      back +=
        Math.ceil((f?.band ?? PROCESSION_DEFAULTS.parade.band) / PROCESSION_GEOMETRY.columns) *
          PROCESSION.street.rankGap +
        PROCESSION.street.bandGap;
      for (let k = 0; k < (f?.contingents ?? PROCESSION_DEFAULTS.parade.contingents); k++) {
        for (let r = 0; r < (f?.ranks ?? PROCESSION_DEFAULTS.parade.ranks); r++)
          for (let c = 0; c < PROCESSION_GEOMETRY.columns; c++)
            add(
              back + r * PROCESSION.street.rankGap,
              (c - (PROCESSION_GEOMETRY.columns - 1) / 2) * PROCESSION_GEOMETRY.columnPitch,
              3 + k,
            );
        back +=
          (f?.ranks ?? PROCESSION_DEFAULTS.parade.ranks) * PROCESSION.street.rankGap +
          PROCESSION.street.contingentGap;
      }
      for (const vehicle of f?.vehicles ?? []) {
        add(back, 0, 5, undefined, vehicle);
        back += VEHICLES[vehicle].length + PROCESSION.street.vehicleGap;
      }
    }
    // Both sidewalks; weight the start and arrival without independent random reseeding.
    const spacing = Math.max(
      PROCESSION.street.spectatorSpacing,
      this.route.length_m / PROCESSION.eventSpectators,
    );
    for (
      let s = 0;
      s <= this.route.length_m && this.actors.length < PROCESSION.eventActors;
      s += spacing
    )
      for (const side of [-1, 1]) {
        const at = this.at(s),
          segment = this.route.segments[at.index]!;
        const inset = Math.min(
          PROCESSION.street.spectatorInset,
          segment.sidewalk_m - PERSON_REACH - PROCESSION.street.spectatorMargin,
        );
        if (inset < 0) continue;
        add(-s, side * (segment.width_m / 2 + inset), 3 + Math.floor(rng() * 5));
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
        [-PERSON_RADIUS, -PERSON_RADIUS],
        [PERSON_RADIUS, -PERSON_RADIUS],
        [PERSON_RADIUS, PERSON_RADIUS],
        [-PERSON_RADIUS, PERSON_RADIUS],
      ].map(([dx, dy]) => this.frame.from([q[0] + dx!, q[1] + dy!]));
      if (!eventGroundAllows(this.ground, footprint, footprint)) continue;
      let nearest: string | undefined,
        distance = Infinity;
      const cx = Math.round(q[0] / MASS_CELL),
        cy = Math.round(q[1] / MASS_CELL);
      for (let y = cy - 1; y <= cy + 1; y++)
        for (let x = cx - 1; x <= cx + 1; x++) {
          const key = `${x}/${y}`;
          if (!this.massParents.has(key)) continue;
          const cell = this.massCells.get(key)!,
            d = (cell[0] - q[0]) ** 2 + (cell[1] - q[1]) ** 2;
          if (
            d < distance ||
            (d === distance && this.massOrder.get(key)! < this.massOrder.get(nearest!)!)
          ) {
            nearest = key;
            distance = d;
          }
        }
      if (
        !nearest ||
        Math.hypot(this.massCells.get(nearest)![0] - q[0], this.massCells.get(nearest)![1] - q[1]) >
          MASS_CELL
      )
        continue;
      const cell = this.massCells.get(nearest)!;
      const swept = bodyCorners(
        segmentBody({ x: q[0], y: q[1] }, { x: cell[0], y: cell[1] }, PERSON_RADIUS),
      ).map((p) => this.frame.from([p.x, p.y]));
      if (!eventGroundAllows(this.ground, swept, swept)) continue;
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
      const destKey = `${Math.round(destination[0] / MASS_CELL)}/${Math.round(destination[1] / MASS_CELL)}`,
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
    this.adopted = [];
    if (this.route.kind === 'mass') this.actors.forEach((a, i) => (a.approach = this.massPaths[i]));
  }
  private at(s: number) {
    return this.polyline.at(s);
  }
  private head(progress: number) {
    return (
      (this.route.kind === 'parade' ? progress : profileAt(this.profile, progress)) *
        (this.along.at(-1)! + this.tail) -
      this.tail
    );
  }
  spans(progress: number): EventSpan[] {
    // Mass road overflow is reserved by its actual admitted bodies, not every nearby road.
    const route = this.route;
    if (route.kind === 'mass') return [];
    const head = this.head(progress),
      from = Math.max(0, head - this.tail),
      to = Math.min(this.along.at(-1)!, head + PROCESSION.street.headMargin);
    if (to < from) return [];
    return this.points.slice(1).flatMap((b, i) =>
      this.along[i + 1]! >= from && this.along[i]! <= to
        ? [
            {
              a: this.frame.from(this.points[i]!),
              b: this.frame.from(b),
              width: route.segments[i]!.width_m,
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
      inspection?: LifeInspection;
      scope?: string;
      owner?: (id: string) => object;
    } = {},
  ): VisibleAgent[] {
    const out: VisibleAgent[] = [];
    if (progress < 0 || progress >= 1) return out;
    const scope = options.scope ?? 'live/default';
    if (this.scopedIds?.scope !== scope)
      this.scopedIds = { scope, ids: this.actors.map((actor) => `${scope}/${actor.id}`) };
    for (let i = 0; i < this.actors.length; i++) {
      const a = this.actors[i]!;
      const adopted = this.adopted[i],
        id = eventActor(adopted) ?? this.scopedIds.ids[i]!;
      const owner = options.owner?.(id);
      const actorProgress =
        owner && options.inspection ? options.inspection.progress(owner, progress) : progress;
      const actorTime = owner && options.inspection ? options.inspection.clock(owner, time) : time;
      const head = this.route.kind === 'mass' ? 0 : this.head(actorProgress);
      if (a.destination && options.crowds === false) continue;
      let x: number, y: number, hx: number, hy: number;
      if (this.route.kind === 'mass') {
        const path = a.approach!;
        // Queue new walkers over the arrival window instead of placing hundreds at the
        // same approach point. Adopted walkers keep their existing position immediately.
        const delay = adopted
          ? 0
          : (i / Math.max(1, this.actors.length)) * PROCESSION.mass.queueSpread;
        if (!adopted && actorProgress < delay) continue;
        const t =
          actorProgress < PROCESSION.mass.arrivalEnd
            ? (actorProgress - delay) / (PROCESSION.mass.arrivalEnd - delay)
            : actorProgress > PROCESSION.mass.disperseStart
              ? (1 - actorProgress) / (1 - PROCESSION.mass.disperseStart)
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
      const dimensions = eventBodySize(a);
      const corners = bodyCorners({
        x,
        y,
        hx,
        hy,
        length: dimensions.length + 2 * PROCESSION_GEOMETRY.probePadding,
        width: dimensions.width + 2 * PROCESSION_GEOMETRY.probePadding,
      }).map((point) => this.frame.from([point.x, point.y]));
      if (!eventGroundAllows(this.ground, [q, ...corners], corners)) continue;
      out.push(
        identifyEventActor(
          {
            kind: a.vehicle ? 'vehicle' : 'person',
            lng: q[0],
            lat: q[1],
            ahead: this.frame.from([x + hx, y + hy]),
            side: this.frame.from([x + hy, y - hx]),
            flap:
              this.route.kind === 'mass' &&
              actorProgress >= PROCESSION.mass.arrivalEnd &&
              actorProgress <= PROCESSION.mass.disperseStart
                ? 0
                : Math.floor(actorTime * 2 + a.phase) & 1,
            ...(a.glyph && { prop: 'event', glyph: a.glyph }),
            ...(a.vehicle && { vehicle: a.vehicle }),
            candle: (adopted?.candle ?? a.candle) && !a.glyph && !a.vehicle,
            candleSeed: adopted?.candleSeed ?? a.seed,
            paint: adopted?.paint ?? a.paint,
            eventGround: this.route.id,
          },
          id,
        ),
      );
    }
    return out;
  }
}
