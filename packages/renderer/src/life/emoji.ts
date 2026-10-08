/** Read-only moods. All randomness, timers and identities belong to this observer. */
import {
  EMOJI_ZOOM,
  EMOJI_EVENING,
  type EmojiMood,
  type EmojiSubject,
  type SeasonEmojiEntry,
} from '@atlas/shared';
import { random } from './random';
import type { Flock, Gatherer, LifeEnv, Mover, Stall } from './simulate';
import type { Visit } from './interactions';
import { exhaustKind, PUFF } from './exhaust';
import { HEAT, hotAt, inHours } from './config';
export { inHours } from './config';

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
  honkShare: 0.4,
  gossipShare: 1 / 3,
  variantShare: 1 / 3,
  churchWeight: 0.15,
  maxFollowups: 4,
  maxCats: 6,
  stoppedSpeed: 0.3,
  cruiseFraction: 0.85,
  hotAltitude: HEAT.altitude,
  rainThreshold: 0.5,
  driver: {
    angryWait: 6,
    angryStop: 25,
    impatientWait: 2,
    boredStop: 8,
    coolCruise: 8,
    rushSpeed: 10,
  },
  person: { impatientWait: 12, blockedWait: 3 },
  pet: { blockedWait: 1.5, rest: { day: 20, night: 10 } },
  standoff: 4,
  firstAttempt: [2, 12] as const,
  pairReach: 3,
  begReach: 4,
  hours: {
    night: [1320, 390],
    coffee: [330, 540],
    hot: HEAT.hours,
    mosquito: [1050, 1170],
    karaoke: [1140, 1380],
    churchMorning: [300, 540],
  },
} as const;
export type EmojiCue = {
  id: string;
  subject: EmojiSubject;
  mood: EmojiMood;
  pair?: string;
  order?: 0 | 1;
};
export type EmojiRequest = {
  owner: object;
  subject: EmojiSubject;
  mood: EmojiMood;
  eligible: boolean;
  speaking: boolean;
  duration?: number;
  expires: number;
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
    up: [
      'happy',
      'cool',
      'playful',
      'love',
      'party',
      'festive',
      'music',
      'wave',
      'thumbs',
      'karaoke',
    ],
    down: ['bored', 'hot'],
  },
  grumpy: {
    chances: { impatient: 0.55, angry: 0.55, happy: 0.2 },
    up: ['impatient', 'bored', 'hot', 'angry', 'sneeze', 'mosquito'],
    down: ['happy', 'cool', 'playful', 'love'],
  },
  sleepy: { chances: {}, up: ['sleepy', 'sleeping', 'coffee'], down: ['cool', 'party', 'karaoke'] },
};
export function temperament(rank: number): Temperament {
  const v = Math.sin(rank * 12.9898) * 43758.5453;
  const t = v - Math.floor(v);
  return t < 0.5 ? 'neutral' : t < 0.7 ? 'cheerful' : t < 0.9 ? 'grumpy' : 'sleepy';
}
export function eveningDate(env: Pick<LifeEnv, 'date' | 'minutes'>) {
  if (!env.date || env.minutes === undefined) return;
  const d = new Date((env.date.epochDay - Number(env.minutes < EMOJI_EVENING.end)) * DAY_MS);
  return { month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}
export type EmojiObservation = {
  owner: Mover | Gatherer | Stall | Flock;
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
function selectedSeason(env: Pick<LifeEnv, 'emojiSeasons' | 'season'>) {
  return env.emojiSeasons?.find((season) => season.id === env.season);
}
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
  graveVisitors = !!selectedSeason(env)?.visitors,
): Weighted[] {
  const pool = seasonalPool(o, env, entries);
  const add = (mood: EmojiMood, weight = 1.5) => pool.push({ mood, weight });
  const { subject, mover: m, gatherer: g } = o;
  const still = g ? g.pause > 0 || g.behavior === 'sit' : !!o.still;
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
    hotAt(env.minutes, env.rain, env.sunAltitude) &&
    ((subject === 'person' && o.visit?.state !== 'shade') ||
      (subject === 'driver' && open) ||
      ((subject === 'dog' || subject === 'cat') && o.still))
  ) {
    add('hot');
    if (human) add('melting', 0.5);
  }
  if (
    env.rain >= EMOJI.rainThreshold &&
    ((subject === 'person' && o.visit?.state !== 'shelter') ||
      (subject === 'driver' && (m?.vehicle === 'motorcycle' || m?.vehicle === 'bicycle')))
  )
    add('rained');
  if (subject === 'person' && (env.windPreset === 'gusty' || env.windPreset === 'storm'))
    add('windy');
  if (subject === 'person') {
    if (still && inHours(env.minutes, EMOJI.hours.mosquito)) add('mosquito');
    if (
      (env.rain >= EMOJI.rainThreshold && o.visit?.state !== 'shelter') ||
      env.windPreset === 'storm'
    )
      add('sneeze', 1);
    if (
      g?.behavior === 'gather' &&
      g.place !== 'worship' &&
      inHours(env.minutes, EMOJI.hours.karaoke)
    )
      add('karaoke');
    if (g?.behavior === 'play' && o.figure === 'child') add('silly', 1);
    if (g?.place === 'worship' && g.behavior === 'gather') {
      if (still) {
        for (const mood of ['moved', 'crying', 'angelic', 'hush'] as const)
          add(mood, EMOJI.churchWeight);
        if (inHours(env.minutes, EMOJI.hours.churchMorning)) add('yawn', EMOJI.churchWeight);
      }
      add('music', EMOJI.churchWeight);
      if (graveVisitors) add('candle', EMOJI.churchWeight);
    }
  }
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
  if (!pool.length) return pool;
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
  crying: 1 << 6,
} as const;
const CONDITION_MOODS = Object.keys(CONDITIONS) as (keyof typeof CONDITIONS)[];
type Track = {
  requestedAt?: number;
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
  groomingHappy: boolean;
  rushing: boolean;
  running: boolean;
  turnedAt?: number;
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
        attemptAt: undefined,
        clock: undefined,
        epoch,
        rest: 0,
        stop: 0,
        cruise: 0,
        wait: 0,
        resting: false,
        stopped: false,
        cruising: false,
        visit: undefined,
        passenger: undefined,
        trot: false,
        grooming: false,
        groomingHappy: false,
        rushing: false,
        running: false,
        lying: false,
        paused: false,
        triggers: 0,
        edges: new Set(),
        replies: new Map(),
        seen: new WeakSet(),
        followups: [],
        rng: ownerRng ?? random(Math.floor(rng() * 4294967296)),
        group: undefined,
        eligible: undefined,
        speaking: undefined,
        standoff: undefined,
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
  private graveVisitors = false;
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
  /** Explicit cues do not use observer chance, ambient priorities or cooldown. */
  request(
    requests: readonly EmojiRequest[],
    zoom: number,
    clock: number,
    observations: readonly EmojiObservation[] = [],
  ) {
    if (!this.observes(zoom)) return;
    for (const r of requests.slice(0, 32)) {
      const o = observations.find((candidate) => candidate.owner === r.owner);
      const t = this.memory.get(r.owner);
      if (
        !r.eligible ||
        r.speaking ||
        o?.eligible === false ||
        o?.speaking ||
        r.expires < clock ||
        t?.group ||
        this.size >= EMOJI.capacity ||
        (t?.requestedAt !== undefined && clock - t.requestedAt < 1)
      )
        continue;
      // New event/train owners need a track, without drawing from any existing stream.
      const state = t ?? this.memory.track(r.owner, this.epoch, () => 0, random(0x71a5));
      const g: Group = {
        index: this,
        members: [
          {
            owner: r.owner,
            cue: { id: this.memory.id(), subject: r.subject, mood: r.mood, order: 0 },
          },
        ],
        end: clock + Math.max(0, r.duration ?? EMOJI.duration),
      };
      this.groups.add(g);
      state.group = g;
      state.requestedAt = clock;
    }
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
    // Choose the cat's reply only after the leader and partner admission gates.
    if (
      partner?.subject === 'cat' &&
      o.subject === 'dog' &&
      mood === 'angry' &&
      this.memory.get(partner.owner)!.rng() < EMOJI.variantShare
    )
      replyMood = 'sideeye';
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
    startled: readonly object[] = [],
    requested: readonly EmojiRequest[] = [],
  ) {
    dt = env.emojiTime?.dt ?? dt;
    this.clock = env.emojiTime?.clock ?? env.clock ?? this.clock + dt;
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
      const selected = selectedSeason(env);
      this.entries = selected?.emoji ?? [];
      this.graveVisitors = !!selected?.visitors;
    }
    const night = inHours(env.minutes, EMOJI.hours.night);
    for (const o of observations) {
      const existing = this.memory.get(o.owner);
      if (!o.eligible && !existing) continue;
      // A bird's first track seeds only the observer RNG, never the physical bird stream.
      const t = existing ?? this.memory.track(o.owner, this.epoch, this.rng, this.ownerRng);
      t.eligible = o.eligible;
      t.speaking = o.speaking;
      const gap =
        !existing ||
        t.epoch !== this.epoch ||
        (t.clock !== undefined && this.clock - t.clock > dt + 0.00001);
      if (!o.eligible) {
        this.release(o.owner);
        t.clock = undefined;
        t.epoch = -1;
        t.edges.clear();
        t.groomingHappy = false;
        t.replies.clear();
        t.followups.length = 0;
        t.standoff = undefined;
        t.passenger = undefined;
        t.visit = undefined;
        continue;
      }
      // Explicit flock events survive evaluation gaps, including the first observation.
      // Birds have no sampled conditions, voice follow-ups or ambient opportunities.
      if (o.subject === 'bird') {
        t.epoch = this.epoch;
        t.clock = this.clock;
        if (startled.includes(o.owner)) t.edges.add('scared');
        continue;
      }
      if (gap) {
        t.rest = t.stop = t.cruise = t.wait = 0;
        t.edges.clear();
        t.groomingHappy = false;
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
      const rushing = m?.v !== undefined && m.v / this.perMeter >= EMOJI.driver.rushSpeed;
      const running = (m?.run ?? 0) > 0;
      if (!gap) {
        if (o.subject === 'driver') {
          if (rushing && !t.rushing) t.edges.add('rushing');
          if (
            t.stopped &&
            t.stop + 1e-8 >= PUFF.pullAway.minStop &&
            !stopped &&
            exhaustKind(m?.vehicle)
          )
            t.edges.add('smoke');
        } else if (o.subject === 'person') {
          if (running && !t.running) t.edges.add('rushing');
          if (m?.turnedAt !== undefined && m.turnedAt !== t.turnedAt) t.edges.add('confused');
        }
      }
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
        if (
          !o.held &&
          ((m?.waiting ?? 0) >= EMOJI.driver.angryStop || t.stop + 1e-8 >= EMOJI.driver.angryStop)
        )
          conditions |= CONDITIONS.crying;
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
          !o.held &&
          (t.wait + 1e-8 >= EMOJI.person.impatientWait ||
            (m?.waiting ?? 0) >= EMOJI.person.impatientWait)
        )
          conditions |= CONDITIONS.crying;
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
        if (!gap && o.visit?.state === 'shade' && t.visit?.state !== 'shade')
          t.edges.add('relaxed');
        if (!gap && o.arrival && o.visit?.state === 'wait') t.edges.add('happy');
      }
      const edges = conditions & ~t.triggers;
      if (!gap && edges)
        for (const mood of CONDITION_MOODS) if (edges & CONDITIONS[mood]) t.edges.add(mood);
      if (!gap && edges & CONDITIONS.happy && o.subject === 'cat' && m?.grooming && !t.grooming)
        t.groomingHappy = true;
      t.triggers = conditions;
      t.resting = resting;
      t.stopped = stopped;
      t.cruising = cruising;
      t.trot = (m?.trot ?? 0) > 0;
      t.grooming = !!m?.grooming;
      t.rushing = rushing;
      t.running = running;
      t.turnedAt = m?.turnedAt;
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
        for (const p of purchases) {
          if (p.mover !== o.owner && o.subject !== 'dog') continue;
          if (t.seen.has(p.key)) continue;
          if (p.mover === o.owner) {
            t.seen.add(p.key);
            t.edges.add('yummy');
            t.replies.set('yummy', p.stall);
          } else if (
            o.subject === 'dog' &&
            Math.hypot(o.owner.x - p.mover.x, o.owner.y - p.mover.y) <=
              EMOJI.begReach * this.perMeter + 1e-8
          ) {
            t.seen.add(p.key);
            t.edges.add('beg');
            t.replies.set('beg', p.mover);
          }
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
    this.request(requested, zoom, this.clock, observations);
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
      'crying',
      'angry',
      'impatient',
      'sleeping',
      'sleepy',
      'rained',
      'relaxed',
      'yummy',
      'beg',
      'rushing',
      'smoke',
      'confused',
      'happy',
      'bored',
    ];
    // Give latched purchase owners their opportunity before any dog claims a buyer.
    const buying = (o: EmojiObservation) => this.memory.get(o.owner)?.edges.has('yummy');
    const evaluation = observations.some(buying)
      ? [...observations.filter(buying), ...observations.filter((o) => !buying(o))]
      : observations;
    for (const o of evaluation) {
      const t = this.memory.get(o.owner);
      if (!t) continue;
      if (o.subject === 'bird') {
        // Chance 1; admission retains the shared eligibility, cooldown and capacity gates.
        if (t.edges.has('scared')) this.admit(o, 'scared', observations);
        t.edges.clear();
        continue;
      }
      if (t.edges.size)
        for (const mood of priorities) {
          if (!t.edges.has(mood)) continue;
          if (
            !o.eligible ||
            o.speaking ||
            t.group ||
            this.clock < t.cooldownUntil ||
            this.size >= EMOJI.capacity ||
            t.rng() >= this.chance(o, mood)
          )
            continue;
          let selectedMood = mood,
            reply = t.replies.get(mood),
            replyMood: EmojiMood = mood === 'yummy' ? 'happy' : mood === 'happy' ? 'wave' : 'sorry';
          if (
            o.subject === 'driver' &&
            (mood === 'impatient' || mood === 'angry') &&
            (o.mover?.waiting ?? 0) >= EMOJI.driver.impatientWait
          ) {
            const m = o.mover!;
            let nearest = Infinity;
            reply = undefined;
            for (const p of observations) {
              if (!p.mover?.group || !p.eligible) continue;
              const dx = p.owner.x - m.x,
                dy = p.owner.y - m.y;
              if (dx * m.hx + dy * m.hy <= 0) continue;
              const distance = dx * dx + dy * dy;
              if (distance < nearest) {
                nearest = distance;
                reply = p.owner;
              }
            }
            replyMood = 'sorry';
            if (reply && t.rng() < EMOJI.honkShare) selectedMood = 'honk';
          }
          if (mood === 'yummy' && t.rng() < EMOJI.variantShare) {
            selectedMood = 'drooling';
            replyMood = 'profit';
          } else if (mood === 'happy' && t.groomingHappy && t.rng() < EMOJI.variantShare)
            selectedMood = 'beauty';
          else if (
            mood === 'angry' &&
            o.subject === 'cat' &&
            t.standoff &&
            t.rng() < EMOJI.variantShare
          )
            selectedMood = 'sideeye';
          this.admit(o, selectedMood, observations, reply, replyMood);
        }
      t.edges.clear();
      t.groomingHappy = false;
      t.replies.clear();
      if (!o.vendor)
        for (let i = 0; i < t.followups.length; i++) {
          const adjustment = this.chance(o, 'playful') / EMOJI.chance;
          if (t.rng() < EMOJI.followupChance * adjustment)
            this.admit(
              o,
              o.figure === 'adult' && t.rng() < EMOJI.gossipShare
                ? 'gossip'
                : t.rng() < EMOJI.playfulShare
                  ? 'playful'
                  : 'thumbs',
              observations,
            );
        }
      t.followups.length = 0;
      if (!o.eligible || t.attemptAt === undefined || this.clock + 1e-8 < t.attemptAt) continue;
      t.attemptAt = this.clock + EMOJI.ambientWindow;
      const pool = ambientPool(o, env, this.entries, t.cruise, this.graveVisitors);
      const applicable = seasonalPool(o, env, this.entries).length > 0;
      if (t.rng() >= (applicable ? EMOJI.seasonalChance : EMOJI.ambientChance) || !pool.length)
        continue;
      let pick = t.rng() * pool.reduce((sum, p) => sum + p.weight, 0);
      const mood = pool.find((p) => (pick -= p.weight) < 0)?.mood ?? pool.at(-1)!.mood;
      if (!o.vendor) this.admit(o, mood, observations);
    }
  }
}
