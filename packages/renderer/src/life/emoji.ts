/** Read-only moods. All randomness, timers and identities belong to this observer. */
import {
  EMOJI_ZOOM,
  EMOJI_EVENING,
  type EmojiMood,
  type EmojiSubject,
  type SeasonEmojiEntry,
} from '@atlas/shared';
import { random } from './random';
import type { Gatherer, LifeEnv, Mover, Stall } from './simulate';
import type { Visit } from './interactions';

const DAY_MS = 24 * 60 * 60 * 1000;
export const EMOJI = {
  tick: 0.5,
  capacity: 4,
  duration: 2.5,
  sleeping: 5,
  cooldown: 45,
  chance: 0.35,
  ambientWindow: 60,
  ambientChance: 0.15,
  seasonalChance: 0.2,
  followupChance: 0.25,
  playfulShare: 0.5,
  maxFollowups: 4,
  maxCats: 6,
  stoppedSpeed: 0.3,
  cruiseFraction: 0.85,
  hotAltitude: 45,
  rainThreshold: 0.5,
  driver: { angryWait: 6, angryStop: 25, impatientWait: 2, boredStop: 8, coolCruise: 8 },
  person: { impatientWait: 12, blockedWait: 3 },
  pet: { blockedWait: 1.5, rest: { day: 20, night: 10 } },
  standoff: 4,
  firstAttempt: [2, 12] as const,
  pairReach: 3,
  hours: { night: [1320, 390], coffee: [330, 540], hot: [660, 870] },
} as const;
export type EmojiCue = {
  id: string;
  subject: EmojiSubject;
  mood: EmojiMood;
  pair?: string;
  order?: 0 | 1;
};
export type Temperament = 'neutral' | 'cheerful' | 'grumpy' | 'sleepy';
export const TEMPERAMENT: Record<
  Temperament,
  {
    chances: Partial<Record<EmojiMood, number>>;
    up: readonly EmojiMood[];
    down: readonly EmojiMood[];
  }
> = {
  neutral: { chances: {}, up: [], down: [] },
  cheerful: {
    chances: { impatient: 0.2, angry: 0.2, happy: 0.5, cool: 0.5, playful: 0.5 },
    up: ['happy', 'cool', 'playful', 'love', 'party', 'festive', 'music', 'wave', 'thumbs'],
    down: ['bored', 'hot'],
  },
  grumpy: {
    chances: { impatient: 0.55, angry: 0.55, happy: 0.2 },
    up: ['impatient', 'bored', 'hot', 'angry'],
    down: ['happy', 'cool', 'playful', 'love'],
  },
  sleepy: { chances: {}, up: ['sleepy', 'sleeping', 'coffee'], down: ['cool', 'party'] },
};
export function temperament(rank: number): Temperament {
  const v = Math.sin(rank * 12.9898) * 43758.5453;
  const t = v - Math.floor(v);
  return t < 0.5 ? 'neutral' : t < 0.7 ? 'cheerful' : t < 0.9 ? 'grumpy' : 'sleepy';
}
export const inHours = (minutes: number | undefined, [from, to]: readonly [number, number]) =>
  minutes !== undefined &&
  (to < from ? minutes >= from || minutes < to : minutes >= from && minutes < to);
export function eveningDate(env: Pick<LifeEnv, 'date' | 'minutes'>) {
  if (!env.date || env.minutes === undefined) return;
  const d = new Date((env.date.epochDay - Number(env.minutes < EMOJI_EVENING.end)) * DAY_MS);
  return { month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}
export type EmojiObservation = {
  owner: Mover | Gatherer | Stall;
  subject: EmojiSubject;
  figure?: 'adult' | 'child';
  eligible: boolean;
  speaking: boolean;
  mover?: Mover;
  gatherer?: Gatherer;
  visit?: Visit;
  held?: boolean;
  passenger?: Mover;
  arrival?: boolean;
  still?: boolean;
  vendor?: boolean;
};
type Weighted = { mood: EmojiMood; weight: number };
export function seasonalPool(
  o: EmojiObservation,
  env: LifeEnv,
  entries: readonly SeasonEmojiEntry[],
): Weighted[] {
  const date = eveningDate(env);
  return entries.flatMap((e) => {
    if (
      !e.subjects.includes(o.subject) ||
      (e.figure && e.figure !== o.figure) ||
      (e.hours && !inHours(env.minutes, e.hours))
    )
      return [];
    if (
      e.days &&
      !env.date?.preview &&
      (!date || !e.days.some((d) => d.month === date.month && d.day === date.day))
    )
      return [];
    return [{ mood: e.mood, weight: e.weight * (e.days && env.date?.preview ? 0.5 : 1) }];
  });
}
export function ambientPool(
  o: EmojiObservation,
  env: LifeEnv,
  entries: readonly SeasonEmojiEntry[] = [],
  cruise = 0,
): Weighted[] {
  const pool = seasonalPool(o, env, entries);
  const add = (mood: EmojiMood, weight = 1.5) => pool.push({ mood, weight });
  const { subject, mover: m, gatherer: g } = o;
  const human = subject === 'person' || subject === 'driver';
  if (human && inHours(env.minutes, EMOJI.hours.night)) add('sleepy');
  if (
    human &&
    inHours(env.minutes, EMOJI.hours.coffee) &&
    (subject === 'driver' || o.figure === 'adult')
  )
    add('coffee');
  const open = m?.vehicle && ['motorcycle', 'bicycle', 'tricycle', 'jeepney'].includes(m.vehicle);
  if (
    inHours(env.minutes, EMOJI.hours.hot) &&
    env.rain === 0 &&
    (env.sunAltitude ?? -90) >= EMOJI.hotAltitude &&
    (subject === 'person' ||
      (subject === 'driver' && open) ||
      ((subject === 'dog' || subject === 'cat') && o.still))
  )
    add('hot');
  if (
    env.rain >= EMOJI.rainThreshold &&
    ((subject === 'person' && o.visit?.state !== 'shelter') ||
      (subject === 'driver' && (m?.vehicle === 'motorcycle' || m?.vehicle === 'bicycle')))
  )
    add('rained');
  if (subject === 'person' && (env.windPreset === 'gusty' || env.windPreset === 'storm'))
    add('windy');
  if (subject === 'driver' && cruise >= EMOJI.driver.coolCruise) add('cool', 1);
  if (subject === 'person' && m?.group?.length === 1) add('bored', 1);
  if (g) {
    if (g.behavior === 'play') add('playful', 1);
    if (g.behavior === 'sit') add('relaxed', 1);
    if (g.behavior === 'work' && (env.sunAltitude ?? -90) > 0) add('working', 1);
    if (g.behavior === 'gather') add('happy', 1);
    if (g.place === 'worship')
      add('pray', env.date?.weekday === 0 && inHours(env.minutes, [360, 660]) ? 4.5 : 1.5);
    if (
      g.place === 'school' &&
      env.date &&
      env.date.weekday > 0 &&
      env.date.weekday < 6 &&
      inHours(env.minutes, [420, 1020])
    )
      add('study');
    if (g.place === 'pitch' && g.behavior === 'play') add('basketball');
    if (g.place === 'monument' && (env.sunAltitude ?? -90) > 0) add('photo');
    if (g.place === 'farm' && g.behavior === 'work' && (env.sunAltitude ?? -90) > 0) add('harvest');
  }
  const t = TEMPERAMENT[temperament(o.owner.rank)];
  return pool.map((p) => ({
    ...p,
    weight: p.weight * (t.up.includes(p.mood) ? 2 : t.down.includes(p.mood) ? 0.5 : 1),
  }));
}
// Only sampled event conditions use this mask; ambient moods remain weighted entries.
const CONDITIONS = {
  angry: 1 << 0,
  impatient: 1 << 1,
  sleeping: 1 << 2,
  sleepy: 1 << 3,
  happy: 1 << 4,
  bored: 1 << 5,
} as const;
const CONDITION_MOODS = Object.keys(CONDITIONS) as (keyof typeof CONDITIONS)[];
type Track = {
  cooldownUntil: number;
  attemptAt?: number;
  clock?: number;
  epoch: number;
  rest: number;
  stop: number;
  cruise: number;
  wait: number;
  resting: boolean;
  stopped: boolean;
  cruising: boolean;
  visit?: { identity: Visit; state: Visit['state']; time: number; stall?: Stall };
  passenger?: Mover;
  trot: boolean;
  grooming: boolean;
  lying: boolean;
  paused: boolean;
  triggers: number;
  edges: Set<EmojiMood>;
  replies: Map<EmojiMood, object>;
  seen: WeakSet<object>;
  followups: object[];
  rng: () => number;
  group?: Group;
  eligible?: boolean;
  speaking?: boolean;
  standoff?: object;
};
type Episode = { owner: object; cue: EmojiCue };
type Group = { index: EmojiObserver; members: Episode[]; end: number };
/** Weak tracks do not keep departed owners alive. Only bounded active groups hold owners. */
export class EmojiMemory {
  private tracks = new WeakMap<object, Track>();
  private serial = 0;
  private generation = 0;
  reset() {
    this.tracks = new WeakMap();
    this.serial = 0;
    this.generation++;
  }
  id() {
    return `emoji:${this.generation}:${++this.serial}`;
  }
  track(owner: object, epoch: number, rng: () => number, ownerRng?: () => number): Track {
    let t = this.tracks.get(owner);
    if (!t) {
      t = {
        cooldownUntil: 0,
        epoch,
        rest: 0,
        stop: 0,
        cruise: 0,
        wait: 0,
        resting: false,
        stopped: false,
        cruising: false,
        trot: false,
        grooming: false,
        lying: false,
        paused: false,
        triggers: 0,
        edges: new Set(),
        replies: new Map(),
        seen: new WeakSet(),
        followups: [],
        rng: ownerRng ?? random(Math.floor(rng() * 4294967296)),
      };
      this.tracks.set(owner, t);
    }
    return t;
  }
  get(owner: object) {
    return this.tracks.get(owner);
  }
  cue(owner: object) {
    return this.get(owner)?.group?.members.find((e) => e.owner === owner)?.cue;
  }
  retire(group: Group) {
    group.index.groups.delete(group);
    for (const e of group.members) {
      const t = this.get(e.owner);
      if (t?.group === group) t.group = undefined;
    }
    group.members.length = 0;
  }
}
export type EmojiObserverOptions = { memory?: EmojiMemory; enabled?: boolean; rng?: () => number };
export class EmojiObserver {
  readonly groups = new Set<Group>();
  readonly memory: EmojiMemory;
  private readonly enabled: boolean;
  private readonly rng: () => number;
  private epoch = 0;
  private nextTick = 0;
  private clock = 0;
  private frozenAt?: number;
  private readonly ownerRng?: () => number;
  private table?: LifeEnv['emojiSeasons'];
  private season?: string | null;
  private entries: readonly SeasonEmojiEntry[] = [];
  constructor(
    seed: number,
    readonly perMeter: number,
    options: EmojiObserverOptions = {},
  ) {
    this.memory = options.memory ?? new EmojiMemory();
    this.enabled = options.enabled ?? true;
    this.rng = options.rng ?? random(seed ^ 0x3b1d5e27);
    this.ownerRng = options.rng;
  }
  cue(owner: object) {
    return this.memory.cue(owner);
  }
  observes(zoom: number) {
    return this.enabled && zoom >= EMOJI_ZOOM;
  }
  get size() {
    return this.groups.size;
  }
  dispose() {
    for (const g of this.groups) this.memory.retire(g);
    this.epoch++;
  }
  freeze() {
    this.frozenAt ??= this.clock;
    this.epoch++;
    this.nextTick = 0;
  }
  release(owner: object) {
    const g = this.memory.get(owner)?.group;
    if (g?.index === this) this.memory.retire(g);
  }
  adopt(owner: object, source: EmojiObserver) {
    if (this.memory !== source.memory) {
      source.release(owner);
      return;
    }
    const t = this.memory.get(owner);
    if (!t) return;
    t.epoch = t.epoch === source.epoch ? this.epoch : -1;
    const g = t.group;
    if (!g || g.index === this) return;
    if (this.size >= EMOJI.capacity) {
      this.memory.retire(g);
      return;
    }
    g.index.groups.delete(g);
    this.groups.add(g);
    g.index = this;
  }
  private chance(o: EmojiObservation, mood: EmojiMood) {
    return TEMPERAMENT[temperament(o.owner.rank)].chances[mood] ?? EMOJI.chance;
  }
  private admit(
    o: EmojiObservation,
    mood: EmojiMood,
    observations: readonly EmojiObservation[],
    reply?: object,
    replyMood?: EmojiMood,
  ) {
    const t = this.memory.get(o.owner)!;
    if (
      !o.eligible ||
      o.speaking ||
      t.group ||
      this.clock < t.cooldownUntil ||
      this.size >= EMOJI.capacity
    )
      return false;
    const partner =
      reply &&
      observations.find(
        (p) =>
          p.owner === reply &&
          p.eligible &&
          !p.speaking &&
          !this.memory.get(p.owner)?.group &&
          Math.hypot(p.owner.x - o.owner.x, p.owner.y - o.owner.y) <=
            EMOJI.pairReach * this.perMeter,
      );
    const pair = partner ? this.memory.id() : undefined;
    const members: Episode[] = [
      {
        owner: o.owner,
        cue: { id: this.memory.id(), subject: o.subject, mood, order: 0, ...(pair && { pair }) },
      },
    ];
    if (partner)
      members.push({
        owner: partner.owner,
        cue: {
          id: this.memory.id(),
          subject: partner.subject,
          mood: replyMood ?? 'happy',
          pair,
          order: 1,
        },
      });
    const g: Group = {
      index: this,
      members,
      end: this.clock + (mood === 'sleeping' ? EMOJI.sleeping : EMOJI.duration),
    };
    this.groups.add(g);
    for (const e of members) {
      const state = this.memory.get(e.owner)!;
      state.group = g;
      state.cooldownUntil = this.clock + EMOJI.cooldown;
    }
    return true;
  }
  step(
    dt: number,
    zoom: number,
    env: LifeEnv,
    observations: readonly EmojiObservation[],
    purchases: readonly { mover: Mover; stall: Stall; key: object }[] = [],
    completions: readonly { token: object; owners: readonly object[] }[] = [],
  ) {
    this.clock = env.clock ?? this.clock + dt;
    if (!this.observes(zoom)) {
      this.dispose();
      this.freeze();
      return;
    }
    if (this.frozenAt !== undefined) {
      for (const g of this.groups) g.end += this.clock - this.frozenAt;
      this.frozenAt = undefined;
    }
    if (this.table !== env.emojiSeasons || this.season !== env.season) {
      this.table = env.emojiSeasons;
      this.season = env.season;
      this.entries = this.table?.find((s) => s.id === this.season)?.emoji ?? [];
    }
    const night = inHours(env.minutes, EMOJI.hours.night);
    for (const o of observations) {
      const existing = this.memory.get(o.owner);
      if (!o.eligible && !existing) continue;
      const t = existing ?? this.memory.track(o.owner, this.epoch, this.rng, this.ownerRng);
      t.eligible = o.eligible;
      t.speaking = o.speaking;
      const gap =
        t.epoch !== this.epoch || (t.clock !== undefined && this.clock - t.clock > dt + 0.00001);
      if (!o.eligible) {
        this.release(o.owner);
        t.clock = undefined;
        t.epoch = -1;
        t.edges.clear();
        t.replies.clear();
        t.followups.length = 0;
        continue;
      }
      if (gap) {
        t.rest = t.stop = t.cruise = t.wait = 0;
        t.edges.clear();
        t.replies.clear();
        t.followups.length = 0;
        t.visit = undefined;
        t.passenger = o.passenger;
        if (t.attemptAt !== undefined && t.attemptAt <= this.clock)
          t.attemptAt = this.clock + EMOJI.ambientWindow;
      }
      t.epoch = this.epoch;
      t.clock = this.clock;
      if (t.attemptAt === undefined) {
        // Bias the one initial opportunity toward the early part of its 2–12 s window.
        // Slow rendering must not require most owners to wait near the upper bound.
        const delay = t.rng();
        const [lo, hi] = EMOJI.firstAttempt;
        t.attemptAt = this.clock + lo + delay * delay * (hi - lo);
      }
      const m = o.mover;
      const resting =
        !!o.still &&
        !m?.grooming &&
        (o.subject === 'cat' || (o.subject === 'dog' && (!!m?.lying || o.visit?.state === 'rest')));
      const stopped = m?.v !== undefined && m.v / this.perMeter < EMOJI.stoppedSpeed;
      const cruising = m?.v !== undefined && m.v >= EMOJI.cruiseFraction * m.speed;
      t.rest = resting ? (!gap && t.resting ? t.rest + dt : 0) : 0;
      t.stop = stopped ? (!gap && t.stopped ? t.stop + dt : 0) : 0;
      t.cruise = cruising ? (!gap && t.cruising ? t.cruise + dt : 0) : 0;
      t.wait =
        o.visit?.state === 'wait' &&
        !gap &&
        t.visit?.identity === o.visit &&
        t.visit.state === 'wait'
          ? t.wait + dt
          : 0;
      let conditions = 0;
      if (o.subject === 'driver') {
        if ((m?.waiting ?? 0) >= EMOJI.driver.angryWait || t.stop + 1e-8 >= EMOJI.driver.angryStop)
          conditions |= CONDITIONS.angry;
        if ((m?.waiting ?? 0) >= EMOJI.driver.impatientWait) conditions |= CONDITIONS.impatient;
        if (!gap && o.passenger && o.passenger !== t.passenger) {
          t.edges.add('happy');
          t.replies.set('happy', o.passenger);
        }
        if (t.stop + 1e-8 >= EMOJI.driver.boredStop && !o.held) conditions |= CONDITIONS.bored;
      } else if (o.subject === 'dog' || o.subject === 'cat') {
        if (o.subject === 'dog' && (m?.waiting ?? 0) >= EMOJI.pet.blockedWait)
          conditions |= CONDITIONS.angry;
        if (t.rest + 1e-8 >= (night ? EMOJI.pet.rest.night : EMOJI.pet.rest.day))
          conditions |= CONDITIONS.sleeping;
        if (
          night &&
          ((!t.lying && m?.lying) || (o.subject === 'cat' && !t.paused && (m?.pause ?? 0) > 0))
        )
          conditions |= CONDITIONS.sleepy;
        if (
          ((m?.trot ?? 0) > 0 && !t.trot) ||
          (!!m?.grooming && !t.grooming) ||
          (o.visit?.state === 'rest' && t.visit?.state !== 'rest')
        )
          conditions |= CONDITIONS.happy;
      } else if (!o.vendor) {
        if (
          t.wait + 1e-8 >= EMOJI.person.impatientWait ||
          (m?.waiting ?? 0) >= EMOJI.person.blockedWait
        )
          conditions |= CONDITIONS.impatient;
        if (
          !gap &&
          o.visit?.state === 'shelter' &&
          t.visit?.state !== 'shelter' &&
          env.rain >= EMOJI.rainThreshold
        )
          t.edges.add('rained');
        if (!gap && o.arrival && o.visit?.state === 'wait') t.edges.add('happy');
      }
      const edges = conditions & ~t.triggers;
      if (!gap) for (const mood of CONDITION_MOODS) if (edges & CONDITIONS[mood]) t.edges.add(mood);
      t.triggers = conditions;
      t.resting = resting;
      t.stopped = stopped;
      t.cruising = cruising;
      t.trot = (m?.trot ?? 0) > 0;
      t.grooming = !!m?.grooming;
      t.lying = !!m?.lying;
      t.paused = (m?.pause ?? 0) > 0;
      t.passenger = o.passenger;
      if (o.visit) {
        t.visit ??= {
          identity: o.visit,
          state: o.visit.state,
          time: o.visit.time,
          stall: o.visit.site.stall,
        };
        t.visit.identity = o.visit;
        t.visit.state = o.visit.state;
        t.visit.time = o.visit.time;
        t.visit.stall = o.visit.site.stall;
      } else t.visit = undefined;
      if (!gap) {
        for (const p of purchases)
          if (p.mover === o.owner && !t.seen.has(p.key)) {
            t.seen.add(p.key);
            t.edges.add('yummy');
            t.replies.set('yummy', p.stall);
          }
        for (const c of completions)
          if (c.owners.includes(o.owner) && !t.seen.has(c.token)) {
            t.seen.add(c.token);
            if (t.followups.length < EMOJI.maxFollowups) t.followups.push(c.token);
          }
      }
    }
    for (const g of this.groups)
      if (
        this.clock >= g.end ||
        g.members.some((e) => {
          const t = this.memory.get(e.owner);
          return !t?.eligible || t.speaking;
        })
      )
        this.memory.retire(g);
    if (this.clock + 1e-8 < this.nextTick) return;
    this.nextTick = (Math.floor((this.clock + 1e-8) / EMOJI.tick) + 1) * EMOJI.tick;
    // Pair opportunities precede all solo admissions. Cat scans are deliberately bounded.
    const cats = observations
      .filter((o) => o.subject === 'cat' && o.eligible)
      .slice(0, EMOJI.maxCats);
    for (const dog of observations.filter((o) => o.subject === 'dog' && o.eligible)) {
      const t = this.memory.get(dog.owner)!;
      const cat = cats.find(
        (c) =>
          Math.hypot(c.owner.x - dog.owner.x, c.owner.y - dog.owner.y) <=
          EMOJI.standoff * this.perMeter,
      );
      const edge = !!cat && t.standoff !== cat.owner;
      t.standoff = cat?.owner;
      if (edge && t.rng() < this.chance(dog, 'angry'))
        this.admit(dog, 'angry', observations, cat.owner, 'angry');
    }
    for (const cat of cats) {
      const t = this.memory.get(cat.owner)!;
      const dog = observations.find(
        (o) =>
          o.subject === 'dog' &&
          o.eligible &&
          Math.hypot(o.owner.x - cat.owner.x, o.owner.y - cat.owner.y) <=
            EMOJI.standoff * this.perMeter,
      );
      if (dog && t.standoff !== dog.owner) t.edges.add('angry');
      t.standoff = dog?.owner;
    }
    const priorities: readonly EmojiMood[] = [
      'angry',
      'impatient',
      'sleeping',
      'sleepy',
      'rained',
      'yummy',
      'happy',
      'bored',
    ];
    for (const o of observations) {
      const t = this.memory.get(o.owner);
      if (!t) continue;
      for (const mood of priorities) {
        if (!t.edges.has(mood)) continue;
        let reply = t.replies.get(mood),
          replyMood: EmojiMood = mood === 'yummy' ? 'happy' : mood === 'happy' ? 'wave' : 'sorry';
        if (
          o.subject === 'driver' &&
          (mood === 'impatient' || mood === 'angry') &&
          (o.mover?.waiting ?? 0) >= EMOJI.driver.impatientWait
        ) {
          const m = o.mover!;
          reply = observations
            .filter(
              (p) =>
                p.mover?.group &&
                p.eligible &&
                (p.owner.x - m.x) * m.hx + (p.owner.y - m.y) * m.hy > 0,
            )
            .sort(
              (a, b) =>
                Math.hypot(a.owner.x - m.x, a.owner.y - m.y) -
                Math.hypot(b.owner.x - m.x, b.owner.y - m.y),
            )[0]?.owner;
          replyMood = 'sorry';
        }
        if (t.rng() < this.chance(o, mood)) this.admit(o, mood, observations, reply, replyMood);
      }
      t.edges.clear();
      t.replies.clear();
      if (!o.vendor)
        for (let i = 0; i < t.followups.length; i++) {
          const adjustment = this.chance(o, 'playful') / EMOJI.chance;
          if (t.rng() < EMOJI.followupChance * adjustment)
            this.admit(o, t.rng() < EMOJI.playfulShare ? 'playful' : 'thumbs', observations);
        }
      t.followups.length = 0;
      if (!o.eligible || t.attemptAt === undefined || this.clock + 1e-8 < t.attemptAt) continue;
      t.attemptAt = this.clock + EMOJI.ambientWindow;
      const pool = ambientPool(o, env, this.entries, t.cruise);
      const applicable = seasonalPool(o, env, this.entries).length > 0;
      if (t.rng() >= (applicable ? EMOJI.seasonalChance : EMOJI.ambientChance) || !pool.length)
        continue;
      let pick = t.rng() * pool.reduce((sum, p) => sum + p.weight, 0);
      const mood = pool.find((p) => (pick -= p.weight) < 0)?.mood ?? pool.at(-1)!.mood;
      if (!o.vendor) this.admit(o, mood, observations);
    }
  }
}
