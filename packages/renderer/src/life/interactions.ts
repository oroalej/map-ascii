import {
  LIFE_SITE_KINDS,
  TRANSIT_BITS,
  shopHours,
  shopOpen,
  type CityLifeConfig,
  type LifeSiteKind,
} from '@atlas/shared';
import { inTile, SITE_STRIDE, type LifeGeometry, type LifeLine } from './geometry';
import { WalkingGraph, type WalkPoint } from './navigation';
import { between, random } from './random';
import { VEHICLES } from './vehicles';
import { isWalker, RUN, RECOVERY, usableLines, kinematicsOf, type Activity } from './config';
import { exposed, runPace } from './running';
import { animalSize, memberSize } from './occupancy';
import type { Mover, Stall } from './simulate';
import { faceGroup, restoreMover, snapshotMover } from './mover-pose';
import { stopBefore, stoppingReach, type MotionLimit } from './motion';
import { complete } from './cooperate';
import type { LifeDiagnostics } from './diagnostics';

export const INTERACTIONS = {
  stopQueue: 6,
  vendorQueue: 4,
  terminalQueue: 3,
  /** Begin service only after the vehicle has completed its approach, m/s. */
  arrivalSpeed: 0.1,
  /** Blend a transit vehicle from its ordinary lane toward the curb over this distance, m. */
  curbBlend: 20,
  /** Extra distance for selecting an approaching service stop, m. */
  stopPad: 4,
  /** Seconds a vehicle serves a stop, and a customer spends at a stall. */
  dwell: [8, 15],
  purchase: [3, 6],
  rainOn: 0.5,
  rainOff: 0.2,
  /** Default site search radius, m; caught walkers use `RUN.shelter.reach`. */
  reach: 35,
  /** Per-scan admission chances for covered sites in rain and visits in dry weather. */
  shelterChance: 0.7,
  visitChance: 0.12,
} as const;
type Site = WalkPoint & {
  kind: LifeSiteKind | 'vendor' | 'rest';
  modes: number;
  covered: boolean;
  queue: Mover[];
  capacity: number;
  hx: number;
  hy: number;
  road: number;
  roadWidth: number;
  direction: number;
  stall?: Stall;
};
export type Visit = {
  site: Site;
  state: 'approach' | 'wait' | 'purchase' | 'board' | 'aboard' | 'shelter' | 'rest' | 'return';
  path: WalkPoint[];
  trail: WalkPoint[];
  next: number;
  time: number;
  seat: number;
  sheltering: boolean;
  blocked: number;
  retryAt?: number;
  progress?: {
    x: number;
    y: number;
    hx: number;
    hy: number;
    target?: WalkPoint;
    intent?: { hx: number; hy: number };
  };
  /** Preferred side for checked detours; independent of the ordinary route's avoidance. */
  sidestep?: 1 | -1;
  /** Keep an accepted bypass waypoint until reached, instead of aiming back at the blocker. */
  bypass?: {
    target: WalkPoint;
    side: WalkPoint;
    retreat?: WalkPoint;
    start: WalkPoint;
    hx: number;
    hy: number;
    progress: number;
  };
  /** Cancellation waits for the full footprint to leave the crossing before reversing. */
  returnPending?: boolean;
};
type Service = {
  site: Site;
  time: number;
  boarded: number;
  arriving: boolean;
  passenger?: Mover;
};
export type YieldHooks<Prefix extends unknown[] = []> = {
  contact?: (...args: [...Prefix, mover: Mover, trial?: Mover]) => void;
  yielding?: (mover: Mover) => Mover | undefined;
  holding?: (...args: [...Prefix, mover: Mover, changedOnly?: boolean]) => boolean;
  holdingCorridor?: (...args: [...Prefix, mover: Mover, before: Mover]) => boolean;
  passing?: (mover: Mover) => boolean;
  cancelYield?: (mover: Mover) => void;
};
type MoveGuard = ((mover: Mover, before: Mover, reserve?: boolean) => boolean) & YieldHooks;
const dist = (a: WalkPoint, b: WalkPoint) => Math.hypot(a.x - b.x, a.y - b.y);
/** How far `p` lies ahead of a mover along its heading (negative: behind it). */
const ahead = (p: WalkPoint, m: Mover) => (p.x - m.x) * m.hx + (p.y - m.y) * m.hy;

/** Reservations and small local scenes, using the tile's existing inhabitants. */
export class LocalScenes {
  private returningToRoute?: Mover;

  /** Effective walking offset during a scene or its checked route handoff. */
  walkingOffset(m: Mover, identity = m): number {
    return this.visits.has(identity) && this.returningToRoute !== identity ? 0 : (m.avoid ?? 0);
  }

  /** Normal purchase outcomes, bounded and replaced on every accepted step. */
  readonly purchaseCompletions: { mover: Mover; stall: Stall; key: object }[] = [];
  /** Bounded, frame-local entry notifications; observers cannot mutate service ownership. */
  readonly speechEvents: {
    kind: 'purchase' | 'wait' | 'shelter' | 'arrival';
    mover: Mover;
    visit: Visit;
    key: object;
  }[] = [];
  private speechEvent(
    kind: 'purchase' | 'wait' | 'shelter' | 'arrival',
    mover: Mover,
    visit: Visit,
  ) {
    if (this.speechEvents.length < 8) this.speechEvents.push({ kind, mover, visit, key: {} });
  }
  readonly visits = new Map<Mover, Visit>();
  readonly sites: Site[] = [];
  readonly services = new Map<Mover, Service>();
  private readonly graph: WalkingGraph;
  private readonly rng: () => number;
  private readonly cooldown = new Map<Mover, number>();
  private returnAfterInspection?: WeakSet<Mover>;
  private readonly yielding = new WeakMap<
    Mover,
    {
      anchor: Mover;
      path: WalkPoint[];
      next: number;
      returning: boolean;
      seconds: number;
      returnBlocked: number;
      returnDistance?: number;
      returnRetry?: number;
    }
  >();
  private readonly yieldHeld = new WeakSet<Mover>();
  private readonly stopCooldown = new Map<Mover, Site>();
  private wet = false;
  private rain = 0;
  private scan = 0;
  private cursor = 0;
  private minutes = -1;
  private hoursDirty = false;
  private cityLife: Pick<CityLifeConfig, 'schedules'> | undefined;

  constructor(
    private readonly geo: LifeGeometry,
    readonly perMeter: number,
    seed: number,
    stalls: readonly Stall[],
    private readonly idleGuard?: (mover: Mover) => boolean,
    private readonly busy?: (mover: Mover) => boolean,
    deferred = false,
  ) {
    this.graph = new WalkingGraph(geo, perMeter, true);
    this.rng = random(seed ^ 0xb5297a4d);
    if (!deferred) complete(this.prepare(geo, stalls));
  }
  *prepare(geo: LifeGeometry, stalls: readonly Stall[]): Generator<void, void, void> {
    yield* this.graph.prepare(geo);
    for (let i = 0; i < geo.sites.length; i += SITE_STRIDE) {
      yield;
      const kind = LIFE_SITE_KINDS[geo.sites[i + 2]!];
      if (!kind) continue;
      const site: Site = {
        x: geo.sites[i]!,
        y: geo.sites[i + 1]!,
        kind,
        modes: geo.sites[i + 3]!,
        covered: geo.sites[i + 4] === 1,
        queue: [],
        capacity: kind === 'shelter' ? 12 : INTERACTIONS.stopQueue,
        hx: 1,
        hy: 0,
        road: -1,
        roadWidth: 6,
        direction: 1,
      };
      const entrance = this.graph.entrance(site);
      if (!entrance || !inTile(entrance)) continue;
      site.x = entrance.x;
      site.y = entrance.y;
      yield* this.attachRoad(site, geo);
      this.sites.push(site);
    }
    for (const stall of stalls) {
      this.addStall(stall);
      yield;
    }
  }

  addStall(stall: Stall) {
    const { perMeter } = this;
    if (!inTile(stall)) return;
    const site: Site = {
      x: stall.x - stall.hy * stall.side * 1.3 * perMeter,
      y: stall.y + stall.hx * stall.side * 1.3 * perMeter,
      kind: 'vendor',
      modes: 0,
      covered: false,
      queue: [],
      capacity: INTERACTIONS.vendorQueue,
      hx: stall.hx,
      hy: stall.hy,
      road: -1,
      roadWidth: 6,
      direction: 1,
      stall,
    };
    this.sites.push(site);
    this.sites.push({
      ...site,
      kind: 'rest',
      queue: [],
      capacity: 1,
      x: site.x - site.hx * 2 * perMeter,
      y: site.y - site.hy * 2 * perMeter,
    });
  }

  /** Removed placements must not leave reservable vendor/rest sites behind. */
  removeStall(stall: Stall) {
    for (const [mover, visit] of this.visits)
      if (visit.site.stall === stall && visit.state !== 'return') this.requestReturn(mover, visit);
    for (let i = this.sites.length - 1; i >= 0; i--)
      if (this.sites[i]!.stall === stall) {
        this.sites[i]!.queue.length = 0;
        this.sites.splice(i, 1);
      }
  }

  /** Service/passenger relationships cannot be separated by a tile transfer. */
  transferable(m: Mover): boolean {
    if (this.busy?.(m) || this.services.has(m) || this.visits.has(m) || this.yielding.has(m))
      return false;
    for (const service of this.services.values()) if (service.passenger === m) return false;
    return true;
  }

  /** Release all references, including private cooldowns, without advancing any random stream. */
  release(m: Mover): void {
    const service = this.services.get(m);
    if (service?.passenger) {
      const visit = this.visits.get(service.passenger);
      if (visit?.state === 'board') this.returning(service.passenger, visit);
    }
    for (const s of this.services.values()) if (s.passenger === m) s.passenger = undefined;
    for (const site of this.sites) site.queue = site.queue.filter((p) => p !== m);
    this.services.delete(m);
    this.visits.delete(m);
    this.cooldown.delete(m);
    this.stopCooldown.delete(m);
    this.yielding.delete(m);
    this.yieldHeld.delete(m);
  }

  private *attachRoad(site: Site, geo: LifeGeometry): Generator<void, void, void> {
    let best = 25 * this.perMeter;
    for (let line = 0; line < geo.kinds.length; line++) {
      if (!usableLines.vehicle.includes(geo.kinds[line]! as LifeLine)) continue;
      for (let v = geo.starts[line]!; v < geo.starts[line + 1]! - 1; v++) {
        if ((v & 63) === 0) yield;
        const ax = geo.coords[v * 2]!;
        const ay = geo.coords[v * 2 + 1]!;
        const dx = geo.coords[v * 2 + 2]! - ax;
        const dy = geo.coords[v * 2 + 3]! - ay;
        const length = Math.hypot(dx, dy);
        if (length === 0) continue;
        const t = Math.max(0, Math.min(1, ((site.x - ax) * dx + (site.y - ay) * dy) / length ** 2));
        const x = ax + dx * t;
        const y = ay + dy * t;
        const d = Math.hypot(site.x - x, site.y - y);
        if (d < best) {
          best = d;
          site.road = line;
          site.roadWidth = geo.widths[line] || 6;
          site.direction = dx * (site.y - y) - dy * (site.x - x) >= 0 ? 1 : -1;
          site.hx = (dx / length) * site.direction;
          site.hy = (dy / length) * site.direction;
        }
      }
    }
  }

  private queuePoint(site: Site, seat: number): WalkPoint {
    return {
      x: site.x - site.hx * seat * 1.5 * this.perMeter,
      y: site.y - site.hy * seat * 1.5 * this.perMeter,
    };
  }

  /** Explicit entry point also used by deterministic scene tests. */
  reserve(m: Mover, index: number): boolean {
    const site = this.sites[index];
    if (
      !site ||
      this.visits.has(m) ||
      this.yielding.has(m) ||
      this.busy?.(m) ||
      (isWalker(m.kind) && !this.canIdle(m))
    )
      return false;
    const size = m.group?.length ?? 1;
    const occupied = new Set(
      site.queue.flatMap((p) => {
        const seat = this.visits.get(p)!.seat;
        return Array.from({ length: p.group?.length ?? 1 }, (_, i) => seat + i);
      }),
    );
    let seat = 0;
    while (
      seat < site.capacity &&
      Array.from({ length: size }, (_, i) => seat + i).some((s) => occupied.has(s))
    )
      seat++;
    if (seat + size > site.capacity) return false;
    const point = this.queuePoint(site, seat);
    if (!inTile(point)) return false;
    if (isWalker(m.kind) && !this.canIdle({ ...m, ...point, hx: site.hx, hy: site.hy, avoid: 0 }))
      return false;
    const path = this.route(m, point);
    if (!path || !path.every(inTile)) return false;
    site.queue.push(m);
    this.visits.set(m, {
      site,
      state: 'approach',
      path,
      // Its first point is where the visit began, where the visitor returns to.
      trail: [{ x: m.x, y: m.y }],
      next: 1,
      seat,
      time: 0,
      sheltering: this.wet && site.covered,
      blocked: 0,
    });
    m.pause = 0;
    return true;
  }

  private returning(m: Mover, visit: Visit) {
    visit.site.queue = visit.site.queue.filter((p) => p !== m);
    // Retrace the actual approach, including partial approaches, without unsafe shortcuts.
    visit.path = [{ x: m.x, y: m.y }, ...visit.trail.slice().reverse()];
    visit.next = 1;
    visit.state = 'return';
    if (visit.blocked > 0) {
      const target = visit.path[1]!,
        d = dist(m, target);
      if (d > 1e-8 * this.perMeter)
        visit.progress = {
          x: m.x,
          y: m.y,
          hx: (target.x - m.x) / d,
          hy: (target.y - m.y) / d,
          target,
        };
    }
    visit.returnPending = false;
    delete visit.bypass;
    m.pause = 0;
    m.lying = false;
  }

  private route(from: WalkPoint, to: WalkPoint) {
    const start = { x: from.x, y: from.y };
    const path = this.graph.route(start, { x: to.x, y: to.y });
    // A tiny perpendicular attachment after a sidestep can force another in-place
    // turn into the same blocker. Skip it only through an equally clear graph edge;
    // the actual movement still passes the full swept footprint guard.
    while (
      path &&
      path.length > 2 &&
      dist(start, path[1]!) <= 1.5 * this.perMeter &&
      this.graph.clear(start, path[2]!)
    )
      path.splice(1, 1);
    return path;
  }

  private canIdle(m: Mover): boolean {
    if (this.idleGuard) return this.idleGuard(m);
    const lane = this.visits.has(m) ? 0 : (m.avoid ?? 0);
    return this.graph.allowsBodies(this.walkingBodies(m, m, lane), false);
  }

  private walkingBodies(m: Mover, point: WalkPoint, lane = 0, turning = false) {
    const heading = m.momentFacing ?? m;
    const x = point.x - m.hy * lane * this.perMeter,
      y = point.y + m.hx * lane * this.perMeter;
    return (m.group ?? [{ lateral: 0, back: 0, figure: 'adult' }]).map((w) => {
      const size = m.kind === 'dog' || m.kind === 'cat' ? animalSize(m.kind) : memberSize(w.figure);
      return {
        x: x - heading.hy * w.lateral * this.perMeter - heading.hx * w.back * this.perMeter,
        y: y + heading.hx * w.lateral * this.perMeter - heading.hy * w.back * this.perMeter,
        hx: heading.hx,
        hy: heading.hy,
        length: (turning ? Math.hypot(size.length, size.width) : size.length) * this.perMeter,
        width: (turning ? Math.hypot(size.length, size.width) : size.width) * this.perMeter,
      };
    });
  }

  private requestReturn(m: Mover, visit: Visit) {
    visit.site.queue = visit.site.queue.filter((p) => p !== m);
    if (isWalker(m.kind) && !this.canIdle(m)) visit.returnPending = true;
    else this.returning(m, visit);
  }

  /** Whether it is raining hard enough to shelter (hysteresis: `INTERACTIONS.rainOn`/`rainOff`). */
  get raining(): boolean {
    return this.wet;
  }

  /** Whether this person is caught in sheltering weather with no umbrella over the group. */
  caught(m: Mover): boolean {
    return this.wet && m.kind === 'person' && exposed(m.group, this.rain);
  }

  /** A caught person's dash pace, or undefined when the group stays dry. */
  dashPace(m: Mover): number | undefined {
    return this.caught(m) ? runPace(m, RUN.dash, this.perMeter) : undefined;
  }

  /** Exposed people run on scene approaches and returns while it rains; everyone else walks. */
  private pace(m: Mover, visit: Visit): number {
    return visit.state === 'approach' || visit.state === 'return'
      ? (this.dashPace(m) ?? m.speed)
      : m.speed;
  }

  private move(
    m: Mover,
    visit: Visit,
    dt: number,
    guard?: MoveGuard,
    walkLimit?: (m: Mover, target: { x: number; y: number }, distance: number) => number,
    owns?: (p: WalkPoint) => boolean,
  ) {
    if (guard?.passing?.(m)) this.clearBypass(m);
    if (this.yieldStep(m, dt, guard, walkLimit, owns)) {
      if (!this.yieldHeld.has(m)) {
        visit.blocked += dt;
        this.blockedTimeout(m, visit);
      }
      return false;
    }
    const before = guard && isWalker(m.kind) ? snapshotMover(m) : undefined;
    const next = visit.next;
    const bypassBefore = visit.bypass;
    let progressCorner: WalkPoint | undefined;
    const trailLength = visit.trail.length;
    let left = this.pace(m, visit) * dt;
    let held = false;
    while (left > 0 && visit.next < visit.path.length) {
      const target = visit.path[visit.next]!;
      const d = dist(m, target);
      // Duplicate route attachments and round-off at the return anchor need no
      // footprint movement or heading change. Substantive moves remain guarded.
      if (d <= 1e-8 * this.perMeter) {
        if (visit.progress?.target === target) progressCorner = target;
        if (visit.bypass?.target === target) delete visit.bypass;
        visit.next++;
        continue;
      }
      const dx = (target.x - m.x) / d;
      const dy = (target.y - m.y) / d;
      let step = Math.min(d, left);
      if (isWalker(m.kind) && walkLimit) step = walkLimit(m, target, step);
      if (step <= 0 && d > 0.001) {
        held = true;
        break;
      }
      if (d > 0.001 && visit.bypass?.side !== target && visit.bypass?.retreat !== target) {
        faceGroup(m, (target.x - m.x) / d, (target.y - m.y) / d);
      }
      m.x += dx * step;
      m.y += dy * step;
      m.walked = (m.walked ?? 0) + step / this.perMeter;
      left -= step;
      if (step >= d) {
        if (visit.progress?.target === target) progressCorner = target;
        m.x = target.x;
        m.y = target.y;
        if (visit.state !== 'return') visit.trail.push({ ...target });
        if (visit.bypass?.target === target) delete visit.bypass;
        visit.next++;
      } else break;
    }
    const changed =
      before && (m.x !== before.x || m.y !== before.y || m.hx !== before.hx || m.hy !== before.hy);
    if (changed && guard && !guard(m, before)) {
      if (!visit.progress) {
        const target = visit.path[next]!,
          length = dist(before, target);
        if (length > 1e-8 * this.perMeter)
          visit.progress = {
            x: before.x,
            y: before.y,
            hx: (target.x - before.x) / length,
            hy: (target.y - before.y) / length,
            target,
          };
      }
      const trial = snapshotMover(m);
      const trialNext = visit.next;
      const trialBypass = visit.bypass;
      const addedTrail = visit.trail.slice(trailLength);
      restoreMover(m, before);
      visit.next = next;
      visit.trail.length = trailLength;
      visit.bypass = bypassBefore;
      if (dist(before, trial) > 1e-8 * this.perMeter) guard.contact?.(m, trial);
      // A pedestrian can take a checked backward/sideways step when a heading
      // change has too little room. Keep the member frame and the exact route
      // progress; this is bounded by the same speed and swept physical guard.
      if (
        Math.hypot(trial.x - before.x, trial.y - before.y) > 1e-8 * this.perMeter &&
        Math.hypot(trial.hx - before.hx, trial.hy - before.hy) > 1e-8
      ) {
        restoreMover(m, trial);
        faceGroup(m, before.hx, before.hy);
        if (guard(m, before)) {
          visit.next = trialNext;
          visit.trail.push(...addedTrail);
          visit.bypass = trialBypass;
          this.acceptedProgress(m, visit, before, progressCorner);
          this.blockedProgress(m, visit, dt);
          return visit.next >= visit.path.length;
        }
        restoreMover(m, before);
      }
      // Scene paths need the same opportunity to pass an oncoming walker as ordinary
      // routes. A signal-held zero step never detours. Every trial keeps the route
      // cursor and is checked through the production swept footprint guard.
      const dx = trial.x - before.x,
        dy = trial.y - before.y;
      if (Math.hypot(dx, dy) > 1e-8 && !visit.bypass && !guard.passing?.(m)) {
        const a = visit.path[Math.max(0, next - 1)]!,
          b = visit.path[next]!;
        const vx = b.x - a.x,
          vy = b.y - a.y;
        const length = vx * vx + vy * vy;
        const preferred = visit.sidestep ?? 1;
        for (const [side, share] of [
          [preferred, 0.5],
          [preferred, 0],
          [preferred, -1],
          [-preferred, 0.5],
          [-preferred, 0],
          [-preferred, -1],
        ] as const) {
          const forward = Math.hypot(dx, dy) * share;
          const lateral =
            (share < 0 ? 0 : side) *
            Math.min(
              1.5 * dt * this.perMeter,
              Math.sqrt(Math.max(0, (m.speed * dt) ** 2 - forward ** 2)),
            );
          restoreMover(m, before);
          m.x += dx * share - trial.hy * lateral;
          m.y += dy * share + trial.hx * lateral;
          faceGroup(m, share < 0 ? before.hx : trial.hx, share < 0 ? before.hy : trial.hy);
          const t = length
            ? Math.max(0, Math.min(1, ((m.x - a.x) * vx + (m.y - a.y) * vy) / length))
            : 0;
          if (
            Math.hypot(m.x - a.x - t * vx, m.y - a.y - t * vy) >
            RECOVERY.bypassReachM * this.perMeter
          )
            continue;
          m.walked = (before.walked ?? 0) + dist(before, m) / this.perMeter;
          if (this.graph.clear(before, m) && guard(m, before)) {
            visit.sidestep = side as 1 | -1;
            const span = Math.min(dist(before, b), RECOVERY.bypassSpanM * this.perMeter);
            const retreatDistance = Math.min(
              RECOVERY.bypassRetreatMaxM,
              Math.max(
                RECOVERY.bypassRetreatMinM,
                ...(m.group ?? []).map(
                  (w) => Math.abs(w.back) + memberSize(w.figure).length / 2 + 0.15,
                ),
              ),
            );
            const retreat =
              share < 0
                ? {
                    x: before.x - trial.hx * retreatDistance * this.perMeter,
                    y: before.y - trial.hy * retreatDistance * this.perMeter,
                  }
                : undefined;
            for (const offset of RECOVERY.bypassOffsets) {
              const base = retreat ?? { x: before.x + dx * share, y: before.y + dy * share };
              const sidePoint = {
                x: base.x - trial.hy * side * offset * this.perMeter,
                y: base.y + trial.hx * side * offset * this.perMeter,
              };
              const target = {
                x: sidePoint.x + trial.hx * span,
                y: sidePoint.y + trial.hy * span,
              };
              if (
                !inTile(target) ||
                (retreat && !this.graph.clear(m, retreat)) ||
                !this.graph.clear(retreat ?? m, sidePoint) ||
                !this.graph.clear(sidePoint, target) ||
                !this.graph.allowsBodies(this.walkingBodies(m, sidePoint, 0, true), true) ||
                !this.graph.allowsBodies(this.walkingBodies(m, target, 0, true), true)
              )
                continue;
              const accepted = snapshotMover(m);
              let previous = accepted,
                safe = true;
              for (const point of [...(retreat ? [retreat] : []), sidePoint, target]) {
                m.x = point.x;
                m.y = point.y;
                if (point === target) faceGroup(m, trial.hx, trial.hy);
                const bodies = this.walkingBodies(m, m, 0, true);
                if (
                  !inTile(m) ||
                  (owns && !owns(m)) ||
                  !bodies.every((body) => inTile(body) && (!owns || owns(body))) ||
                  !guard(m, previous, false)
                ) {
                  safe = false;
                  break;
                }
                previous = snapshotMover(m);
              }
              restoreMover(m, accepted);
              if (!safe) continue;
              visit.path.splice(next, 0, ...(retreat ? [retreat] : []), sidePoint, target);
              visit.bypass = {
                target,
                side: sidePoint,
                retreat,
                start: { x: before.x, y: before.y },
                hx: trial.hx,
                hy: trial.hy,
                progress: 0,
              };
              break;
            }
            this.blockedProgress(m, visit, dt);
            if (visit.state !== 'return') visit.trail.push({ x: m.x, y: m.y });
            return false;
          }
        }
        restoreMover(m, before);
      }
      visit.blocked += dt;
      this.blockedTimeout(m, visit);
      return false;
    }
    if (held && !changed) return false;
    if (before) this.acceptedProgress(m, visit, before, progressCorner);
    const bypass = visit.bypass;
    if (bypass) {
      const progress = (m.x - bypass.start.x) * bypass.hx + (m.y - bypass.start.y) * bypass.hy;
      if (progress > bypass.progress + 1e-8 * this.perMeter) {
        bypass.progress = progress;
        this.blockedProgress(m, visit, dt);
      } else {
        visit.blocked += dt;
        this.blockedTimeout(m, visit);
      }
    } else if (visit.progress) this.blockedProgress(m, visit, dt);
    else visit.blocked = 0;
    if (visit.returnPending && this.canIdle(m)) {
      this.returning(m, visit);
      return false;
    }
    return visit.next >= visit.path.length;
  }

  private blockedProgress(m: Mover, visit: Visit, dt: number) {
    const p = visit.progress;
    if (!p) {
      visit.blocked = 0;
      return;
    }
    if (p && (m.x - p.x) * p.hx + (m.y - p.y) * p.hy >= 0.5 * this.perMeter) {
      visit.blocked = 0;
      delete visit.progress;
      delete visit.retryAt;
    } else {
      visit.blocked += dt;
      this.blockedTimeout(m, visit);
    }
  }

  /** Rebase only after accepted mapped travel, preserving the episode and retry cadence. */
  private acceptedProgress(m: Mover, visit: Visit, before: Mover, corner?: WalkPoint) {
    const p = visit.progress;
    if (!p || visit.bypass || dist(m, before) <= 1e-8 * this.perMeter) return;
    const target = visit.path[visit.next];
    if (corner && target) {
      const d = dist(corner, target);
      if (d > 1e-8 * this.perMeter) {
        p.x = corner.x;
        p.y = corner.y;
        p.hx = (target.x - corner.x) / d;
        p.hy = (target.y - corner.y) / d;
        p.target = target;
        delete p.intent;
      }
    } else if (p.intent && (m.x - before.x) * p.intent.hx + (m.y - before.y) * p.intent.hy > 0) {
      p.x = before.x;
      p.y = before.y;
      p.hx = p.intent.hx;
      p.hy = p.intent.hy;
      delete p.intent;
    }
  }

  private blockedTimeout(m: Mover, visit: Visit) {
    if (visit.blocked >= RECOVERY.visitReturnSeconds && visit.state !== 'return') {
      if (!visit.returnPending) this.requestReturn(m, visit);
    } else if (
      visit.blocked >= (visit.retryAt ?? RECOVERY.returnReplanSeconds) &&
      visit.state === 'return'
    ) {
      const path = this.route(m, visit.trail[0]!);
      if (path?.every(inTile)) {
        const target = path[1],
          oldTarget = visit.path[visit.next],
          p = visit.progress;
        if (target && p) {
          const d = dist(m, target);
          if (
            d > 1e-8 * this.perMeter &&
            (!oldTarget || dist(target, oldTarget) > 1e-8 * this.perMeter)
          )
            p.intent = { hx: (target.x - m.x) / d, hy: (target.y - m.y) / d };
          p.target = target;
        }
        visit.path = path;
        visit.next = 1;
        delete visit.bypass;
      }
      visit.retryAt = visit.blocked + RECOVERY.returnReplanSeconds;
    }
  }

  /** A negotiated passing actor resumes its retained route, without a pose jump. */
  clearBypass(m: Mover) {
    const visit = this.visits.get(m),
      bypass = visit?.bypass;
    if (!visit || !bypass) return;
    const rest = visit.path
      .slice(visit.next)
      .filter(
        (point) => point !== bypass.target && point !== bypass.side && point !== bypass.retreat,
      );
    visit.path.splice(visit.next, visit.path.length - visit.next, ...rest);
    delete visit.bypass;
  }

  travelHeading(m: Mover, retained = false) {
    const target = this.travelPath(m, retained)?.find(
      (point) => dist(m, point) > 1e-8 * this.perMeter,
    );
    const d = target && dist(m, target);
    return target && d && d > 1e-8 * this.perMeter
      ? { hx: (target.x - m.x) / d, hy: (target.y - m.y) / d }
      : { hx: m.hx, hy: m.hy };
  }

  /** Remaining mapped visit path, optionally excluding temporary bypass points. */
  travelPath(m: Mover, retained = false) {
    const visit = this.visits.get(m),
      bypass = visit?.bypass;
    return visit?.path
      .slice(visit.next)
      .filter(
        (point) =>
          !retained ||
          !bypass ||
          (point !== bypass.side && point !== bypass.retreat && point !== bypass.target),
      );
  }

  /** Checked temporary holding paths retain navigation, visit anchors and reservations. */
  yieldStep(
    m: Mover,
    dt: number,
    guard?: MoveGuard,
    walkLimit?: (m: Mover, target: WalkPoint, distance: number) => number,
    owns?: (p: WalkPoint) => boolean,
  ): boolean {
    if (!guard || !isWalker(m.kind)) return false;
    if (dt <= 0) return this.yielding.has(m);
    this.yieldHeld.delete(m);
    let priority = guard.yielding?.(m);
    let state = this.yielding.get(m);
    if (!state && !priority) return false;
    if (
      state &&
      priority &&
      !state.returning &&
      state.next >= state.path.length &&
      guard.holding &&
      !guard.holding(m, true)
    ) {
      // A retained visitor can replan while its counterpart is already holding.
      // Withdraw the old decision through the checked return path before retrying.
      guard.cancelYield?.(m);
      priority = undefined;
    }
    const physicalPoint = (pose: Mover) => {
      const lane = this.visits.has(m) ? 0 : (pose.avoid ?? 0);
      return {
        x: pose.x - pose.hy * lane * this.perMeter,
        y: pose.y + pose.hx * lane * this.perMeter,
      };
    };
    if (!state) {
      const anchor = snapshotMover(m);
      const heading = this.travelHeading(m, true);
      const lane = this.visits.has(m) ? 0 : (m.avoid ?? 0);
      const admissible = (previous: Mover, target: WalkPoint) => {
        m.x = target.x;
        m.y = target.y;
        // Holding translations preserve physical facing. The swept guard proves
        // every actual footprint; an all-heading square would reject narrow curbs.
        const bodies = this.walkingBodies(m, m, lane);
        return (
          inTile(m) &&
          (!owns || owns(m)) &&
          bodies.every((body) => inTile(body) && (!owns || owns(body))) &&
          this.graph.allowsBodies(bodies, true) &&
          this.graph.clear(physicalPoint(previous), physicalPoint(m)) &&
          (!guard.holdingCorridor || guard.holdingCorridor(m, previous)) &&
          guard(m, previous, false)
        );
      };
      for (const direct of [false, true]) {
        for (const retreat of RECOVERY.retreats) {
          for (const side of [1, -1]) {
            for (const offset of RECOVERY.holdingOffsets) {
              restoreMover(m, anchor);
              const back = {
                x: anchor.x - heading.hx * retreat * this.perMeter,
                y: anchor.y - heading.hy * retreat * this.perMeter,
              };
              if (!direct && retreat !== 0 && !admissible(anchor, back)) continue;
              const previous = snapshotMover(m);
              const holding = {
                x: back.x - heading.hy * side * offset * this.perMeter,
                y: back.y + heading.hx * side * offset * this.perMeter,
              };
              if (
                !admissible(previous, holding) ||
                (guard.holding && !guard.holding(m)) ||
                !this.graph.route(physicalPoint(anchor), physicalPoint(m))
              )
                continue;
              state = {
                anchor,
                path: direct ? [holding] : [back, holding],
                next: 0,
                returning: false,
                seconds: 0,
                returnBlocked: 0,
              };
              break;
            }
            if (state) break;
          }
          if (state) break;
        }
        if (state) break;
      }
      restoreMover(m, anchor);
      if (!state) {
        guard.cancelYield?.(m);
        return false;
      }
      this.yielding.set(m, state);
    }
    if (priority && !state.returning) {
      state.seconds += dt;
      if (state.seconds >= RECOVERY.yieldSeconds - 1e-9) {
        guard.cancelYield?.(m);
        priority = undefined;
      }
    }
    if (!priority && !state.returning) {
      state.path = [
        ...state.path.slice(0, state.next).reverse(),
        { x: state.anchor.x, y: state.anchor.y },
      ];
      state.next = 0;
      state.returning = true;
      state.returnDistance = dist(m, state.anchor);
    }
    if (state.next >= state.path.length) {
      if (state.returning) {
        const walked = m.walked;
        restoreMover(m, state.anchor);
        m.walked = walked;
        this.yielding.delete(m);
      }
      return true;
    }
    const target = state.path[state.next]!,
      d = dist(m, target);
    if (d <= 1e-8 * this.perMeter) {
      state.next++;
      return true;
    }
    const previous = snapshotMover(m);
    const requested = Math.min(d, m.speed * dt);
    const step = walkLimit ? walkLimit(m, target, requested) : requested;
    if (requested > 0 && step <= 0) this.yieldHeld.add(m);
    if (d > 1e-8 * this.perMeter && step > 0) {
      m.x += ((target.x - m.x) * step) / d;
      m.y += ((target.y - m.y) * step) / d;
      m.walked = (m.walked ?? 0) + step / this.perMeter;
    }
    const bodies = this.walkingBodies(m, m, this.visits.has(m) ? 0 : (m.avoid ?? 0));
    if (
      !inTile(m) ||
      (owns && !owns(m)) ||
      !bodies.every((body) => inTile(body) && (!owns || owns(body))) ||
      !this.graph.clear(physicalPoint(previous), physicalPoint(m)) ||
      (guard.holdingCorridor && !guard.holdingCorridor(m, previous)) ||
      !guard(m, previous)
    ) {
      restoreMover(m, previous);
      if (state.returning && !this.yieldHeld.has(m)) {
        state.returnBlocked += dt;
        if (state.returnBlocked >= (state.returnRetry ?? RECOVERY.returnReplanSeconds)) {
          state.returnRetry = state.returnBlocked + RECOVERY.returnReplanSeconds;
          if (this.resumeYield(m, state.anchor, guard, owns)) {
            this.yielding.delete(m);
            guard.cancelYield?.(m);
            return false;
          }
        }
      }
      return true;
    }
    if (
      state.returning &&
      (state.returnDistance ?? Infinity) - dist(m, state.anchor) >= 0.5 * this.perMeter
    ) {
      state.returnBlocked = 0;
      state.returnDistance = dist(m, state.anchor);
      delete state.returnRetry;
    }
    if (step >= d) state.next++;
    return true;
  }

  /** Hand movement back from a blocked temporary return without changing its physical pose. */
  private resumeYield(m: Mover, anchor: Mover, guard: MoveGuard, owns?: (p: WalkPoint) => boolean) {
    const visit = this.visits.get(m);
    if (visit) {
      const destination = visit.path.at(-1);
      const path = destination && this.route(m, destination);
      if (!path || !path.every((p) => inTile(p) && (!owns || owns(p)))) return false;
      // The original trail and site reservation remain owned by the existing visit.
      visit.path = path;
      visit.next = 1;
      delete visit.bypass;
      if (visit.progress) {
        const target = path[1],
          d = target && dist(m, target);
        if (target && d && d > 1e-8 * this.perMeter) {
          visit.progress.target = target;
          visit.progress.intent = { hx: (target.x - m.x) / d, hy: (target.y - m.y) / d };
        }
      }
      return true;
    }
    const before = snapshotMover(m),
      heading = m.momentFacing ?? m;
    const point = {
      x: m.x - m.hy * (m.avoid ?? 0) * this.perMeter,
      y: m.y + m.hx * (m.avoid ?? 0) * this.perMeter,
    };
    let best:
      | { from: number; d: number; x: number; y: number; hx: number; hy: number; offset: number }
      | undefined;
    let nearest = Infinity;
    for (let v = this.geo.starts[anchor.line]!; v < this.geo.starts[anchor.line + 1]! - 1; v++) {
      const from = anchor.dir === 1 ? v : v + 1,
        to = from + anchor.dir,
        ax = this.geo.coords[from * 2]!,
        ay = this.geo.coords[from * 2 + 1]!,
        dx = this.geo.coords[to * 2]! - ax,
        dy = this.geo.coords[to * 2 + 1]! - ay,
        length = Math.hypot(dx, dy);
      if (!length) continue;
      const d = ((point.x - ax) * dx + (point.y - ay) * dy) / length;
      if (d < 0 || d > length) continue;
      const hx = dx / length,
        hy = dy / length,
        x = ax + hx * d,
        y = ay + hy * d,
        offset = -(point.x - x) * hy + (point.y - y) * hx;
      if (Math.abs(offset) >= nearest) continue;
      nearest = Math.abs(offset);
      best = { from, d, x, y, hx, hy, offset };
    }
    if (!best) return false;
    m.line = anchor.line;
    m.dir = anchor.dir;
    m.from = best.from;
    m.d = best.d;
    m.x = best.x;
    m.y = best.y;
    m.avoid = best.offset / this.perMeter;
    faceGroup(m, best.hx, best.hy, heading);
    if (
      (!owns || owns(m)) &&
      this.graph.allowsBodies(this.walkingBodies(m, m, m.avoid), true) &&
      guard(m, before, false)
    )
      return true;
    restoreMover(m, before);
    return false;
  }

  /** Release the scene at its mapped anchor, checking the ordinary walking pose. */
  private finishReturn(
    m: Mover,
    anchor: WalkPoint,
    guard?: MoveGuard,
    owns?: (p: WalkPoint) => boolean,
  ) {
    const previous = snapshotMover(m),
      physical = snapshotMover(m),
      heading = m.momentFacing ?? { hx: m.hx, hy: m.hy },
      end = m.from + m.dir,
      ax = this.geo.coords[m.from * 2]!,
      ay = this.geo.coords[m.from * 2 + 1]!,
      dx = this.geo.coords[end * 2]! - ax,
      dy = this.geo.coords[end * 2 + 1]! - ay,
      length = Math.hypot(dx, dy);
    if (!length) return false;
    const hx = dx / length,
      hy = dy / length,
      d = (anchor.x - ax) * hx + (anchor.y - ay) * hy;
    if (d < 0 || d > length) return false;
    // Scene movement ignores the retained ordinary lane offset. The guard must
    // compare against that same physical pose while evaluating ordinary walking.
    physical.avoid = 0;
    this.returningToRoute = m;
    try {
      for (const retainFacing of [false, true]) {
        restoreMover(m, previous);
        m.d = d;
        m.x = ax + hx * d;
        m.y = ay + hy * d;
        m.avoid =
          (-(previous.x - m.x) * hy) / this.perMeter + ((previous.y - m.y) * hx) / this.perMeter;
        if (retainFacing) {
          m.hx = hx;
          m.hy = hy;
          m.momentFacing = { hx: heading.hx, hy: heading.hy };
        } else faceGroup(m, hx, hy);
        const unchanged =
          Math.hypot(previous.x - m.x, previous.y - m.y) <= 1e-8 * this.perMeter &&
          Math.hypot(heading.hx - hx, heading.hy - hy) <= 1e-8;
        if (unchanged) return true;
        if (
          inTile(m) &&
          (!owns || owns(m)) &&
          this.graph.allowsBodies(this.walkingBodies(m, m, m.avoid), true) &&
          (!guard || guard(m, physical))
        )
          return true;
      }
    } finally {
      this.returningToRoute = undefined;
    }
    restoreMover(m, previous);
    return false;
  }

  step(
    dt: number,
    movers: readonly Mover[],
    env: {
      rain?: number;
      levels?: Activity;
      minutes?: number;
      cityLife?: Pick<CityLifeConfig, 'schedules'>;
    },
    near?: (x: number, y: number) => boolean,
    shows?: (kind: Mover['kind']) => boolean,
    guard?: MoveGuard,
    vehicleOffset?: (mover: Mover) => number,
    walkLimit?: (m: Mover, target: { x: number; y: number }, distance: number) => number,
    owns?: (p: { x: number; y: number }) => boolean,
    inspecting?: object,
    diagnostics?: LifeDiagnostics,
  ) {
    const rain = env.rain ?? 0;
    this.rain = rain;
    this.speechEvents.length = 0;
    this.purchaseCompletions.length = 0;
    this.wet = this.wet ? rain > INTERACTIONS.rainOff : rain >= INTERACTIONS.rainOn;
    const minutes = env.minutes === undefined ? -1 : Math.floor(env.minutes);
    const hoursChanged =
      minutes !== this.minutes || env.cityLife !== this.cityLife || this.hoursDirty;
    this.hoursDirty = false;
    this.minutes = minutes;
    this.cityLife = env.cityLife;
    for (const site of this.sites)
      if (site.stall && site.kind === 'vendor') {
        if (owns && !owns(site)) {
          this.hoursDirty = true;
          continue;
        }
        site.stall.covered = this.wet;
        if (hoursChanged || site.stall.open === undefined)
          site.stall.open =
            env.minutes === undefined ||
            shopOpen(
              shopHours(Math.floor(site.stall.rank * 0xffffffff), env.cityLife),
              env.minutes,
            );
      }
    for (const [m, seconds] of this.cooldown) {
      if (inspecting === m) continue;
      if (owns && !owns(m)) continue;
      if (seconds <= dt) this.cooldown.delete(m);
      else this.cooldown.set(m, seconds - dt);
    }
    for (const [m, visit] of this.visits) {
      if (inspecting === m) continue;
      if (this.returnAfterInspection?.delete(m)) this.requestReturn(m, visit);
      if (owns && !owns(m)) continue;
      if ((shows && !shows(m.kind)) || (near && !near(m.x, m.y))) continue;
      diagnostics?.eligible(m, m.kind);
      if (visit.state !== 'approach' && visit.state !== 'return') diagnostics?.hold(m, 'visit');
      if (visit.state === 'return' && visit.blocked > 0) diagnostics?.tag(m, 'blockedReturn');
      const { kind } = visit.site;
      if (
        visit.state !== 'return' &&
        ((env.levels && m.rank >= env.levels[m.kind]) ||
          (this.wet && (kind === 'vendor' || kind === 'rest')) ||
          (kind === 'vendor' && visit.site.stall?.open === false) ||
          (!this.wet && visit.sheltering))
      )
        this.requestReturn(m, visit);
      if (visit.returnPending && this.canIdle(m)) this.returning(m, visit);
      if (visit.state === 'approach' || visit.state === 'return' || visit.state === 'board') {
        if (!this.move(m, visit, dt, guard, walkLimit, owns)) continue;
        if (visit.state === 'return') {
          if (!this.finishReturn(m, visit.trail[0]!, guard, owns)) continue;
          m.pause = 0;
          m.lying = false;
          this.visits.delete(m);
          this.cooldown.set(m, 20 + this.rng() * 20);
        } else if (visit.state === 'board') {
          visit.state = 'aboard';
          visit.time = 3;
          m.pause = 1;
        } else {
          const before = snapshotMover(m);
          visit.state = visit.sheltering ? 'shelter' : visit.site.kind === 'rest' ? 'rest' : 'wait';
          visit.time = visit.state === 'rest' ? 30 + this.rng() * 60 : 60 + this.rng() * 30;
          faceGroup(m, visit.site.hx, visit.site.hy);
          m.pause = 1;
          m.lying = m.kind === 'dog';
          if (isWalker(m.kind) && (!this.canIdle(m) || (guard && !guard(m, before)))) {
            restoreMover(m, before);
            this.returning(m, visit);
          }
          if (visit.state === 'wait' || visit.state === 'shelter')
            this.speechEvent(visit.state, m, visit);
        }
        continue;
      }
      visit.time -= dt;
      if (
        visit.state === 'wait' &&
        visit.site.kind === 'vendor' &&
        (owns ? visit.site.queue.find(owns) : visit.site.queue[0]) === m
      ) {
        visit.state = 'purchase';
        visit.time = between(this.rng, INTERACTIONS.purchase);
        this.speechEvent('purchase', m, visit);
      } else if (visit.time <= 0 && visit.state !== 'shelter') {
        if (
          visit.state === 'purchase' &&
          !visit.returnPending &&
          visit.site.stall &&
          this.purchaseCompletions.length < 8
        )
          this.purchaseCompletions.push({ mover: m, stall: visit.site.stall, key: {} });
        // Shelter lasts until the rain stops; everything else has its time.
        this.returning(m, visit);
      }
    }
    for (const [m, service] of this.services) {
      if (inspecting === m) continue;
      if (owns && !owns(m)) continue;
      if ((shows && !shows('vehicle')) || (near && !near(m.x, m.y))) continue;
      if (service.arriving) {
        // A stop left behind (past a bend, or on another line) can no longer be reached.
        if (m.line !== service.site.road || ahead(service.site, m) < -0.8 * this.perMeter) {
          this.services.delete(m);
          this.stopCooldown.set(m, service.site);
          continue;
        }
        if (
          [...this.services].some(
            ([owner, s]) =>
              s !== service && s.site === service.site && !s.arriving && (!owns || owns(owner)),
          )
        )
          continue;
        if (Math.abs(ahead(service.site, m)) > 0.8 * this.perMeter) continue;
        if ((m.v ?? 0) > INTERACTIONS.arrivalSpeed * this.perMeter) continue;
        service.arriving = false;
        for (const person of service.site.queue) {
          const visit = this.visits.get(person);
          if (visit?.state === 'wait') this.speechEvent('arrival', person, visit);
        }
        m.pause = service.time;
      }
      service.time -= dt;
      if (service.passenger && this.visits.get(service.passenger)?.state !== 'board')
        service.passenger = undefined;
      const person =
        !service.passenger &&
        service.site.queue.find(
          (p) => inspecting !== p && (!owns || owns(p)) && this.visits.get(p)?.state === 'wait',
        );
      if (person && service.time < 12 - service.boarded * 2) {
        const visit = this.visits.get(person)!;
        const width = VEHICLES[m.vehicle!].width;
        // The curb door, outside the vehicle body, approached on the walking graph.
        // A diagonal adult reaches farther than half its width. Leave the full
        // rotating footprint and collision gap outside the stopped vehicle.
        const clearance = Math.max(
          0.75,
          ...(person.group ?? []).map((w) => {
            const size = memberSize(w.figure);
            return Math.hypot(w.lateral, w.back) + Math.hypot(size.length, size.width) / 2 + 0.17;
          }),
        );
        const right =
          Math.max(
            (vehicleOffset?.(m) ?? Math.max(0, service.site.roadWidth / 2 - width / 2 - 0.2)) +
              width / 2,
            service.site.roadWidth / 2,
          ) + clearance;
        const door = {
          x: m.x - m.hy * right * this.perMeter,
          y: m.y + m.hx * right * this.perMeter,
        };
        const path = this.route(person, door);
        if (path) {
          visit.state = 'board';
          visit.path = path;
          visit.next = 1;
          person.pause = 0;
          service.site.queue = service.site.queue.filter((p) => p !== person);
          service.boarded++;
          service.passenger = person;
        }
      }
      if (service.time <= 0) {
        const passenger = service.passenger && this.visits.get(service.passenger);
        if (passenger?.state === 'board') {
          if (inspecting === service.passenger)
            (this.returnAfterInspection ??= new WeakSet()).add(service.passenger!);
          else this.returning(service.passenger!, passenger);
        }
        this.services.delete(m);
        this.stopCooldown.set(m, service.site);
        m.pause = 0;
      }
    }
    // Spread site searches over frames rather than scanning the whole tile on one beat.
    this.scan += dt * movers.length;
    const batch = Math.min(12, Math.floor(this.scan));
    this.scan = Math.min(12, this.scan - batch);
    for (let i = 0; i < batch && movers.length; i++) {
      const m = movers[this.cursor++ % movers.length]!;
      if (
        inspecting === m ||
        (owns && !owns(m)) ||
        (shows && !shows(m.kind)) ||
        (near && !near(m.x, m.y)) ||
        (env.levels && m.rank >= env.levels[m.kind])
      )
        continue;
      if (m.kind === 'vehicle' && m.vehicle) {
        const modes = TRANSIT_BITS[m.vehicle as keyof typeof TRANSIT_BITS] ?? 0;
        if (!modes || this.services.has(m)) continue;
        const previous = this.stopCooldown.get(m);
        if (previous && dist(m, previous) > 40 * this.perMeter) this.stopCooldown.delete(m);
        const velocity = m.v ?? 0;
        const brakingRoom = stoppingReach(
          velocity,
          kinematicsOf(m.vehicle).brake * this.perMeter,
          0,
          velocity * dt,
        );
        for (const site of this.sites) {
          if (
            (owns && !owns(site)) ||
            site === previous ||
            !(site.modes & modes) ||
            site.road !== m.line ||
            site.direction !== m.dir ||
            dist(m, site) >
              Math.max(15 * this.perMeter, brakingRoom + INTERACTIONS.stopPad * this.perMeter) ||
            ahead(site, m) < brakingRoom
          )
            continue;
          const services = [...this.services].filter(
            ([owner, s]) => s.site === site && (!owns || owns(owner)),
          );
          if (services.length >= (site.kind === 'terminal' ? INTERACTIONS.terminalQueue : 1))
            continue;
          this.services.set(m, {
            site,
            arriving: true,
            time: between(this.rng, INTERACTIONS.dwell),
            boarded: 0,
          });
          break;
        }
      } else if (
        (m.kind === 'person' || m.kind === 'dog' || m.kind === 'cat') &&
        !this.visits.has(m) &&
        !this.cooldown.has(m)
      ) {
        // Those caught with no umbrella look further for cover, and are surer to go.
        const caught = this.caught(m);
        const reach = caught ? RUN.shelter.reach : INTERACTIONS.reach;
        const candidates = this.sites
          .map((site, index) => ({ site, index, d: dist(m, site) }))
          .filter(
            ({ site, d }) =>
              (!owns || owns(site)) &&
              d < reach * this.perMeter &&
              (this.wet
                ? site.covered
                : m.kind === 'person'
                  ? ['vendor', 'stop', 'terminal'].includes(site.kind)
                  : site.kind === 'rest') &&
              (!site.stall ||
                (site.stall.open !== false &&
                  (!env.levels || site.stall.rank < env.levels.person))),
          )
          .sort((a, b) => a.d - b.d)
          .slice(0, 3);
        if (
          this.rng() <
          (caught
            ? RUN.shelter.chance
            : this.wet
              ? INTERACTIONS.shelterChance
              : INTERACTIONS.visitChance)
        ) {
          const reserved = candidates.some(({ index }) => this.reserve(m, index));
          if (caught && candidates.length > 0 && !reserved) this.cooldown.set(m, RUN.shelter.retry);
        }
      }
    }
  }

  speed(m: Mover, dt: number): number {
    const service = this.services.get(m);
    if (!service) return m.speed;
    if (!service.arriving) return 0;
    return Math.min(m.speed, Math.max(0, ahead(service.site, m)) / Math.max(dt, 0.001));
  }

  held(m: Mover): boolean {
    return this.services.has(m) && !this.services.get(m)!.arriving;
  }
  limit(m: Mover, dt: number, brake: number, out: MotionLimit): void {
    const service = this.services.get(m);
    if (!service) return;
    const distance = service.arriving ? Math.max(0, ahead(service.site, m)) : 0;
    out.target = Math.min(out.target, stopBefore(distance, 0, brake, 0, brake * dt * dt));
    out.cap = Math.min(out.cap, distance / Math.max(dt, 0.001));
  }
  walkable(from: WalkPoint, to: WalkPoint): boolean {
    return this.graph.clear(from, to);
  }
  offset(m: Mover, normal: number, curb: number, pose = m): number {
    return this.offsetAt(m, pose, normal, curb);
  }
  curbSite(m: Mover): WalkPoint | undefined {
    return this.services.get(m)?.site ?? this.stopCooldown.get(m);
  }
  /** Evaluate a future pose without substituting a copy for the service owner. */
  offsetAt(m: Mover, at: WalkPoint, normal: number, curb: number): number {
    const site = this.curbSite(m);
    if (!site) return normal;
    const blend = Math.max(0, 1 - dist(at, site) / (INTERACTIONS.curbBlend * this.perMeter));
    return normal + (curb - normal) * blend;
  }
  get hasCurbScenes(): boolean {
    return this.services.size > 0 || this.stopCooldown.size > 0;
  }
  merging(m: Mover): boolean {
    const site = this.curbSite(m);
    return !!site && dist(m, site) < INTERACTIONS.curbBlend * this.perMeter;
  }
  hidden(m: Mover): boolean {
    return this.visits.get(m)?.state === 'aboard';
  }
  still(m: Mover): boolean {
    const state = this.visits.get(m)?.state;
    return !!state && state !== 'approach' && state !== 'return' && state !== 'board';
  }
}
