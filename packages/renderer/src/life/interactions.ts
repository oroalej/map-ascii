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
import { isWalker, usableLines, type Activity } from './config';
import { animalSize, memberSize } from './occupancy';
import type { Mover, Stall } from './simulate';
import { approach, type MotionLimit } from './motion';
import { complete } from './cooperate';
import type { LifeDiagnostics } from './diagnostics';

export const INTERACTIONS = {
  stopQueue: 6,
  vendorQueue: 4,
  terminalQueue: 3,
  /** Seconds a vehicle serves a stop, and a customer spends at a stall. */
  dwell: [8, 15],
  purchase: [3, 6],
  rainOn: 0.5,
  rainOff: 0.2,
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
type MoveGuard = (mover: Mover, before: Mover) => boolean;
const dist = (a: WalkPoint, b: WalkPoint) => Math.hypot(a.x - b.x, a.y - b.y);
/** How far `p` lies ahead of a mover along its heading (negative: behind it). */
const ahead = (p: WalkPoint, m: Mover) => (p.x - m.x) * m.hx + (p.y - m.y) * m.hy;

/** Reservations and small local scenes, using the tile's existing inhabitants. */
export class LocalScenes {
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
  private readonly stopCooldown = new Map<Mover, Site>();
  private wet = false;
  private scan = 0;
  private cursor = 0;
  private minutes = -1;
  private hoursDirty = false;
  private cityLife: CityLifeConfig | undefined;

  constructor(
    geo: LifeGeometry,
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
    if (this.busy?.(m) || this.services.has(m) || this.visits.has(m)) return false;
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
    if (!site || this.visits.has(m) || this.busy?.(m) || (isWalker(m.kind) && !this.canIdle(m)))
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
    const path = this.graph.route(m, point);
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
    visit.blocked = 0;
    visit.returnPending = false;
    m.pause = 0;
    m.lying = false;
  }

  private canIdle(m: Mover): boolean {
    if (this.idleGuard) return this.idleGuard(m);
    const lane = this.visits.has(m) ? 0 : (m.avoid ?? 0);
    return this.graph.allowsBodies(
      (m.group ?? [{ lateral: 0, back: 0, figure: 'adult' }]).map((w) => {
        const size =
          m.kind === 'dog' || m.kind === 'cat' ? animalSize(m.kind) : memberSize(w.figure);
        return {
          x: m.x - m.hy * (w.lateral + lane) * this.perMeter - m.hx * w.back * this.perMeter,
          y: m.y + m.hx * (w.lateral + lane) * this.perMeter - m.hy * w.back * this.perMeter,
          hx: m.hx,
          hy: m.hy,
          length: size.length * this.perMeter,
          width: size.width * this.perMeter,
        };
      }),
      false,
    );
  }

  private requestReturn(m: Mover, visit: Visit) {
    visit.site.queue = visit.site.queue.filter((p) => p !== m);
    if (isWalker(m.kind) && !this.canIdle(m)) visit.returnPending = true;
    else this.returning(m, visit);
  }

  private move(
    m: Mover,
    visit: Visit,
    dt: number,
    guard?: MoveGuard,
    walkLimit?: (m: Mover, target: { x: number; y: number }, distance: number) => number,
  ) {
    const before = guard && isWalker(m.kind) ? { ...m } : undefined;
    const next = visit.next;
    const trailLength = visit.trail.length;
    let left = m.speed * dt;
    while (left > 0 && visit.next < visit.path.length) {
      const target = visit.path[visit.next]!;
      const d = dist(m, target);
      if (d > 0.001) {
        m.hx = (target.x - m.x) / d;
        m.hy = (target.y - m.y) / d;
      }
      let step = Math.min(d, left);
      if (isWalker(m.kind) && walkLimit) step = walkLimit(m, target, step);
      if (step <= 0 && d > 0.001) break;
      m.x += m.hx * step;
      m.y += m.hy * step;
      m.walked = (m.walked ?? 0) + step / this.perMeter;
      left -= step;
      if (step >= d) {
        m.x = target.x;
        m.y = target.y;
        if (visit.state !== 'return') visit.trail.push({ ...target });
        visit.next++;
      } else break;
    }
    if (before && guard && !guard(m, before)) {
      Object.assign(m, before);
      visit.next = next;
      visit.trail.length = trailLength;
      visit.blocked += dt;
      // Give an approaching group time to clear; abandoned visits release their queue slot.
      if (visit.blocked >= 8 && visit.state !== 'return') this.returning(m, visit);
      else if (visit.blocked >= 16 && visit.state === 'return') {
        const path = this.graph.route(m, visit.trail[0]!);
        if (path) {
          visit.path = path;
          visit.next = 1;
        }
        visit.blocked = 0;
      }
      return false;
    }
    visit.blocked = 0;
    if (visit.returnPending && this.canIdle(m)) {
      this.returning(m, visit);
      return false;
    }
    return visit.next >= visit.path.length;
  }

  step(
    dt: number,
    movers: readonly Mover[],
    env: { rain?: number; levels?: Activity; minutes?: number; cityLife?: CityLifeConfig },
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
    this.speechEvents.length = 0;
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
        if (!this.move(m, visit, dt, guard, walkLimit)) continue;
        if (visit.state === 'return') {
          m.x = visit.trail[0]!.x;
          m.y = visit.trail[0]!.y;
          m.pause = 0;
          m.lying = false;
          this.visits.delete(m);
          this.cooldown.set(m, 20 + this.rng() * 20);
        } else if (visit.state === 'board') {
          visit.state = 'aboard';
          visit.time = 3;
          m.pause = 1;
        } else {
          const before = { ...m };
          visit.state = visit.sheltering ? 'shelter' : visit.site.kind === 'rest' ? 'rest' : 'wait';
          visit.time = visit.state === 'rest' ? 30 + this.rng() * 60 : 60 + this.rng() * 30;
          m.hx = visit.site.hx;
          m.hy = visit.site.hy;
          m.pause = 1;
          m.lying = m.kind === 'dog';
          if (isWalker(m.kind) && (!this.canIdle(m) || (guard && !guard(m, before)))) {
            Object.assign(m, before);
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
        const right =
          (vehicleOffset?.(m) ?? Math.max(0, service.site.roadWidth / 2 - width / 2 - 0.2)) +
          width / 2 +
          0.75;
        const door = {
          x: m.x - m.hy * right * this.perMeter,
          y: m.y + m.hx * right * this.perMeter,
        };
        const path = this.graph.route(person, door);
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
        for (const site of this.sites) {
          if (
            (owns && !owns(site)) ||
            site === previous ||
            !(site.modes & modes) ||
            site.road !== m.line ||
            site.direction !== m.dir ||
            dist(m, site) > 15 * this.perMeter ||
            ahead(site, m) < 0
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
        const candidates = this.sites
          .map((site, index) => ({ site, index, d: dist(m, site) }))
          .filter(
            ({ site, d }) =>
              (!owns || owns(site)) &&
              d < 35 * this.perMeter &&
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
        if (this.rng() < (this.wet ? 0.7 : 0.12))
          for (const { index } of candidates) if (this.reserve(m, index)) break;
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
    out.target = Math.min(out.target, approach(distance, 0, brake));
    out.cap = Math.min(out.cap, distance / Math.max(dt, 0.001));
  }
  walkable(from: WalkPoint, to: WalkPoint): boolean {
    return this.graph.clear(from, to);
  }
  offset(m: Mover, normal: number, curb: number): number {
    const site = this.services.get(m)?.site ?? this.stopCooldown.get(m);
    if (!site) return normal;
    const blend = Math.max(0, 1 - dist(m, site) / (20 * this.perMeter));
    return normal + (curb - normal) * blend;
  }
  hidden(m: Mover): boolean {
    return this.visits.get(m)?.state === 'aboard';
  }
  still(m: Mover): boolean {
    const state = this.visits.get(m)?.state;
    return !!state && state !== 'approach' && state !== 'return' && state !== 'board';
  }
}
