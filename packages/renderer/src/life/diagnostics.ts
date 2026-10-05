import type { VisibleAgent, Mover } from './simulate';

/** Optional profiling data. Identities are weak and never participate in simulation decisions. */
export const CONTINUITY_EVENTS = [
  'attempts',
  'transfers',
  'births',
  'revivals',
  'expiredBirths',
] as const;
export const CONTINUITY_REJECTIONS = [
  'geometry',
  'directionCraft',
  'pose',
  'terrain',
  'occupancy',
  'capQuota',
  'localScene',
  'ownership',
] as const;
export type ContinuityRejection = (typeof CONTINUITY_REJECTIONS)[number];
export type ContinuityCounter = (typeof CONTINUITY_EVENTS)[number] | ContinuityRejection;
export type TravelerTrace = {
  id: string;
  at: number;
  tile: string;
  event: string;
  lng: number;
  lat: number;
};
export type ContinuitySample = {
  counts: Partial<Record<ContinuityCounter, number>>;
  trace: TravelerTrace[];
};

export const PackingOutcome = { outside: 0, drawn: 1, collision: 2, cellGuard: 3 } as const;
export type MotionKind = 'vehicle' | 'person';
export type LifeHold =
  'inspection' | 'pause' | 'moment' | 'signal' | 'service' | 'visit' | 'terminal';
export type LifeRejection = 'occupancy' | 'building' | 'water' | 'road';
export type MotionReport = {
  eligibleFrames: number;
  stuckFrames: number;
  ratio: number | null;
  episodes: number;
  p99Seconds: number;
  maxSeconds: number;
};
type MotionFrame = {
  kind: MotionKind;
  hold?: LifeHold;
  lng?: number;
  lat?: number;
  tile?: string;
  tags: Set<string>;
  rejection?: { reason: LifeRejection; blocker?: number; kind?: string; vehicle?: string };
  firstRejection?: MotionFrame['rejection'];
};
type MotionHistory = {
  kind: MotionKind;
  samples: ({ at: number; lng: number; lat: number } | undefined)[];
  head: number;
  count: number;
  episode?: number;
  tags: Set<string>;
};
type MotionStats = MotionReport & { durations: number[] };
const motionStats = (): MotionStats => ({
  eligibleFrames: 0,
  stuckFrames: 0,
  ratio: null,
  episodes: 0,
  p99Seconds: 0,
  maxSeconds: 0,
  durations: [],
});
/** Metre displacement remains valid when an owner changes tile coordinate frames. */
export function displacement(a: { lng: number; lat: number }, b: { lng: number; lat: number }) {
  const radians = Math.PI / 180;
  const dlat = (b.lat - a.lat) * radians,
    dlng = (b.lng - a.lng) * radians;
  const h =
    Math.sin(dlat / 2) ** 2 +
    Math.cos(a.lat * radians) * Math.cos(b.lat * radians) * Math.sin(dlng / 2) ** 2;
  return 12_756_274 * Math.asin(Math.sqrt(Math.min(1, h)));
}

/** Script-only sink: bounded frame/history maps and weak identities never affect simulation. */
export class LifeDiagnostics {
  private readonly raw?: LifeDiagnostics;
  private terminalSeen = new WeakSet<object>();
  private terminalEpisodes = new Map<object, number>();
  private terminalPopulation = 0;
  private terminalFrames = 0;
  private terminalMaxSeconds = 0;
  constructor(options?: { rawMotion?: boolean }) {
    if (options?.rawMotion) this.raw = new LifeDiagnostics();
  }
  readonly views = new Map<VisibleAgent, object>();
  private identities = new WeakMap<object, number>();
  private nextId = 1;
  private motion = new Map<object, MotionFrame>();
  private pendingTags = new Map<object, Set<string>>();
  private histories = new Map<number, MotionHistory>();
  private stats = { vehicle: motionStats(), person: motionStats() };
  private previousDrawn = new Set<number>();
  private candidates = new Map<object, VisibleAgent>();
  private capped = new Set<object>();
  private recoveries: { owner: object; cause: string }[] = [];
  private followers = new Map<object, object>();
  private episodeTags = new Map<string, number>();
  private rejectionCounts = new Map<string, number>();
  private blockers = new Map<string, number>();
  private holdCounts = new Map<string, number>();
  private packing = {
    drawnFrames: 0,
    collisionFrames: 0,
    cellGuardFrames: 0,
    collisionDenials: 0,
    cellGuardDenials: 0,
    capFrames: 0,
    collisionDisappearances: 0,
    cellGuardDisappearances: 0,
    capDisappearances: 0,
  };
  private recoveryCounts = new Map<string, number>();
  private vehicleRecoveries = 0;
  private recoveryEvents: {
    id: number;
    at: number;
    cause: string;
    tile?: string;
    vehicle?: string;
    line?: number;
    dir?: number;
    lng: number;
    lat: number;
  }[] = [];
  private at = 0;
  private measuredSeconds = 0;
  private measured = false;
  private bounds: readonly number[] = [];
  zoom = 18;
  crowd = 1;
  beginFrame(
    dt: number,
    bounds: readonly number[],
    zoom: number,
    crowd: number,
    measured: boolean,
  ) {
    this.raw?.beginFrame(dt, bounds, zoom, crowd, measured);
    if (measured && !this.measured) {
      this.histories.clear();
      this.terminalSeen = new WeakSet();
      this.terminalEpisodes.clear();
    }
    this.at += dt;
    this.measured = measured;
    if (measured) this.measuredSeconds += dt;
    this.bounds = bounds;
    this.zoom = zoom;
    this.crowd = crowd;
    this.motion.clear();
    this.pendingTags.clear();
    this.recoveries.length = 0;
    this.followers.clear();
  }
  beginVisible() {
    this.raw?.beginVisible();
    this.views.clear();
    this.candidates.clear();
    this.capped.clear();
  }
  eligible(owner: object, kind: string) {
    this.raw?.eligible(owner, kind);
    if ((kind === 'vehicle' || kind === 'person') && !this.motion.has(owner))
      this.motion.set(owner, { kind, tags: this.pendingTags.get(owner) ?? new Set() });
  }
  following(owner: object, leader: object) {
    this.raw?.following(owner, leader);
    this.followers.set(owner, leader);
  }
  hold(owner: object, cause: LifeHold) {
    this.raw?.hold(owner, cause);
    const frame = this.motion.get(owner);
    if (frame) frame.hold = cause;
  }
  position(owner: object, lng: number, lat: number, tile?: string) {
    this.raw?.position(owner, lng, lat, tile);
    const frame = this.motion.get(owner);
    if (frame) {
      frame.lng = lng;
      frame.lat = lat;
      frame.tile = tile;
    }
    return !!frame && this.inView(lng, lat);
  }
  tracks(owner: object) {
    return this.motion.has(owner);
  }
  tag(owner: object, tag: string) {
    const tags = this.motion.get(owner)?.tags ?? this.pendingTags.get(owner) ?? new Set<string>();
    tags.add(tag);
    if (!this.motion.has(owner)) this.pendingTags.set(owner, tags);
  }
  reject(owner: object, reason: LifeRejection, blocker?: object, tags: readonly string[] = []) {
    this.raw?.reject(owner, reason, blocker, tags);
    const frame = this.motion.get(owner);
    if (frame) {
      const body = blocker as { kind?: string; vehicle?: string } | undefined;
      frame.rejection = {
        reason,
        blocker: blocker && this.id(blocker),
        kind: body?.kind,
        vehicle: body?.vehicle,
      };
      frame.firstRejection ??= frame.rejection;
    }
    if (this.measured) {
      this.increment(this.rejectionCounts, reason);
      if (blocker) {
        const body = blocker as { kind?: string; vehicle?: string; place?: string };
        this.increment(this.blockers, body.kind ?? (body.vehicle ? 'parked/vendor' : 'gatherer'));
      }
    }
    for (const tag of tags) this.tag(owner, tag);
  }
  view(owner: object, agent: VisibleAgent) {
    this.raw?.view(owner, agent);
    this.views.set(agent, owner);
    if (this.inView(agent.lng, agent.lat)) this.candidates.set(owner, agent);
  }
  admitted(agents: readonly VisibleAgent[]) {
    this.raw?.admitted(agents);
    const kept = new Set(agents.map((agent) => this.views.get(agent)));
    for (const owner of this.candidates.keys()) if (!kept.has(owner)) this.capped.add(owner);
  }
  recovery(owner: object, cause: string) {
    this.raw?.recovery(owner, cause);
    this.recoveries.push({ owner, cause });
  }
  private id(owner: object) {
    let id = this.identities.get(owner);
    if (id === undefined) {
      id = this.nextId++;
      this.identities.set(owner, id);
    }
    return id;
  }
  private inView(lng: number, lat: number) {
    return (
      lng >= this.bounds[0]! &&
      lng <= this.bounds[2]! &&
      lat >= this.bounds[1]! &&
      lat <= this.bounds[3]!
    );
  }
  private increment(map: Map<string, number>, key: string) {
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  private endEpisode(history: MotionHistory, stats: MotionStats) {
    if (history.episode === undefined) return;
    const duration = this.at - history.episode;
    if (this.measured) {
      stats.maxSeconds = Math.max(stats.maxSeconds, duration);
      if (stats.durations.length === 4096) stats.durations.shift();
      stats.durations.push(duration);
    }
    history.episode = undefined;
    history.tags.clear();
  }
  finishFrame(agents: readonly VisibleAgent[], outcomes: Uint8Array, denials?: Uint8Array) {
    this.raw?.finishFrame(agents, outcomes, denials);
    if (outcomes.length !== agents.length)
      throw new RangeError('Packing outcomes must match agents');
    if (denials && denials.length !== agents.length)
      throw new RangeError('Packing denials must match agents');
    // A stopped queue shares the intentional signal/service/inspection hold of its leader.
    for (const [owner, frame] of this.motion) {
      const visited = new Set<object>([owner]);
      let leader = this.followers.get(owner);
      while (leader && !visited.has(leader)) {
        visited.add(leader);
        const hold = this.motion.get(leader)?.hold;
        const stopped = (owner as Partial<Mover>).v;
        if (
          hold === 'signal' ||
          hold === 'service' ||
          hold === 'inspection' ||
          (hold === 'terminal' && stopped !== undefined && Math.abs(stopped) < 1e-8)
        ) {
          frame.hold = hold;
          break;
        }
        leader = this.followers.get(leader);
      }
    }
    const seen = new Set<number>();
    const terminalSeen = new Set<object>();
    for (const [owner, frame] of this.motion) {
      const id = this.id(owner);
      const history = this.histories.get(id);
      const stats = this.stats[frame.kind];
      if (
        frame.hold === 'terminal' &&
        this.candidates.has(owner) &&
        frame.lng !== undefined &&
        frame.lat !== undefined &&
        this.inView(frame.lng, frame.lat)
      ) {
        terminalSeen.add(owner);
        const start = this.terminalEpisodes.get(owner) ?? this.at;
        this.terminalEpisodes.set(owner, start);
        if (this.measured) {
          this.terminalFrames++;
          this.terminalMaxSeconds = Math.max(this.terminalMaxSeconds, this.at - start);
          if (!this.terminalSeen.has(owner)) {
            this.terminalSeen.add(owner);
            this.terminalPopulation++;
          }
        }
      }
      if (
        frame.hold ||
        !this.candidates.has(owner) ||
        frame.lng === undefined ||
        frame.lat === undefined ||
        !this.inView(frame.lng, frame.lat)
      ) {
        if (history) this.endEpisode(history, stats);
        if (frame.hold && this.measured) this.increment(this.holdCounts, frame.hold);
        continue;
      }
      seen.add(id);
      const h: MotionHistory = history ?? {
        kind: frame.kind,
        samples: new Array(512),
        head: 0,
        count: 0,
        tags: new Set<string>(),
      };
      this.histories.set(id, h);
      const point = { at: this.at, lng: frame.lng, lat: frame.lat };
      while (h.count > 1 && h.samples[(h.head + 1) % 512]!.at <= this.at - 10 + 1e-8) {
        h.head = (h.head + 1) % 512;
        h.count--;
      }
      // 30 Hz diagnostic input retains at most 302 samples per active owner.
      if (h.count === 512) {
        h.head = (h.head + 1) % 512;
        h.count--;
      }
      h.samples[(h.head + h.count) % 512] = point;
      h.count++;
      if (this.measured) stats.eligibleFrames++;
      const first = h.samples[h.head]!;
      if (this.at - first.at >= 10 - 1e-8 && displacement(first, point) < 0.5) {
        if (h.episode === undefined) {
          h.episode = first.at;
          if (this.measured) stats.episodes++;
        }
        if (this.measured) {
          stats.stuckFrames++;
          stats.maxSeconds = Math.max(stats.maxSeconds, this.at - h.episode);
          for (const tag of frame.tags)
            if (!h.tags.has(tag)) {
              h.tags.add(tag);
              this.increment(this.episodeTags, tag);
            }
        }
      } else this.endEpisode(h, stats);
    }
    for (const [id, history] of this.histories)
      if (!seen.has(id)) {
        // Ineligible histories do not survive camera exits, intentional holds or retirement.
        this.endEpisode(history, this.stats[history.kind]);
        this.histories.delete(id);
      }
    for (const owner of this.terminalEpisodes.keys())
      if (!terminalSeen.has(owner)) this.terminalEpisodes.delete(owner);
    const states = new Map<object, number>();
    const denied = new Map<object, number>();
    for (let i = 0; i < agents.length; i++) {
      const owner = this.views.get(agents[i]!);
      if (!owner || !this.candidates.has(owner)) continue;
      if (denials) denied.set(owner, (denied.get(owner) ?? 0) | denials[i]!);
      const outcome = outcomes[i]!;
      const previous = states.get(owner);
      const rank = (value: number) =>
        value === PackingOutcome.drawn
          ? 3
          : value === PackingOutcome.collision
            ? 2
            : value === PackingOutcome.cellGuard
              ? 1
              : 0;
      if (previous === undefined || rank(outcome) > rank(previous)) states.set(owner, outcome);
    }
    const drawn = new Set<number>();
    for (const owner of this.candidates.keys()) {
      const id = this.id(owner),
        state = states.get(owner) ?? PackingOutcome.outside;
      if (this.measured) {
        if ((denied.get(owner) ?? 0) & 1) this.packing.collisionDenials++;
        if ((denied.get(owner) ?? 0) & 2) this.packing.cellGuardDenials++;
      }
      if (state === PackingOutcome.drawn) {
        drawn.add(id);
        if (this.measured) this.packing.drawnFrames++;
      } else if (this.measured) {
        const cap = this.capped.has(owner);
        if (cap) this.packing.capFrames++;
        else if (state === PackingOutcome.collision) this.packing.collisionFrames++;
        else if (state === PackingOutcome.cellGuard) this.packing.cellGuardFrames++;
        if (this.previousDrawn.has(id)) {
          if (cap) this.packing.capDisappearances++;
          else if (state === PackingOutcome.collision) this.packing.collisionDisappearances++;
          else if (state === PackingOutcome.cellGuard) this.packing.cellGuardDisappearances++;
        }
      }
    }
    this.previousDrawn = drawn;
    if (this.measured)
      for (const { owner, cause } of this.recoveries) {
        const frame = this.motion.get(owner);
        if (
          frame?.lng !== undefined &&
          frame.lat !== undefined &&
          this.inView(frame.lng, frame.lat)
        ) {
          this.increment(this.recoveryCounts, cause);
          if (frame.kind === 'vehicle') {
            this.vehicleRecoveries++;
            const m = owner as Partial<Mover>;
            if (this.recoveryEvents.length === 200) this.recoveryEvents.shift();
            this.recoveryEvents.push({
              id: this.id(owner),
              at: this.at,
              cause,
              tile: frame.tile,
              vehicle: m.vehicle,
              line: m.line,
              dir: m.dir,
              lng: frame.lng,
              lat: frame.lat,
            });
          }
        }
      }
  }
  private motionReport() {
    const summarize = (kind: MotionKind): MotionReport => {
      const s = this.stats[kind];
      const durations = [
        ...s.durations,
        ...[...this.histories.values()]
          .filter((h) => h.kind === kind && h.episode !== undefined)
          .map((h) => this.at - h.episode!),
      ].sort((a, b) => a - b);
      return {
        eligibleFrames: s.eligibleFrames,
        stuckFrames: s.stuckFrames,
        ratio: s.eligibleFrames ? s.stuckFrames / s.eligibleFrames : null,
        episodes: s.episodes,
        p99Seconds:
          durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.99))] ??
          s.maxSeconds,
        maxSeconds: s.maxSeconds,
      };
    };
    return { vehicle: summarize('vehicle'), person: summarize('person') };
  }
  report() {
    const rate = (count: number) =>
      this.packing.drawnFrames ? (count * 1000) / this.packing.drawnFrames : null;
    const episodes = this.stats.vehicle.episodes + this.stats.person.episodes;
    const hiddenByCrowd = this.episodeTags.get('hiddenByCrowd') ?? 0;
    return {
      seconds: this.measuredSeconds,
      motion: this.motionReport(),
      rawMotion: this.raw?.motionReport(),
      terminalHolds: {
        population: this.terminalPopulation,
        frames: this.terminalFrames,
        maxSeconds: this.terminalMaxSeconds,
      },
      packing: {
        ...this.packing,
        disappearancesPer1000: rate(
          this.packing.collisionDisappearances + this.packing.cellGuardDisappearances,
        ),
        rejectedPer1000: rate(this.packing.collisionFrames + this.packing.cellGuardFrames),
      },
      rejections: Object.fromEntries(this.rejectionCounts),
      blockers: Object.fromEntries(this.blockers),
      holds: Object.fromEntries(this.holdCounts),
      episodeTags: Object.fromEntries(this.episodeTags),
      hiddenByCrowd: {
        episodes: hiddenByCrowd,
        totalEpisodes: episodes,
        ratio: episodes ? hiddenByCrowd / episodes : null,
      },
      recoveries: {
        counts: Object.fromEntries(this.recoveryCounts),
        perMinute: this.measuredSeconds ? (this.vehicleRecoveries * 60) / this.measuredSeconds : 0,
      },
      histories: this.histories.size,
    };
  }

  /** Bounded, detached examples for manual diagnosis, never read by simulation. */
  recentRecoveries() {
    return this.recoveryEvents.map((event) => ({ ...event }));
  }

  /** Script-only classification; never alters the raw motion observer or simulation. */
  classifyTerminal(owner: object) {
    const frame = this.motion.get(owner);
    if (frame && !frame.hold) frame.hold = 'terminal';
  }

  /** Bounded, detached examples for manual diagnosis, never read by simulation. */
  longestStuck(limit = 12, describe?: (owner: object) => unknown) {
    const examples = [];
    for (const [owner, frame] of this.motion) {
      const id = this.identities.get(owner);
      const h = id === undefined ? undefined : this.histories.get(id);
      if (h?.episode === undefined) continue;
      const m = owner as Partial<Mover>;
      examples.push({
        id,
        seconds: this.at - h.episode,
        kind: frame.kind,
        lng: frame.lng,
        lat: frame.lat,
        tile: frame.tile,
        tags: [...h.tags],
        rejection: frame.rejection && { ...frame.rejection },
        firstRejection: frame.firstRejection && { ...frame.firstRejection },
        following: this.followers.get(owner) && this.id(this.followers.get(owner)!),
        mover: {
          line: m.line,
          from: m.from,
          dir: m.dir,
          d: m.d,
          x: m.x,
          y: m.y,
          hx: m.hx,
          hy: m.hy,
          vehicle: m.vehicle,
          speed: m.speed,
          v: m.v,
          waiting: m.waiting,
          avoid: m.avoid,
          pause: m.pause,
          group: m.group?.map((w) => ({ figure: w.figure, lateral: w.lateral, back: w.back })),
        },
      });
    }
    return examples
      .sort((a, b) => b.seconds - a.seconds)
      .slice(0, Math.max(0, Math.min(50, limit)))
      .map((example) => ({
        ...example,
        details:
          describe &&
          describe([...this.motion.keys()].find((o) => this.identities.get(o) === example.id)!),
      }));
  }
}
