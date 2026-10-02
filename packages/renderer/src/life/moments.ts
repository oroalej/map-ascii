/** Tile-local social holds. Navigation and terrain admission stay with the simulation. */
import {
  SPEECH_ZOOM,
  DIALOGUE_WEATHER,
  LOOK_ANCHORS,
  type DialogueAnchor,
  type DialogueChoice,
  type GreetingPeriods,
  type PlaceKind,
} from '@atlas/shared';
import type { PersonPose } from './people';
import { between, random } from './random';
import { DialogueSelector, type DialogueMemory } from './dialogue';

export type MomentKind = DialogueChoice['kind'];
export const MOMENTS = {
  zoom: SPEECH_ZOOM,
  rain: DIALOGUE_WEATHER.rain,
  interval: 0.1,
  checks: 8,
  binMeters: 12,
  capacity: 12,
  balls: 6,
  cooldown: 60,
  retry: 1,
  clearanceExtra: 2,
  gesture: 1,
  scene: { capacity: 4, ambientCapacity: 2, checks: 2, turn: 3, vendorTurn: 1.5 },
  greet: { chance: 0.3, duration: [1.5, 3], speechTurn: 2.5, reach: 3, rearm: 1, opposition: -0.5 },
  talk: { chance: 0.25, third: 0.35, duration: [10, 40], turn: [2, 5], speechTurn: 3, reach: 8 },
  ball: {
    chance: 0.35,
    duration: [30, 90],
    hold: [0.5, 2],
    flight: [0.6, 1.2],
    speechTurn: 2.5,
    speechCooldown: 10,
    reach: 10,
    minimum: 4,
    gesture: 0.3,
  },
  look: { chance: 0.15, duration: [4, 10], speechTurn: 3, reach: 15, rearm: 20, point: 0.5 },
} as const;
export type MomentActor<Owner extends object = object> = {
  owner: Owner;
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
export type MomentAnchor = { x: number; y: number; source: number; kind?: DialogueAnchor };
export type MomentContext<Owner extends object = object> = {
  zoom: number;
  rain: number;
  minutes?: number;
  wind?: number;
  clock?: number;
  reserved?: number;
  sceneChecks?: number;
  perMeter: number;
  /** Refreshed only on the fixed scan cadence; order is stable. */
  actors(): readonly MomentActor<Owner>[];
  anchors: readonly MomentAnchor[];
  eligible(actor: MomentActor<Owner>): boolean;
  /** View filtering must not rearm a still-near approach when the camera pans. */
  alive?(actor: MomentActor<Owner>): boolean;
  /** Conservative radius of the actual cell/stamp footprint, in meters. */
  clearance(actor: MomentActor<Owner>): number;
  /** Guarded heading admission. A failed call must restore its own state. */
  face(actor: MomentActor<Owner>, hx: number, hy: number): boolean;
  release(actor: MomentActor<Owner>): void;
};
type Moment<Owner extends object = object> = {
  id: number;
  dialogue?: DialogueChoice;
  voiced: boolean;
  speechStart?: number;
  speechHolder: number;
  lastSpeech: number;
  caught?: number;
  focus?: MomentAnchor;
  kind: MomentKind;
  members: MomentActor<Owner>[];
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
type Approach<Owner extends object = object> = {
  a: MomentActor<Owner>;
  b: MomentActor<Owner> | MomentAnchor;
  radius: number;
};
type Pending<Owner extends object = object> = {
  kind: MomentKind;
  members: MomentActor<Owner>[];
  anchor?: MomentAnchor;
  next: number;
};
const kinds: readonly MomentKind[] = ['greet', 'talk', 'ball', 'look'];
const social = new Set<PlaceKind>(['monument', 'fountain', 'worship', 'school']);
const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y);

export class Moments<Owner extends object = object> {
  private readonly rng: () => number;
  readonly selector: DialogueSelector;
  private serial = 0;
  private time = 0;
  private nextScan = MOMENTS.interval as number;
  private priority = 0;
  private readonly cursor = [0, 0, 0, 0];
  private readonly neighbors = [0, 0, 0, 0];
  private neighborCursor = new WeakMap<object, number[]>();
  private ids = new WeakMap<object, number>();
  private ownerSerial = 0;
  private readonly cooldown = new Map<object, number>();
  private episodes = new WeakMap<
    object,
    { idle: boolean; talk: boolean; ball: boolean; look: boolean }
  >();
  private readonly approaches = new Map<string, Approach<Owner>>();
  private readonly pending = new Map<string, Pending<Owner>>();
  private readonly membership = new Map<object, Moment<Owner>>();
  private readonly active: Moment<Owner>[] = [];
  private lastActors: readonly MomentActor<Owner>[] = [];
  private readonly present = new Set<object>();
  private readonly bins = new Map<number, MomentActor<Owner>[]>();
  private readonly binPool: MomentActor<Owner>[][] = [];
  private readonly lists: MomentActor<Owner>[][] = [[], [], [], []];
  private readonly localBins: MomentActor<Owner>[][] = [];
  private readonly children = new Map<number, number>();
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
    private readonly dialogue: readonly DialogueChoice[] = [],
    private readonly periods?: Readonly<GreetingPeriods>,
    memory?: DialogueMemory,
  ) {
    this.rng = rng ?? random(seed ^ 0x7f4a7c15);
    this.selector = new DialogueSelector(seed, dialogue, periods, memory);
  }
  busy(owner: object) {
    return this.membership.has(owner);
  }
  get size() {
    return this.active.length;
  }
  /** A detached cue: participant references never cross the worker boundary. */
  speech(owner: object): SpeechCue | undefined {
    const m = this.membership.get(owner);
    if (!m?.dialogue || !m.voiced || m.speechStart === undefined) return;
    const seconds = MOMENTS[m.kind].speechTurn;
    const caught = m.dialogue.conditions?.event === 'catch';
    const utterance = m.dialogue.delivery === 'utterance';
    if (caught && utterance && m.caught === undefined) return;
    const line =
      caught && utterance
        ? 0
        : caught
          ? m.caught === undefined
            ? 0
            : 1
          : Math.floor((this.time - m.speechStart) / seconds + 1e-9);
    const slot = m.dialogue.speakers?.[line] ?? line;
    if (
      line < 0 ||
      line >= m.dialogue.turns ||
      (caught && m.caught !== undefined && this.time - m.caught >= seconds) ||
      m.members[(m.speechHolder + slot) % m.members.length]?.owner !== owner
    )
      return;
    return { id: `${m.id}:${m.speechStart}`, exchangeId: m.dialogue.id, line };
  }
  /** Explicit tile disposal releases even externally inspected test instances. */
  clear(release: (actor: MomentActor<Owner>) => void) {
    for (const m of this.active) for (const actor of m.members) release(actor);
    this.active.length = 0;
    this.membership.clear();
    this.cooldown.clear();
    this.episodes = new WeakMap();
    this.approaches.clear();
    this.pending.clear();
    this.ids = new WeakMap();
    this.ownerSerial = 0;
    this.neighborCursor = new WeakMap();
    this.lastActors = [];
    this.present.clear();
    this.bins.clear();
    this.children.clear();
    for (const list of [...this.binPool, ...this.lists, this.localBins]) list.length = 0;
    this.selector.clear();
  }
  pose(owner: object): PersonPose | undefined {
    const m = this.membership.get(owner);
    if (!m) return undefined;
    const index = m.members.findIndex((a) => a.owner === owner);
    if (m.dialogue?.profile && m.kind !== 'ball') {
      const elapsed = this.time - m.start;
      const seconds = MOMENTS[m.kind].speechTurn;
      const line = Math.floor(elapsed / seconds);
      const speaking = m.dialogue.speakers?.[line] === index;
      const phase = elapsed % seconds;
      const profile = m.dialogue.profile;
      const gesture =
        profile === 'farewell'
          ? speaking && line === m.dialogue.turns - 1 && phase > seconds - 1
          : profile === 'directions'
            ? speaking && index === 1
            : profile === 'reunion'
              ? speaking && phase < 0.8
              : profile === 'place-reaction'
                ? phase < 1
                : speaking && phase < MOMENTS.gesture;
      return gesture ? 'gesture' : 'attentive';
    }
    const gesture =
      m.kind === 'greet'
        ? m.dialogue
          ? index === Math.floor((this.time - m.start) / MOMENTS.greet.speechTurn) &&
            (this.time - m.start) % MOMENTS.greet.speechTurn < MOMENTS.gesture
          : this.time - m.start < MOMENTS.gesture
        : m.kind === 'look'
          ? m.point && this.time - m.start < MOMENTS.gesture
          : m.kind === 'talk'
            ? index === m.speaker && this.time - m.turnStart < MOMENTS.gesture
            : index === m.holder && m.flying && this.time - m.phaseStart < MOMENTS.ball.gesture;
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
      neighborCursor: this.lastActors.flatMap(({ owner }) => {
        const counters = this.neighborCursor.get(owner);
        return counters ? [[id(owner), [...counters]]] : [];
      }),
      active: this.active.map((m) => ({ ...m, members: m.members.map((a) => id(a.owner)) })),
      cooldown: [...this.cooldown].map(([owner, end]) => [id(owner), end]),
      episodes: this.lastActors.flatMap(({ owner }) => {
        const state = this.episodes.get(owner);
        return state ? [[id(owner), { ...state }]] : [];
      }),
      approaches: [...this.approaches.keys()],
      pending: [...this.pending].map(([key, p]) => [
        key,
        { ...p, members: p.members.map((a) => id(a.owner)) },
      ]),
    };
  }
  private finish(m: Moment<Owner>, context: MomentContext<Owner>, canceled: boolean) {
    for (let i = m.members.length - 1; i >= 0; i--) {
      const a = m.members[i]!;
      this.membership.delete(a.owner);
      this.cooldown.set(a.owner, this.time + MOMENTS.cooldown);
      context.release(a);
    }
    this.active.splice(this.active.indexOf(m), 1);
    this.stats[canceled ? 'canceled' : 'completed']++;
  }
  step(dt: number, context: MomentContext<Owner>) {
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
          const turn = between(this.rng, MOMENTS.talk.turn);
          m.turnEnd += m.dialogue ? MOMENTS.talk.speechTurn : turn;
        }
      if (m.kind === 'ball')
        while (this.time + 1e-9 >= m.phaseEnd) {
          m.phaseStart = m.phaseEnd;
          if (m.flying) {
            m.holder = 1 - m.holder;
            if (m.speechStart !== undefined && m.caught === undefined) m.caught = m.phaseStart;
            if (
              m.dialogue?.conditions?.event === 'pass' &&
              m.phaseStart - m.lastSpeech >= MOMENTS.ball.speechCooldown
            ) {
              m.speechStart = m.phaseStart;
              m.speechHolder = m.holder;
              m.lastSpeech = m.phaseStart;
            }
          }
          m.flying = !m.flying;
          if (
            m.dialogue &&
            m.dialogue.conditions?.event !== 'pass' &&
            m.flying &&
            m.phaseStart - m.lastSpeech >= MOMENTS.ball.speechCooldown
          ) {
            m.speechStart = m.phaseStart;
            m.caught = undefined;
            m.speechHolder = m.holder;
            m.lastSpeech = m.phaseStart;
          }
          m.phaseEnd += between(this.rng, m.flying ? MOMENTS.ball.flight : MOMENTS.ball.hold);
        }
    }
    if (!weather) {
      this.pending.clear();
      this.nextScan = this.time + MOMENTS.interval;
      return;
    }
    while (this.time + 1e-9 >= this.nextScan) {
      this.scan(context);
      this.nextScan += MOMENTS.interval;
    }
  }
  private available(a: MomentActor<Owner>, c: MomentContext<Owner>) {
    return this.free(a) && c.eligible(a);
  }
  private free(a: MomentActor<Owner>) {
    return !this.busy(a.owner) && (this.cooldown.get(a.owner) ?? 0) <= this.time;
  }
  private reach(
    a: MomentActor<Owner>,
    b: MomentActor<Owner>,
    base: number,
    c: MomentContext<Owner>,
  ) {
    return Math.max(base, c.clearance(a) + c.clearance(b) + MOMENTS.clearanceExtra);
  }
  private attempt(key: string, p: Pending<Owner>, c: MomentContext<Owner>) {
    if (this.start(p.kind, p.members, p.anchor, c)) this.pending.delete(key);
    else {
      p.next = this.time + MOMENTS.retry;
      this.pending.set(key, p);
    }
  }
  private retryable(p: Pending<Owner>, c: MomentContext<Owner>) {
    if (p.members.some((a) => !this.available(a, c))) return false;
    const a = p.members[0]!;
    if (p.kind === 'look')
      return (
        (a.type === 'walker' ||
          (a.idle &&
            (a.place === 'monument' || a.place === 'fountain') &&
            a.source === p.anchor!.source)) &&
        distance(a, p.anchor!) / c.perMeter <= MOMENTS.look.reach
      );
    if (
      p.kind === 'greet' &&
      a.hx * p.members[1]!.hx + a.hy * p.members[1]!.hy >= MOMENTS.greet.opposition
    )
      return false;
    if (
      p.kind !== 'greet' &&
      p.members.some((b) => !b.idle || b.source !== a.source || b.place !== a.place)
    )
      return false;
    return p.members.every((b, i) =>
      p.members.slice(i + 1).every((d) => {
        const separation = distance(b, d) / c.perMeter;
        return (
          separation >= c.clearance(b) + c.clearance(d) &&
          separation <= this.reach(b, d, MOMENTS[p.kind].reach, c) &&
          (p.kind !== 'ball' || separation >= MOMENTS.ball.minimum)
        );
      }),
    );
  }
  private scan(c: MomentContext<Owner>) {
    const budget = Math.max(0, MOMENTS.checks - (c.sceneChecks ?? 0));
    const actors = c.actors();
    this.lastActors = actors;
    const { present } = this;
    present.clear();
    for (const actor of actors) present.add(actor.owner);
    const alive = (a: MomentActor<Owner>) => (c.alive ? c.alive(a) : present.has(a.owner));
    for (const a of actors) {
      if (!this.ids.has(a.owner)) this.ids.set(a.owner, this.ownerSerial++);
      const episode = this.episodes.get(a.owner);
      if (!episode || (!episode.idle && a.idle))
        this.episodes.set(a.owner, { idle: a.idle, talk: false, ball: false, look: false });
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
    let retries = 0;
    for (const [key, p] of this.pending) {
      if (p.members.some((a) => !present.has(a.owner)) || !this.retryable(p, c)) {
        this.pending.delete(key);
        continue;
      }
      if (
        this.time + 1e-9 < p.next ||
        retries >= budget ||
        this.active.length + (c.reserved ?? 0) >= MOMENTS.capacity ||
        (p.kind === 'ball' && this.active.filter((m) => m.kind === 'ball').length >= MOMENTS.balls)
      )
        continue;
      retries++;
      this.stats.checks++;
      this.attempt(key, p, c);
    }
    const width = MOMENTS.binMeters * c.perMeter;
    const { bins, binPool, lists, children } = this;
    bins.clear();
    for (const list of binPool) list.length = 0;
    for (const list of lists) list.length = 0;
    children.clear();
    let usedBins = 0;
    // Signed integer coordinates mapped to a unique, numeric Cantor pair.
    const key = (x: number, y: number) => {
      const a = x >= 0 ? 2 * x : -2 * x - 1;
      const b = y >= 0 ? 2 * y : -2 * y - 1;
      return ((a + b) * (a + b + 1)) / 2 + b;
    };
    for (const a of actors) {
      const k = key(Math.floor(a.x / width), Math.floor(a.y / width));
      const list = bins.get(k);
      if (list) list.push(a);
      else {
        const bucket = binPool[usedBins] ?? (binPool[usedBins] = []);
        usedBins++;
        bucket.push(a);
        bins.set(k, bucket);
      }
    }
    const visitorReactions = this.dialogue.some((entry) => entry.kind === 'look');
    // Visitors already looking at their monument should not wait behind a tile's walkers
    // for their first reaction. The shared cursor still visits every candidate afterward.
    for (const a of actors) {
      if (a.type === 'walker') lists[0]!.push(a);
      else {
        if (social.has(a.place!)) lists[1]!.push(a);
        if (a.place === 'school' || a.place === 'pitch') lists[2]!.push(a);
        if (visitorReactions && (a.place === 'monument' || a.place === 'fountain') && a.idle)
          lists[3]!.push(a);
      }
    }
    for (const walker of lists[0]!) lists[3]!.push(walker);
    for (const a of lists[2]!)
      if (a.figure === 'child') children.set(a.source!, (children.get(a.source!) ?? 0) + 1);
    const neighbor = (a: MomentActor<Owner>, k: number) => {
      const bx = Math.floor(a.x / width),
        by = Math.floor(a.y / width);
      const local = this.localBins;
      local.length = 0;
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
    for (let check = retries; check < budget; check++) {
      const k = (this.priority + check) % kinds.length,
        kind = kinds[k]!;
      this.stats.checks++;
      const list = lists[k]!;
      if (!list.length || this.active.length + (c.reserved ?? 0) >= MOMENTS.capacity) continue;
      const a = list[this.cursor[k]!++ % list.length]!;
      if (!this.free(a)) continue;
      if (kind === 'look') {
        const lookAnchors = c.anchors.filter((a) => !a.kind || LOOK_ANCHORS.includes(a.kind));
        if (!lookAnchors.length) continue;
        const visitor = a.type === 'gatherer';
        const anchor = visitor
          ? lookAnchors.find((entry) => entry.source === a.source)
          : lookAnchors[this.neighbors[k]!++ % lookAnchors.length];
        if (!anchor) continue;
        const d = distance(a, anchor) / c.perMeter;
        if (d <= 0 || d > MOMENTS.look.reach || !this.available(a, c)) continue;
        if (visitor) {
          // These visitors already attend their monument while paused. Give that action
          // its reaction once, using the same guarded admission and cooldown as walkers.
          const episode = this.episodes.get(a.owner)!;
          if (episode.look) continue;
          episode.look = true;
          this.attempt(
            `visit:${this.ids.get(a.owner)}`,
            { kind, members: [a], anchor, next: this.time },
            c,
          );
          continue;
        }
        const approach = `look:${this.ids.get(a.owner)}:${anchor.source}`;
        if (this.approaches.has(approach)) continue;
        this.approaches.set(approach, { a, b: anchor, radius: MOMENTS.look.rearm });
        if (this.rng() < MOMENTS.look.chance)
          this.attempt(approach, { kind, members: [a], anchor, next: this.time }, c);
        continue;
      }
      const b = neighbor(a, k);
      if (!b || a === b || !this.free(b)) continue;
      const d = distance(a, b) / c.perMeter;
      if (d <= 0 || d < c.clearance(a) + c.clearance(b)) continue;
      if (kind === 'greet') {
        if (
          b.type !== 'walker' ||
          d > this.reach(a, b, MOMENTS.greet.reach, c) ||
          a.hx * b.hx + a.hy * b.hy >= MOMENTS.greet.opposition
        )
          continue;
        const ids = [this.ids.get(a.owner)!, this.ids.get(b.owner)!].sort((a, b) => a - b);
        const approach = `greet:${ids.join(':')}`;
        if (this.approaches.has(approach)) continue;
        if (!this.available(a, c) || !this.available(b, c)) continue;
        this.approaches.set(approach, {
          a,
          b,
          radius: this.reach(a, b, MOMENTS.greet.reach, c) + MOMENTS.greet.rearm,
        });
        if (this.rng() < MOMENTS.greet.chance)
          this.attempt(approach, { kind, members: [a, b], next: this.time }, c);
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
          if (!social.has(a.place!) || d > this.reach(a, b, MOMENTS.talk.reach, c) || episode.talk)
            continue;
          if (!this.available(a, c) || !this.available(b, c)) continue;
          episode.talk = true;
          if (this.rng() >= MOMENTS.talk.chance) continue;
          const members = [a, b];
          if (this.rng() < MOMENTS.talk.third) {
            // One extra bounded candidate, charged against the same scan budget.
            if (++check < budget) {
              this.stats.checks++;
              const third = neighbor(a, k);
              if (
                third &&
                third !== a &&
                third !== b &&
                third.type === 'gatherer' &&
                third.source === a.source &&
                third.place === a.place &&
                third.idle &&
                this.available(third, c) &&
                members.every(
                  (p) =>
                    distance(p, third) / c.perMeter >= c.clearance(p) + c.clearance(third) &&
                    distance(p, third) / c.perMeter <= this.reach(p, third, MOMENTS.talk.reach, c),
                )
              )
                members.push(third);
            }
          }
          this.attempt(`talk:${this.ids.get(a.owner)}`, { kind, members, next: this.time }, c);
        } else {
          const childOnly = a.place === 'school' || (children.get(a.source!) ?? 0) >= 2;
          if (
            d < MOMENTS.ball.minimum ||
            d > this.reach(a, b, MOMENTS.ball.reach, c) ||
            episode.ball ||
            (childOnly && (a.figure !== 'child' || b.figure !== 'child')) ||
            this.active.filter((m) => m.kind === 'ball').length >= MOMENTS.balls
          )
            continue;
          if (!this.available(a, c) || !this.available(b, c)) continue;
          episode.ball = true;
          if (this.rng() < MOMENTS.ball.chance)
            this.attempt(
              `ball:${this.ids.get(a.owner)}`,
              { kind, members: [a, b], next: this.time },
              c,
            );
        }
      }
    }
    this.priority = (this.priority + 1) % kinds.length;
  }
  private start(
    kind: MomentKind,
    members: MomentActor<Owner>[],
    anchor: MomentAnchor | undefined,
    c: MomentContext<Owner>,
  ) {
    const center = anchor ?? {
      x: members.reduce((sum, a) => sum + a.x, 0) / members.length,
      y: members.reduce((sum, a) => sum + a.y, 0) / members.length,
    };
    const admitted: MomentActor<Owner>[] = [];
    for (const a of members) {
      const d = distance(a, center);
      if (d <= 1e-9 || !c.face(a, (center.x - a.x) / d, (center.y - a.y) / d)) {
        for (let i = admitted.length - 1; i >= 0; i--) c.release(admitted[i]!);
        return false;
      }
      admitted.push(a);
    }
    const nearby = c.anchors.filter((a) =>
      members.every((member) => distance(member, a) / c.perMeter <= MOMENTS.look.reach),
    );
    const dialogue = this.selector.choose(
      kind,
      {
        minutes: c.minutes ?? 720,
        rain: c.rain,
        wind: c.wind ?? 0,
        place: members[0]?.place,
        figures: members.map((a) => a.figure),
        anchors: (anchor ? [anchor] : nearby).map((a) => a.kind ?? 'monument'),
      },
      members.map((a) => a.owner),
      false,
    );
    const focus = dialogue?.conditions?.anchor
      ? nearby.find((a) => a.kind === dialogue.conditions!.anchor)
      : undefined;
    if (focus && dialogue?.profile === 'directions') {
      const respondent = members[1]!;
      const d = distance(respondent, focus);
      if (
        d <= 1e-9 ||
        !c.face(respondent, (focus.x - respondent.x) / d, (focus.y - respondent.y) / d)
      ) {
        for (const actor of admitted) c.release(actor);
        return false;
      }
    }
    if (dialogue)
      this.selector.admit(
        dialogue,
        members.map((a) => a.owner),
      );
    const m: Moment<Owner> = {
      id: ++this.serial,
      dialogue,
      voiced:
        !!dialogue &&
        this.selector.memory.ready(
          members.map((a) => a.owner),
          c.clock ?? this.time,
        ) &&
        this.selector.memory.voiced(dialogue),
      focus,
      speechHolder: 0,
      lastSpeech: -Infinity,
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
    if (m.dialogue && kind !== 'ball') m.speechStart = m.start;
    if (m.dialogue && kind === 'greet')
      m.end = m.start + MOMENTS.greet.speechTurn * m.dialogue.turns;
    if (m.dialogue?.profile && kind === 'talk')
      m.end = m.start + MOMENTS.talk.speechTurn * m.dialogue.turns;
    if (kind === 'talk') {
      const turn = between(this.rng, MOMENTS.talk.turn);
      m.turnEnd += m.dialogue ? MOMENTS.talk.speechTurn : turn;
    }
    if (kind === 'ball') m.phaseEnd += between(this.rng, MOMENTS.ball.hold);
    if (kind === 'look') m.point = this.rng() < MOMENTS.look.point;
    if (dialogue)
      this.selector.memory.reserve(
        members.map((a) => a.owner),
        (c.clock ?? this.time) + m.end - m.start + MOMENTS.cooldown,
      );
    this.active.push(m);
    for (const a of members) this.membership.set(a.owner, m);
    this.stats.started[kind]++;
    return true;
  }
}

export type SpeechCue = { id: string; exchangeId: string; line: number; member?: number };
