import type { ControlledCrossingAnchor, CrossingSide, LifeGeometry } from './geometry';
import {
  binKeys,
  bodyCorners,
  bodyInside,
  bodiesOverlap,
  pointInside,
  type Body,
  type Point,
} from './occupancy';
import type { GroundAgent, GroundGuard } from './simulate';
import { pedestrianState } from './signals';
import type { RoadAccess } from './terrain';

/** Immutable metre offsets from the route cursor; formation arrays remain untouched. */
export type WaitPose = Readonly<Point & { hx: number; hy: number }>;
export type CrossingCommitment = Readonly<{ id: string; side: number; seed: number }>;
export type WaitingPose = Readonly<{
  id: string;
  side: number;
  owner: string;
  arrival: number;
  index: number;
  slots: readonly number[];
  activeSlots: readonly number[];
  age: number;
  releasing: boolean;
  poses: readonly WaitPose[];
  start: readonly WaitPose[];
}>;
export type CrossingWaitState = Readonly<{
  commitments: readonly CrossingCommitment[];
  waiting?: WaitingPose;
}>;
type Walker = GroundAgent & { crossingWait?: CrossingWaitState };
type Claim = { owner: string; pad: string; slots: number[]; arrival: number; index: number };
type Request = Omit<Claim, 'slots'> & { count: number; allowed: number[] };
const padKey = (id: string, side: number) => JSON.stringify([id, side]);
const adjacent = (a: number, b: number) =>
  (Math.floor(a / 2) === Math.floor(b / 2) && Math.abs(a - b) === 1) ||
  (a % 2 === b % 2 && Math.abs(a - b) === 2);

/** One registry per world: buffered/mixed-zoom copies share geographic pad capacity. */
export class CrossingReservations {
  private next = 0;
  private readonly claims = new Map<string, Claim>();
  private readonly requests = new Map<string, Request>();
  ownerKey() {
    return `crossing-owner:${this.next++}`;
  }
  clear() {
    this.claims.clear();
    this.requests.clear();
    this.next = 0;
  }
  claim(owner: string) {
    return this.claims.get(owner);
  }
  request(wait: WaitingPose, count: number, allowed: readonly number[]) {
    if (this.claims.has(wait.owner) || wait.releasing) return;
    this.requests.set(wait.owner, {
      owner: wait.owner,
      pad: padKey(wait.id, wait.side),
      arrival: wait.arrival,
      index: wait.index,
      count,
      allowed: [...allowed],
    });
  }
  resolve() {
    for (const request of [...this.requests.values()].sort(
      (a, b) => a.arrival - b.arrival || a.index - b.index || a.owner.localeCompare(b.owner),
    )) {
      const occupied = new Set(
        [...this.claims.values()].filter((c) => c.pad === request.pad).flatMap((c) => c.slots),
      );
      const available = request.allowed.filter((slot) => !occupied.has(slot)).sort((a, b) => a - b);
      let chosen: number[] | undefined;
      for (let mask = 1; mask < 1 << available.length; mask++) {
        const slots = available.filter((_, i) => mask & (1 << i));
        if (slots.length !== request.count) continue;
        const reached = new Set([slots[0]!]);
        for (let pass = 0; pass < slots.length; pass++)
          for (const slot of slots)
            if ([...reached].some((other) => adjacent(slot, other))) reached.add(slot);
        if (reached.size === slots.length) {
          chosen = slots;
          break;
        }
      }
      if (!chosen) continue;
      this.claims.set(request.owner, { ...request, slots: chosen });
      this.requests.delete(request.owner);
    }
  }
  canDepart(wait: WaitingPose) {
    const pad = padKey(wait.id, wait.side),
      claim = this.claims.get(wait.owner);
    const claims = [...this.claims.values()].filter((c) => c.pad === pad && c.slots.length);
    if (claim?.slots.length)
      return Math.min(...claim.slots) === Math.min(...claims.flatMap((c) => c.slots));
    if (claims.length) return false;
    const first = [...this.requests.values()]
      .filter((r) => r.pad === pad)
      .sort(
        (a, b) => a.arrival - b.arrival || a.index - b.index || a.owner.localeCompare(b.owner),
      )[0];
    return !first || first.owner === wait.owner;
  }
  depart(owner: string) {
    this.requests.delete(owner);
  }
  releaseSlots(owner: string, slots: readonly number[]) {
    const claim = this.claims.get(owner);
    if (!claim) return;
    claim.slots = claim.slots.filter((slot) => !slots.includes(slot));
    if (!claim.slots.length) this.claims.delete(owner);
  }
  canRestore(wait: WaitingPose) {
    if (!wait.activeSlots.length) return true;
    const pad = padKey(wait.id, wait.side);
    const own = this.claims.get(wait.owner);
    if (own && own.pad !== pad) return false;
    return ![...this.claims.values()].some(
      (c) =>
        c.owner !== wait.owner &&
        c.pad === pad &&
        c.slots.some((s) => wait.activeSlots.includes(s)),
    );
  }
  restore(wait: WaitingPose) {
    if (!this.canRestore(wait)) return false;
    if (wait.activeSlots.length && !this.claims.has(wait.owner))
      this.claims.set(wait.owner, {
        owner: wait.owner,
        pad: padKey(wait.id, wait.side),
        slots: [...wait.activeSlots],
        arrival: wait.arrival,
        index: wait.index,
      });
    return true;
  }
  release(owner: string) {
    this.claims.delete(owner);
    this.requests.delete(owner);
  }
  retain(active: ReadonlySet<string>) {
    for (const owner of [...this.claims.keys(), ...this.requests.keys()])
      if (!active.has(owner)) this.release(owner);
  }
  snapshot() {
    return {
      next: this.next,
      claims: [...this.claims.values()].sort((a, b) => a.owner.localeCompare(b.owner)),
      requests: [...this.requests.values()].sort((a, b) => a.owner.localeCompare(b.owner)),
    };
  }
}

type Record = ControlledCrossingAnchor & { quad: Point[]; sides: [CrossingSide, CrossingSide] };
const walker = (owner: GroundAgent): owner is Walker =>
  'walker' in owner ||
  ('kind' in owner && (owner.kind === 'person' || owner.kind === 'dog' || owner.kind === 'cat'));
const signed = (p: Point, side: CrossingSide) =>
  (p.x - side.centre.x) * side.inward.x + (p.y - side.centre.y) * side.inward.y;
const front = (body: Body, side: CrossingSide) =>
  Math.max(...bodyCorners(body).map((p) => signed(p, side)));

/** Cached gate index, with permission independent of a scene walker's original route line. */
export class CrossingWaits {
  readonly records: readonly Record[];
  private readonly byId = new Map<string, Record>();
  private readonly bins = new Map<number, Record[]>();
  private readonly lines = new Map<number, Record[]>();
  private readonly blocked = new Map<GroundAgent, { record: Record; side: number }>();
  registry = new CrossingReservations();
  shared = false;
  constructor(
    geo: LifeGeometry,
    readonly perMeter: number,
    private readonly bodies: (owner: GroundAgent, minimum: number, natural?: boolean) => Body[],
    private readonly roads: RoadAccess,
  ) {
    const metric = (p: Point) => ({ x: p.x / perMeter, y: p.y / perMeter });
    this.records = (geo.controlledCrossings ?? [])
      .filter((c) => c.quad && c.sides)
      .map((c) => ({
        ...c,
        anchor: metric(c.anchor),
        quad: c.quad!.map(metric),
        sides: c.sides!.map((side) => ({
          ...side,
          gate: side.gate.map(metric),
          centre: metric(side.centre),
          pads: side.pads.map((pad) => pad.map(metric)),
          slots: side.slots.map(metric),
        })) as [CrossingSide, CrossingSide],
      }));
    for (const record of this.records) {
      this.byId.set(record.id, record);
      for (const key of binKeys(record.quad, 5)) {
        const entries = this.bins.get(key) ?? [];
        entries.push(record);
        this.bins.set(key, entries);
      }
      for (let line = 0; line < geo.kinds.length; line++)
        if (geo.lineIds?.[line] === record.lineId) {
          const entries = this.lines.get(line) ?? [];
          entries.push(record);
          this.lines.set(line, entries);
        }
    }
  }
  beginStep() {
    this.blocked.clear();
  }
  private near(before: readonly Body[], after = before): Set<Record> {
    const points = [...before, ...after].flatMap((b) => bodyCorners(b));
    return new Set(binKeys(points).flatMap((key) => this.bins.get(key) ?? []));
  }
  private committed(owner: Walker, record: Record) {
    return owner.crossingWait?.commitments.some(
      (c) => c.id === record.id && c.seed === record.controller.seed,
    );
  }
  private walk(record: Record, clock: number) {
    const c = record.controller;
    return pedestrianState(c.seed, clock, c.midBlock, c.walk) === 'walk';
  }
  private entry(before: Body, after: Body, side: CrossingSide): boolean {
    if (front(before, side) > 1e-6 || front(after, side) <= 1e-6) return false;
    const a = side.gate[0],
      b = side.gate[1],
      length = Math.hypot(b.x - a.x, b.y - a.y);
    if (!length) return false;
    const tx = (b.x - a.x) / length,
      ty = (b.y - a.y) / length;
    const lateral = [...bodyCorners(before), ...bodyCorners(after)].map(
      (p) => (p.x - a.x) * tx + (p.y - a.y) * ty,
    );
    return Math.min(...lateral) <= length && Math.max(...lateral) >= 0;
  }
  permits(
    owner: GroundAgent,
    previous: GroundAgent | undefined,
    clock: number,
    minimum = 0,
  ): boolean {
    if (!walker(owner) || !this.records.length) return true;
    const after = this.bodies(owner, minimum),
      before = previous ? this.bodies(previous, minimum) : after;
    const waiting = owner.crossingWait?.waiting;
    if (waiting) {
      const record = this.byId.get(waiting.id),
        side = record?.sides[waiting.side];
      if (!record || !side || !this.registry.canRestore(waiting)) return false;
      if (!waiting.releasing && !this.roads.allows(after, false)) return false;
      if (!waiting.releasing && waiting.slots.some((id) => !side.slotIds.includes(id)))
        return false;
      if (
        !waiting.releasing &&
        previous &&
        Math.hypot(owner.x - previous.x, owner.y - previous.y) > 1e-6
      )
        return false;
      if (
        !previous &&
        waiting.slots.length &&
        after.some((body) => !side.pads.some((pad) => bodyInside(body, [pad])))
      )
        return false;
    }
    for (const record of this.near(before, after)) {
      if (this.committed(owner, record) || this.walk(record, clock)) continue;
      if (
        !previous &&
        after.some((body) => bodyCorners(body).some((p) => pointInside(p, [record.quad])))
      )
        return false;
      for (const side of record.sides)
        for (let i = 0; i < after.length; i++) {
          const a = before[i],
            b = after[i]!;
          if (!a) return false;
          let prior = a;
          const steps = Math.max(1, Math.ceil(Math.hypot(b.hx - a.hx, b.hy - a.hy) * 8));
          for (let step = 1; step <= steps; step++) {
            const t = step / steps,
              hx = a.hx + (b.hx - a.hx) * t,
              hy = a.hy + (b.hy - a.hy) * t,
              norm = Math.hypot(hx, hy);
            const sample = {
              ...b,
              x: a.x + (b.x - a.x) * t,
              y: a.y + (b.y - a.y) * t,
              hx: norm ? hx / norm : b.hx,
              hy: norm ? hy / norm : b.hy,
            };
            if (this.entry(prior, sample, side)) return false;
            prior = sample;
          }
        }
    }
    return true;
  }
  /** Whole footprints stop at the actual curb, even during an oversized multi-segment step. */
  limit(
    owner: GroundAgent,
    target: Point,
    distance: number,
    clock: number,
    minimum = 0,
    cursor = owner,
  ): number {
    if (!walker(owner) || !this.records.length || distance <= 0) return distance;
    if (owner.crossingWait?.waiting && !owner.crossingWait.waiting.releasing) return 0;
    const before = this.bodies(cursor, minimum),
      dx = target.x - cursor.x,
      dy = target.y - cursor.y,
      length = Math.hypot(dx, dy);
    if (!length) return distance;
    const mx = dx / length / this.perMeter,
      my = dy / length / this.perMeter;
    const after = before.map((body) => ({
      ...body,
      x: body.x + mx * distance,
      y: body.y + my * distance,
    }));
    let allowed = distance;
    const local = 'kind' in owner ? (this.lines.get(owner.line) ?? []) : [];
    for (const record of new Set([...local, ...this.near(before, after)])) {
      if (this.committed(owner, record) || this.walk(record, clock)) continue;
      for (const [sideIndex, side] of record.sides.entries())
        for (let i = 0; i < before.length; i++) {
          if (!this.entry(before[i]!, after[i]!, side)) continue;
          const speed = mx * side.inward.x + my * side.inward.y;
          if (speed <= 0) continue;
          // Polygon edge tests have a parametric tolerance; leave a centimetre of dry curb.
          const cap = Math.max(0, (-front(before[i]!, side) - 0.01) / speed);
          if (cap < allowed) {
            allowed = cap;
            this.blocked.set(owner, { record, side: sideIndex });
          }
        }
    }
    return allowed;
  }
  accept(
    owner: GroundAgent,
    previous: GroundAgent | undefined,
    clock: number,
    minimum = 0,
    index = 0,
  ) {
    if (!walker(owner) || !this.records.length) return;
    const after = this.bodies(owner, minimum),
      before = previous ? this.bodies(previous, minimum) : after;
    let commitments = [...(owner.crossingWait?.commitments ?? [])];
    for (const record of this.near(before, after)) {
      if (!commitments.some((c) => c.id === record.id) && this.walk(record, clock)) {
        const entered = record.sides.findIndex((side) =>
          after.some((body, i) =>
            previous
              ? !!before[i] && this.entry(before[i]!, body, side)
              : bodyCorners(body).some((p) => pointInside(p, [record.quad])),
          ),
        );
        if (entered >= 0)
          commitments.push({ id: record.id, seed: record.controller.seed, side: entered });
      }
    }
    commitments = commitments.filter((commitment) => {
      const record = this.byId.get(commitment.id);
      return (
        !!record && !record.sides.some((side) => after.every((body) => front(body, side) < -1e-5))
      );
    });
    let waiting = owner.crossingWait?.waiting;
    const held = this.blocked.get(owner);
    if (!waiting && held && !this.walk(held.record, clock) && this.roads.allows(after, false)) {
      const poses = after.map((body) => ({
        x: body.x - owner.x / this.perMeter,
        y: body.y - owner.y / this.perMeter,
        hx: body.hx,
        hy: body.hy,
      }));
      waiting = {
        id: held.record.id,
        side: held.side,
        owner: this.registry.ownerKey(),
        arrival: clock,
        index,
        slots: [],
        activeSlots: [],
        age: 0,
        releasing: false,
        poses,
        start: poses,
      };
    }
    if (waiting) {
      this.registry.restore(waiting);
      const record = this.byId.get(waiting.id)!;
      const side = record.sides[waiting.side]!;
      if (!waiting.releasing) {
        const allowed = side.slots.flatMap((slot, i) =>
          after.every((body) => {
            const at = { ...body, ...slot, hx: side.inward.x, hy: side.inward.y };
            return side.pads.some((pad) => bodyInside(at, [pad])) && this.roads.allows([at], false);
          })
            ? [side.slotIds[i]!]
            : [],
        );
        this.registry.request(waiting, after.length, allowed);
      } else {
        const vacated = (this.registry.claim(waiting.owner)?.slots ?? []).filter((id) => {
          const slot = side.slots[side.slotIds.indexOf(id)];
          return (
            !slot ||
            after.every(
              (body) =>
                !bodiesOverlap(body, { ...body, ...slot, hx: side.inward.x, hy: side.inward.y }, 0),
            )
          );
        });
        this.registry.releaseSlots(waiting.owner, vacated);
        waiting = { ...waiting, activeSlots: this.registry.claim(waiting.owner)?.slots ?? [] };
        if (waiting.age >= 0.8 && !this.registry.claim(waiting.owner)) waiting = undefined;
      }
    }
    owner.crossingWait = commitments.length || waiting ? { commitments, waiting } : undefined;
  }
  /** Update easing once, through the same accepted full-body trial as ordinary movement. */
  tick(owner: GroundAgent, dt: number, clock: number, minimum: number, guard: GroundGuard) {
    if (!walker(owner)) return;
    const state = owner.crossingWait,
      wait = state?.waiting;
    if (!wait) return;
    const record = this.byId.get(wait.id),
      side = record?.sides[wait.side];
    if (!record || !side) return;
    const claim = this.registry.claim(wait.owner);
    const releasing = wait.releasing || (this.walk(record, clock) && this.registry.canDepart(wait));
    const reset =
      releasing !== wait.releasing ||
      (!wait.releasing && !!claim && JSON.stringify(wait.slots) !== JSON.stringify(claim.slots));
    const start = reset ? wait.poses : wait.start;
    const slots = wait.releasing ? wait.slots : (claim?.slots ?? wait.slots);
    if (slots.some((id) => !side.slotIds.includes(id))) return;
    const natural = this.bodies(owner, minimum, true);
    const targets = releasing
      ? natural.map((body) => ({
          x: body.x - owner.x / this.perMeter,
          y: body.y - owner.y / this.perMeter,
          hx: body.hx,
          hy: body.hy,
        }))
      : slots.length === wait.poses.length
        ? slots.map((id) => {
            const p = side.slots[side.slotIds.indexOf(id)]!;
            return {
              x: p.x - owner.x / this.perMeter,
              y: p.y - owner.y / this.perMeter,
              hx: side.inward.x,
              hy: side.inward.y,
            };
          })
        : wait.poses;
    if (targets.some((p) => !p)) return;
    const age = Math.min(0.8, (reset ? 0 : wait.age) + dt),
      t = age / 0.8,
      ease = t * t * (3 - 2 * t);
    const poses = start.map((from, i) => {
      const to = targets[i]!,
        hx = from.hx + (to.hx - from.hx) * ease,
        hy = from.hy + (to.hy - from.hy) * ease,
        length = Math.hypot(hx, hy);
      return {
        x: from.x + (to.x - from.x) * ease,
        y: from.y + (to.y - from.y) * ease,
        hx: length ? hx / length : to.hx,
        hy: length ? hy / length : to.hy,
      };
    });
    const before = { ...owner };
    owner.crossingWait = {
      commitments: state!.commitments,
      waiting: {
        ...wait,
        slots,
        activeSlots: claim?.slots ?? wait.activeSlots,
        age,
        releasing,
        start,
        poses,
      },
    };
    if (!guard(owner, before)) owner.crossingWait = state;
    else if (releasing) this.registry.depart(wait.owner);
  }
  release(owner: GroundAgent, final = true) {
    if (!walker(owner)) return;
    if (owner.crossingWait?.waiting) this.registry.release(owner.crossingWait.waiting.owner);
    if (final) owner.crossingWait = undefined;
  }
}
