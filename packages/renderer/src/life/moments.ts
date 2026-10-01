/** Tile-local social holds. Navigation and terrain admission stay with the simulation. */
import type { PlaceKind } from '@atlas/shared';
import type { PersonPose } from './people';
import { between, random } from './random';

export type MomentKind = 'greet' | 'talk' | 'ball' | 'look';
export const MOMENTS = {
  zoom: 18,
  rain: 0.5,
  interval: 0.1,
  checks: 8,
  binMeters: 12,
  capacity: 12,
  balls: 6,
  cooldown: 60,
  greet: { chance: 0.3, duration: [1.5, 3] },
  talk: { chance: 0.25, third: 0.35, duration: [10, 40], turn: [2, 5] },
  ball: { chance: 0.35, duration: [30, 90], hold: [0.5, 2], flight: [0.6, 1.2] },
  look: { chance: 0.15, duration: [4, 10] },
} as const;
export type MomentActor = {
  owner: object;
  type: 'walker' | 'gatherer';
  x: number;
  y: number;
  hx: number;
  hy: number;
  figure: 'adult' | 'child';
  idle: boolean;
  place?: PlaceKind;
  /** Original place record ordinal, never an inferred coordinate match. */
  source?: number;
};
export type MomentAnchor = { x: number; y: number; source: number };
export type MomentContext = {
  zoom: number;
  rain: number;
  perMeter: number;
  /** Refreshed only on the fixed scan cadence; order is stable. */
  actors(): readonly MomentActor[];
  anchors: readonly MomentAnchor[];
  eligible(actor: MomentActor): boolean;
  /** View filtering must not rearm a still-near approach when the camera pans. */
  alive?(actor: MomentActor): boolean;
  /** Conservative radius of the actual cell/stamp footprint, in meters. */
  clearance(actor: MomentActor): number;
  /** Guarded heading admission. A failed call must restore its own state. */
  face(actor: MomentActor, hx: number, hy: number): boolean;
  release(actor: MomentActor): void;
};
type Moment = {
  kind: MomentKind;
  members: MomentActor[];
  start: number;
  end: number;
  speaker: number;
  turnStart: number;
  turnEnd: number;
  point: boolean;
  holder: number;
  flying: boolean;
  phaseStart: number;
  phaseEnd: number;
};
type Approach = { a: MomentActor; b: MomentActor | MomentAnchor; radius: number };
const kinds: readonly MomentKind[] = ['greet', 'talk', 'ball', 'look'];
const social = new Set<PlaceKind>(['monument', 'fountain', 'worship', 'school']);
const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y);

export class Moments {
  private readonly rng: () => number;
  private time = 0;
  private nextScan = MOMENTS.interval as number;
  private priority = 0;
  private readonly cursor = [0, 0, 0, 0];
  private readonly neighbors = [0, 0, 0, 0];
  private readonly neighborCursor = new Map<object, number[]>();
  private readonly ids = new Map<object, number>();
  private readonly cooldown = new Map<object, number>();
  private readonly episodes = new Map<object, { idle: boolean; talk: boolean; ball: boolean }>();
  private readonly approaches = new Map<string, Approach>();
  private readonly membership = new Map<object, Moment>();
  private readonly active: Moment[] = [];
  readonly stats = {
    checks: 0,
    started: { greet: 0, talk: 0, ball: 0, look: 0 },
    completed: 0,
    canceled: 0,
  };

  constructor(
    seed: number,
    readonly enabled = true,
    rng?: () => number,
  ) {
    this.rng = rng ?? random(seed ^ 0x7f4a7c15);
  }
  busy(owner: object) {
    return this.membership.has(owner);
  }
  get size() {
    return this.active.length;
  }
  /** Explicit tile disposal releases even externally inspected test instances. */
  clear(release: (actor: MomentActor) => void) {
    for (const m of this.active) for (const actor of m.members) release(actor);
    this.active.length = 0;
    this.membership.clear();
    this.cooldown.clear();
    this.episodes.clear();
    this.approaches.clear();
    this.ids.clear();
    this.neighborCursor.clear();
  }
  pose(owner: object): PersonPose | undefined {
    const m = this.membership.get(owner);
    if (!m) return undefined;
    const index = m.members.findIndex((a) => a.owner === owner);
    const gesture =
      m.kind === 'greet'
        ? this.time - m.start < 1
        : m.kind === 'look'
          ? m.point && this.time - m.start < 1
          : m.kind === 'talk'
            ? index === m.speaker && this.time - m.turnStart < 1
            : index === m.holder && m.flying && this.time - m.phaseStart < 0.3;
    return gesture ? 'gesture' : 'attentive';
  }
  balls() {
    return this.active
      .filter((m) => m.kind === 'ball' && m.flying)
      .map((m) => {
        const a = m.members[m.holder]!;
        const b = m.members[1 - m.holder]!;
        const t = Math.max(
          0,
          Math.min(1, (this.time - m.phaseStart) / (m.phaseEnd - m.phaseStart)),
        );
        return { a: a.owner, b: b.owner, x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      });
  }
  snapshot() {
    const id = (owner: object) => this.ids.get(owner);
    return {
      time: this.time,
      nextScan: this.nextScan,
      priority: this.priority,
      cursor: [...this.cursor],
      neighbors: [...this.neighbors],
      stats: structuredClone(this.stats),
      neighborCursor: [...this.neighborCursor].map(([owner, counters]) => [
        id(owner),
        [...counters],
      ]),
      active: this.active.map((m) => ({ ...m, members: m.members.map((a) => id(a.owner)) })),
      cooldown: [...this.cooldown].map(([owner, end]) => [id(owner), end]),
      episodes: [...this.episodes].map(([owner, state]) => [id(owner), { ...state }]),
      approaches: [...this.approaches.keys()],
    };
  }
  private finish(m: Moment, context: MomentContext, canceled: boolean) {
    for (let i = m.members.length - 1; i >= 0; i--) {
      const a = m.members[i]!;
      this.membership.delete(a.owner);
      this.cooldown.set(a.owner, this.time + MOMENTS.cooldown);
      context.release(a);
    }
    this.active.splice(this.active.indexOf(m), 1);
    this.stats[canceled ? 'canceled' : 'completed']++;
  }
  step(dt: number, context: MomentContext) {
    if (!this.enabled) return;
    this.time += dt;
    const weather = context.zoom >= MOMENTS.zoom && context.rain < MOMENTS.rain;
    for (const m of [...this.active]) {
      if (
        !weather ||
        m.members.some((a) => !context.eligible(a)) ||
        m.members.some((a, i) =>
          m.members
            .slice(i + 1)
            .some(
              (b) =>
                distance(a, b) / context.perMeter < context.clearance(a) + context.clearance(b),
            ),
        )
      ) {
        this.finish(m, context, true);
        continue;
      }
      if (this.time + 1e-9 >= m.end) {
        this.finish(m, context, false);
        continue;
      }
      if (m.kind === 'talk')
        while (this.time + 1e-9 >= m.turnEnd) {
          m.speaker = (m.speaker + 1) % m.members.length;
          m.turnStart = m.turnEnd;
          m.turnEnd += between(this.rng, MOMENTS.talk.turn);
        }
      if (m.kind === 'ball')
        while (this.time + 1e-9 >= m.phaseEnd) {
          m.phaseStart = m.phaseEnd;
          if (m.flying) m.holder = 1 - m.holder;
          m.flying = !m.flying;
          m.phaseEnd += between(this.rng, m.flying ? MOMENTS.ball.flight : MOMENTS.ball.hold);
        }
    }
    if (!weather) {
      this.nextScan = this.time + MOMENTS.interval;
      return;
    }
    while (this.time + 1e-9 >= this.nextScan) {
      this.scan(context);
      this.nextScan += MOMENTS.interval;
    }
  }
  private available(a: MomentActor, c: MomentContext) {
    return this.free(a) && c.eligible(a);
  }
  private free(a: MomentActor) {
    return !this.busy(a.owner) && (this.cooldown.get(a.owner) ?? 0) <= this.time;
  }
  private scan(c: MomentContext) {
    const actors = c.actors();
    const present = new Set(actors.map((a) => a.owner));
    const alive = (a: MomentActor) => (c.alive ? c.alive(a) : present.has(a.owner));
    for (const a of actors) {
      if (!this.ids.has(a.owner)) this.ids.set(a.owner, this.ids.size);
      const episode = this.episodes.get(a.owner);
      if (!episode || (!episode.idle && a.idle))
        this.episodes.set(a.owner, { idle: a.idle, talk: false, ball: false });
      else episode.idle = a.idle;
    }
    for (const [key, approach] of this.approaches)
      if (
        !alive(approach.a) ||
        ('owner' in approach.b && !alive(approach.b)) ||
        distance(approach.a, approach.b) > approach.radius * c.perMeter
      )
        this.approaches.delete(key);
    for (const [owner, end] of this.cooldown) if (end <= this.time) this.cooldown.delete(owner);
    const width = MOMENTS.binMeters * c.perMeter;
    const bins = new Map<string, MomentActor[]>();
    const key = (x: number, y: number) => `${x},${y}`;
    for (const a of actors) {
      const k = key(Math.floor(a.x / width), Math.floor(a.y / width));
      const list = bins.get(k);
      if (list) list.push(a);
      else bins.set(k, [a]);
    }
    const lists = [
      actors.filter((a) => a.type === 'walker'),
      actors.filter((a) => a.type === 'gatherer' && social.has(a.place!)),
      actors.filter((a) => a.type === 'gatherer' && (a.place === 'school' || a.place === 'pitch')),
      actors.filter((a) => a.type === 'walker'),
    ];
    const children = new Map<number, number>();
    for (const a of lists[2]!)
      if (a.figure === 'child') children.set(a.source!, (children.get(a.source!) ?? 0) + 1);
    const neighbor = (a: MomentActor, k: number) => {
      const bx = Math.floor(a.x / width),
        by = Math.floor(a.y / width);
      const local: MomentActor[][] = [];
      let total = 0;
      for (let y = by - 1; y <= by + 1; y++)
        for (let x = bx - 1; x <= bx + 1; x++) {
          const list = bins.get(key(x, y));
          if (list) {
            local.push(list);
            total += list.length;
          }
        }
      if (!total) return undefined;
      let counters = this.neighborCursor.get(a.owner);
      if (!counters) {
        counters = [1, 1, 1, 1];
        this.neighborCursor.set(a.owner, counters);
      }
      let i = counters[k]!++ % total;
      this.neighbors[k]!++;
      for (const list of local) {
        if (i < list.length) return list[i];
        i -= list.length;
      }
      return undefined;
    };
    for (let check = 0; check < MOMENTS.checks; check++) {
      const k = (this.priority + check) % kinds.length,
        kind = kinds[k]!;
      this.stats.checks++;
      const list = lists[k]!;
      if (!list.length || this.active.length >= MOMENTS.capacity) continue;
      const a = list[this.cursor[k]!++ % list.length]!;
      if (!this.free(a)) continue;
      if (kind === 'look') {
        if (!c.anchors.length) continue;
        const anchor = c.anchors[this.neighbors[k]!++ % c.anchors.length]!;
        const d = distance(a, anchor) / c.perMeter;
        if (d <= 0 || d > 15 || !this.available(a, c)) continue;
        const approach = `look:${this.ids.get(a.owner)}:${anchor.source}`;
        if (this.approaches.has(approach)) continue;
        this.approaches.set(approach, { a, b: anchor, radius: 20 });
        if (this.rng() < MOMENTS.look.chance) this.start(kind, [a], anchor, c);
        continue;
      }
      const b = neighbor(a, k);
      if (!b || a === b || !this.free(b)) continue;
      const d = distance(a, b) / c.perMeter;
      if (d <= 0 || d < c.clearance(a) + c.clearance(b)) continue;
      if (kind === 'greet') {
        if (b.type !== 'walker' || d > 3 || a.hx * b.hx + a.hy * b.hy >= -0.5) continue;
        const ids = [this.ids.get(a.owner)!, this.ids.get(b.owner)!].sort((a, b) => a - b);
        const approach = `greet:${ids.join(':')}`;
        if (this.approaches.has(approach)) continue;
        if (!this.available(a, c) || !this.available(b, c)) continue;
        this.approaches.set(approach, { a, b, radius: 4 });
        if (this.rng() < MOMENTS.greet.chance) this.start(kind, [a, b], undefined, c);
      } else {
        if (
          a.type !== 'gatherer' ||
          b.type !== 'gatherer' ||
          a.source !== b.source ||
          !a.idle ||
          !b.idle ||
          a.place !== b.place
        )
          continue;
        const episode = this.episodes.get(a.owner)!;
        if (kind === 'talk') {
          if (!social.has(a.place!) || d > 8 || episode.talk) continue;
          if (!this.available(a, c) || !this.available(b, c)) continue;
          episode.talk = true;
          if (this.rng() >= MOMENTS.talk.chance) continue;
          const members = [a, b];
          if (this.rng() < MOMENTS.talk.third) {
            // One extra bounded candidate, charged against the same scan budget.
            if (++check < MOMENTS.checks) {
              this.stats.checks++;
              const third = neighbor(a, k);
              if (
                third &&
                third !== a &&
                third !== b &&
                third.type === 'gatherer' &&
                third.source === a.source &&
                third.idle &&
                this.available(third, c) &&
                members.every(
                  (p) =>
                    distance(p, third) / c.perMeter >= c.clearance(p) + c.clearance(third) &&
                    distance(p, third) / c.perMeter <= 8,
                )
              )
                members.push(third);
            }
          }
          this.start(kind, members, undefined, c);
        } else {
          const childOnly = a.place === 'school' || (children.get(a.source!) ?? 0) >= 2;
          if (
            d < 4 ||
            d > 10 ||
            episode.ball ||
            (childOnly && (a.figure !== 'child' || b.figure !== 'child')) ||
            this.active.filter((m) => m.kind === 'ball').length >= MOMENTS.balls
          )
            continue;
          if (!this.available(a, c) || !this.available(b, c)) continue;
          episode.ball = true;
          if (this.rng() < MOMENTS.ball.chance) this.start(kind, [a, b], undefined, c);
        }
      }
    }
    this.priority = (this.priority + 1) % kinds.length;
  }
  private start(
    kind: MomentKind,
    members: MomentActor[],
    anchor: MomentAnchor | undefined,
    c: MomentContext,
  ) {
    const center = anchor ?? {
      x: members.reduce((sum, a) => sum + a.x, 0) / members.length,
      y: members.reduce((sum, a) => sum + a.y, 0) / members.length,
    };
    const admitted: MomentActor[] = [];
    for (const a of members) {
      const d = distance(a, center);
      if (d <= 1e-9 || !c.face(a, (center.x - a.x) / d, (center.y - a.y) / d)) {
        for (let i = admitted.length - 1; i >= 0; i--) c.release(admitted[i]!);
        return;
      }
      admitted.push(a);
    }
    const m: Moment = {
      kind,
      members,
      start: this.time,
      end: this.time + between(this.rng, MOMENTS[kind].duration),
      speaker: 0,
      turnStart: this.time,
      turnEnd: this.time,
      point: false,
      holder: 0,
      flying: false,
      phaseStart: this.time,
      phaseEnd: this.time,
    };
    if (kind === 'talk') m.turnEnd += between(this.rng, MOMENTS.talk.turn);
    if (kind === 'ball') m.phaseEnd += between(this.rng, MOMENTS.ball.hold);
    if (kind === 'look') m.point = this.rng() < 0.5;
    this.active.push(m);
    for (const a of members) this.membership.set(a.owner, m);
    this.stats.started[kind]++;
  }
}
