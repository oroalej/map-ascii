import { formationLayout } from './formation-layout';
/** Deterministic street formations and connected arrival gatherings, independent of the camera. */
import {
  localMetricProjection,
  PROCESSION_GEOMETRY,
  LEGACY_LOCAL_METERS_PER_DEGREE,
  type StreetRoute,
  type MassRoute,
} from '@atlas/shared';
import { PROCESSION, motionProfile, routePolyline } from './procession';
import { ProcessionGlyph } from './procession-glyphs';
import { eventGroundAllows, groundForRoute, type EventGround } from './ground-events';
import { hashString, random } from './random';
import type { VisibleAgent } from './simulate';
import type { LifeInspection } from './inspection';
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
  groundAllowed?: boolean;
  eventRole?: 'altar';
  eventFootprint?: { length: number; width: number };
  eventScenery?: boolean;
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
  private readonly leadingExtent: number;
  private scopedIds?: { scope: string; ids: string[] };
  private adopted: VisibleAgent[] = [];
  private massCells = new Map<string, Point>();
  private massParents = new Map<string, string | undefined>();
  private massOrder = new Map<string, number>();
  private massPaths: Point[][] = [];
  private readonly streetSpans: EventSpan[];
  private readonly spanBuffer: EventSpan[] = [];
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
    this.streetSpans =
      route.kind === 'mass'
        ? []
        : route.route
            .slice(1)
            .map((b, i) => ({ a: route.route[i]!, b, width: route.segments[i]!.width_m }));
    this.polyline = routePolyline(this.points);
    this.along = this.polyline.along;
    this.profile = motionProfile(hashString(route.id), this.along.at(-1)!);
    this.ground = groundForRoute(route);
    this.build();
    const layout = route.kind === 'mass' ? undefined : formationLayout(route);
    this.tail = layout?.tail ?? 0;
    this.leadingExtent = layout?.leading ?? 0;
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
          ys = xy.map((q) => q[1]),
          minX = Math.min(...xs),
          maxX = Math.max(...xs),
          minY = Math.min(...ys),
          maxY = Math.max(...ys);
        for (
          let y = Math.ceil((minY + PERSON_REACH) / MASS_CELL);
          y * MASS_CELL < maxY - PERSON_REACH;
          y++
        )
          for (
            let x = Math.ceil((minX + PERSON_REACH) / MASS_CELL);
            x * MASS_CELL < maxX - PERSON_REACH;
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
      let root: string | undefined,
        closest = Infinity;
      for (const [id, point] of cells) {
        const d = distance(point);
        if (d < closest) {
          closest = d;
          root = id;
        }
      }
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
      const reserved = r.site.altar ? 8 + r.site.altar.images + 5 : 0;
      for (const id of queue.slice(0, PROCESSION.eventActors - reserved)) {
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
      if (r.site.altar) {
        const centre = this.frame.to(r.site.altar.at);
        const fixed = (
          dx: number,
          dy: number,
          paint: number,
          glyph?: string,
          size?: { length: number; width: number },
          scenery = false,
        ) => {
          add(0, 0, paint, glyph);
          const a = this.actors.at(-1)!;
          a.destination = this.frame.from([centre[0] + dx, centre[1] + dy]);
          a.eventRole = 'altar';
          a.eventFootprint = size;
          a.eventScenery = scenery;
        };
        for (let i = 0; i < 8; i++)
          fixed(((i % 4) - 1.5) * 1.2, -2 + Math.floor(i / 4) * 1.5, i < 5 ? 0 : 7);
        fixed(0, 0, 6, ProcessionGlyph.platform, { length: 5, width: 5 }, true);
        fixed(0, 2, 3, ProcessionGlyph.table, { length: 1.2, width: 2.4 });
        fixed(0, 0, 3, ProcessionGlyph.canopy, { length: 5, width: 6 }, true);
        fixed(-3, 2, 6, ProcessionGlyph.support, { length: 0.4, width: 0.4 });
        fixed(3, 2, 6, ProcessionGlyph.support, { length: 0.4, width: 0.4 });
        for (let i = 0; i < r.site.altar.images; i++)
          fixed(
            (i - (r.site.altar.images - 1) / 2) * 10,
            -0.5,
            4,
            ProcessionGlyph.andas,
            PROCESSION_GEOMETRY.andas,
          );
      }
      return;
    }
    for (const member of formationLayout(this.route).actors)
      add(member.back, member.off, member.paint, member.glyph, member.vehicle);
  }

  adopt(actors: readonly VisibleAgent[]) {
    this.reset();
    if (this.route.kind !== 'mass') return;
    for (const actor of actors) {
      if (this.adopted.length >= this.actors.length || this.actors[this.adopted.length]?.eventRole)
        break;
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
  saveAdoption() {
    return { actors: [...this.adopted], paths: this.actors.map((actor) => actor.approach) };
  }
  restoreAdoption(state: ReturnType<GroundProcessionScene['saveAdoption']>) {
    this.adopted = [...state.actors];
    this.actors.forEach((actor, i) => (actor.approach = state.paths[i]));
  }
  private at(s: number) {
    return this.polyline.at(s);
  }
  private head(progress: number) {
    return this.route.kind === 'mass' ? 0 : formationLayout(this.route).head(progress);
  }

  spans(progress: number): EventSpan[] {
    // Mass road overflow is reserved by its actual admitted bodies, not every nearby road.
    const route = this.route;
    const spans = this.spanBuffer;
    spans.length = 0;
    if (route.kind === 'mass') return spans;
    const head = this.head(progress),
      from = Math.max(0, head - this.tail),
      to = Math.min(this.along.at(-1)!, head + this.leadingExtent);
    if (to < from) return spans;
    for (let i = 0; i < this.streetSpans.length; i++)
      if (this.along[i + 1]! >= from && this.along[i]! <= to) spans.push(this.streetSpans[i]!);
    return spans;
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
      if (a.destination && !a.eventRole && options.crowds === false) continue;
      let x: number, y: number, hx: number, hy: number;
      let holding = false;
      if (a.eventRole) {
        [x, y] = this.frame.to(a.destination!);
        hx = 0;
        hy = -1;
        holding = true;
      } else if (this.route.kind === 'mass') {
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
        holding = t === 1;
        const travel = Math.max(0, Math.min(1, t)) * (path.length - 1),
          k = Math.min(path.length - 2, Math.floor(travel)),
          u = travel - k,
          b = path[k + 1]!,
          c = path[k]!;
        x = c[0] + (b[0] - c[0]) * u;
        y = c[1] + (b[1] - c[1]) * u;
        const church = this.frame.to(this.route.site.altar?.at ?? this.route.site.location),
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
      const fixed = this.route.kind !== 'mass' && !!a.destination;
      if ((a.eventRole || !holding) && (!fixed || a.groundAllowed === undefined)) {
        const dimensions = eventBodySize(a);
        const corners = bodyCorners({
          x,
          y,
          hx,
          hy,
          length: dimensions.length + 2 * PROCESSION_GEOMETRY.probePadding,
          width: dimensions.width + 2 * PROCESSION_GEOMETRY.probePadding,
        }).map((point) => this.frame.from([point.x, point.y]));
        const allowed = eventGroundAllows(
          a.eventRole ? this.ground.altar! : this.ground,
          [q, ...corners],
          corners,
        );
        if (fixed) a.groundAllowed = allowed;
        if (!allowed) continue;
      } else if (fixed && !a.groundAllowed) continue;
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
            ...(a.eventRole && {
              eventRole: a.eventRole,
              eventFootprint: a.eventFootprint,
              eventScenery: a.eventScenery,
            }),
          },
          id,
        ),
      );
    }
    return out;
  }
}
