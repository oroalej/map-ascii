import type { CraftType } from './vehicles';

export const PUFF = {
  cap: 96,
  visible: 160,
  life: [1.2, 2.5],
  pullAway: { minStop: 1, count: [2, 4], window: 1.5, v: 0.5 },
  idle: [3, 6],
  drift: 0.6,
  spread: 0.4,
} as const;
export const PUFF_COLOR = { diesel: [0.45, 0.45, 0.45], twoStroke: [0.55, 0.6, 0.64] } as const;
export const PUFF_GLYPHS = ['°', '∘', '·'] as const;
export type PuffKind = keyof typeof PUFF_COLOR;
export type Puff = {
  x: number;
  y: number;
  t0: number;
  life: number;
  kind: PuffKind;
  vehicle: CraftType;
  vx: number;
  vy: number;
  hx: number;
  hy: number;
};
export type ExhaustEmitter = {
  seed: number;
  clock: number;
  stopped: number;
  nextIdle: number;
  idle: number;
  burstAt: number;
  burstCount: number;
  burstNext: number;
  burst: number;
  emitted: number;
};
export type Wind = { dir: readonly [number, number]; strength: number } | undefined;
export const exhaustKind = (vehicle: CraftType | undefined): PuffKind | undefined =>
  vehicle === 'jeepney' || vehicle === 'bus' || vehicle === 'truck'
    ? 'diesel'
    : vehicle === 'motorcycle' || vehicle === 'tricycle'
      ? 'twoStroke'
      : undefined;

/** Independent integer hash: never advances any of the simulation's random streams. */
function sample(seed: number, ordinal: number, tag: number) {
  let x = (seed ^ Math.imul(ordinal + 1, 0x9e3779b9) ^ tag) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad);
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97);
  return ((x ^ (x >>> 15)) >>> 0) / 0x1_0000_0000;
}
export function emitter(seed: number, clock: number): ExhaustEmitter {
  return {
    seed,
    clock,
    stopped: 0,
    nextIdle: Infinity,
    idle: 0,
    burstAt: 0,
    burstCount: 0,
    burstNext: 0,
    burst: 0,
    emitted: 0,
  };
}

/** Consume exact deadlines, including deadlines between updates. Speeds are m/s. */
export function stepEmitter(
  state: ExhaustEmitter,
  kind: PuffKind,
  before: number,
  after: number,
  clock: number,
  dt: number,
  emit: (at: number, life: number, spread: number) => void,
) {
  const start = clock - dt;
  const gap = Math.max(0, start - state.clock);
  if (gap > 1e-8) {
    state.nextIdle += gap;
    state.burstAt += gap;
  }
  state.clock = clock;
  const low = before < PUFF.pullAway.v;
  const stopped = after < PUFF.pullAway.v;
  // Most emitters idle for many updates between deadlines. Avoid closures and hashing there.
  if (low && stopped && state.nextIdle !== Infinity && state.nextIdle > clock + 1e-9) {
    state.stopped += dt;
    return;
  }
  const fraction =
    low === stopped ? 0 : Math.max(0, Math.min(1, (PUFF.pullAway.v - before) / (after - before)));
  const crossing = start + fraction * dt;
  const interval = () =>
    (PUFF.idle[0] + sample(state.seed, state.idle, 17) * (PUFF.idle[1] - PUFF.idle[0])) *
    (kind === 'twoStroke' ? 2 : 1);
  const puff = (at: number) => {
    const ordinal = state.emitted++;
    emit(
      at,
      PUFF.life[0] + sample(state.seed, ordinal, 31) * (PUFF.life[1] - PUFF.life[0]),
      (sample(state.seed, ordinal, 47) * 2 - 1) * PUFF.spread,
    );
  };
  if (stopped) {
    if (!low || state.nextIdle === Infinity) {
      state.nextIdle = (low ? start : crossing) + interval();
      state.burstCount = 0;
    }
    state.stopped += low ? dt : clock - crossing;
    while (state.nextIdle <= clock + 1e-9) {
      puff(state.nextIdle);
      state.idle++;
      state.nextIdle += interval();
    }
  } else {
    if (low && state.stopped + fraction * dt >= PUFF.pullAway.minStop - 1e-9) {
      state.burstAt = crossing;
      state.burstCount =
        PUFF.pullAway.count[0] + Math.floor(sample(state.seed, state.burst++, 61) * 3);
      state.burstNext = 0;
    }
    state.stopped = 0;
    state.nextIdle = Infinity;
    while (state.burstNext < state.burstCount) {
      const i = state.burstNext;
      const at = state.burstAt + (i * PUFF.pullAway.window) / (state.burstCount - 1);
      if (at > clock + 1e-9) break;
      state.burstNext++;
      if (kind === 'diesel' || i % 2 === 0) puff(at);
    }
  }
}

/** Bounded insertion-order ring; particles have no collision or agent ownership. */
export class PuffStore {
  private readonly slots: (Puff | undefined)[] = Array.from({ length: PUFF.cap });
  private cursor = 0;
  private count = 0;
  private clock?: number;
  add(puff: Puff) {
    if (!this.slots[this.cursor]) this.count++;
    this.slots[this.cursor] = puff;
    this.cursor = (this.cursor + 1) % PUFF.cap;
  }
  advance(clock: number, dt: number, wind: Wind, perMeter: number) {
    const gap = Math.max(0, clock - dt - (this.clock ?? clock - dt));
    this.clock = clock;
    if (!this.count) return;
    const wx = (wind?.dir[0] ?? 0) * (wind?.strength ?? 0) * PUFF.drift;
    const wy = (wind?.dir[1] ?? 0) * (wind?.strength ?? 0) * PUFF.drift;
    for (let i = 0; i < this.slots.length; i++) {
      const p = this.slots[i];
      if (!p) continue;
      // A retired tile freezes its plume with its population; don't age it offscreen.
      if (gap > 1e-8) p.t0 += gap;
      if (clock >= p.t0 + p.life - 1e-9) {
        this.slots[i] = undefined;
        this.count--;
      } else {
        const elapsed = Math.max(0, clock - Math.max(clock - dt, p.t0));
        p.x += (wx + p.vx) * elapsed * perMeter;
        p.y += (wy + p.vy) * elapsed * perMeter;
      }
    }
  }
  *active(clock: number) {
    if (!this.count) return;
    for (const p of this.slots) if (p && clock < p.t0 + p.life - 1e-9) yield p;
  }
  snapshot(clock: number) {
    return [...this.active(clock)].map((p) => ({ ...p }));
  }
}

export const puffGlyph = (age: number) =>
  PUFF_GLYPHS[Math.min(2, Math.floor(Math.max(0, age) * 3))]!;
