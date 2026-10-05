import { VEHICLES, type CraftType } from './vehicles';
import { frameBetween } from './frames';
import { lngLatToTile, tileToLngLat } from '@atlas/shared';
import type { TileId } from '../tiles';
import { type PUFF_COLOR, PUFF_GLYPHS } from './puff-style';
import { hasTurnSignals, type SIGNAL_VEHICLES } from './turn-signals';

export const PUFF = {
  cap: 96,
  visible: 160,
  life: [1.2, 2.5],
  pullAway: { minStop: 1, count: [2, 4], window: 1.5, v: 0.5 },
  idle: [3, 6],
  drift: 0.6,
  spread: 0.4,
  tailpipeOffset: 0.3,
} as const;
/** Reply-owned packet: final actor index, position, age and kind. */
export const PUFF_STRIDE = 5;
export const EMPTY_PUFFS = new Float64Array(0);
export type PuffKind = keyof typeof PUFF_COLOR;
export type Puff = {
  sourceId: number;
  x: number;
  y: number;
  t0: number;
  life: number;
  kind: PuffKind;
  vehicle: CraftType;
  vx: number;
  vy: number;
};
export type ExhaustEmitter = {
  seed: number;
  clock: number;
  stoppedSince: number | undefined;
  nextIdle: number;
  idle: number;
  burstAt: number;
  burstCount: number;
  burstNext: number;
  burst: number;
  emitted: number;
};
export type Wind = { dir: readonly [number, number]; strength: number } | undefined;
const EXHAUST_KIND: Record<(typeof SIGNAL_VEHICLES)[number], PuffKind | undefined> = {
  car: undefined,
  jeepney: 'diesel',
  bus: 'diesel',
  truck: 'diesel',
  motorcycle: 'twoStroke',
  tricycle: 'twoStroke',
};
export const exhaustKind = (vehicle: CraftType | undefined): PuffKind | undefined =>
  hasTurnSignals(vehicle) ? EXHAUST_KIND[vehicle] : undefined;

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
    stoppedSince: undefined,
    nextIdle: Infinity,
    idle: 0,
    burstAt: 0,
    burstCount: 0,
    burstNext: 0,
    burst: 0,
    emitted: 0,
  };
}

const burstDeadline = (s: ExhaustEmitter) =>
  s.burstAt + (s.burstNext * PUFF.pullAway.window) / (s.burstCount - 1);
export const burstDue = (s: ExhaustEmitter, clock: number) =>
  s.burstNext < s.burstCount && burstDeadline(s) <= clock + 1e-9;
function rebaseEmitter(s: ExhaustEmitter, clock: number, dt: number) {
  const gap = Math.max(0, clock - dt - s.clock);
  shiftEmitter(s, gap);
  s.clock = clock;
}
/** Shift only genuinely inactive time, never an eligible lazy interval. */
export function shiftEmitter(s: ExhaustEmitter, gap: number) {
  if (gap > 1e-8) {
    s.nextIdle += gap;
    s.burstAt += gap;
    if (s.stoppedSince !== undefined) s.stoppedSince += gap;
    s.clock += gap;
  }
}
export const stoppedFor = (s: ExhaustEmitter, clock: number) =>
  s.stoppedSince === undefined ? 0 : Math.max(0, clock - s.stoppedSince);
export const emitterWake = (s: ExhaustEmitter) =>
  Math.min(s.nextIdle, s.burstNext < s.burstCount ? burstDeadline(s) : Infinity);
const windComponent = (wind: Wind, axis: 0 | 1) =>
  (wind?.dir[axis] ?? 0) * (wind?.strength ?? 0) * PUFF.drift;
function drift(
  p: Pick<Puff, 'x' | 'y' | 'vx' | 'vy'>,
  seconds: number,
  wx: number,
  wy: number,
  perMeter: number,
) {
  p.x += (wx + p.vx) * seconds * perMeter;
  p.y += (wy + p.vy) * seconds * perMeter;
}
/** Birth at the interpolated accepted tailpipe, then advect the remainder of this step. */
export function spawnPuff(
  sourceId: number,
  vehicle: CraftType,
  kind: PuffKind,
  start: { x: number; y: number; hx: number; hy: number },
  end: { x: number; y: number; hx: number; hy: number },
  at: number,
  life: number,
  spread: number,
  clock: number,
  dt: number,
  perMeter: number,
  wind: Wind,
): Puff {
  const fraction = Math.max(0, Math.min(1, (at - (clock - dt)) / dt));
  const hx = start.hx + (end.hx - start.hx) * fraction;
  const hy = start.hy + (end.hy - start.hy) * fraction;
  const length = Math.hypot(hx, hy) || 1;
  const dx = hx / length,
    dy = hy / length,
    spec = VEHICLES[vehicle];
  const p: Puff = {
    sourceId,
    vehicle,
    kind,
    t0: at,
    life,
    vx: -dy * spread,
    vy: dx * spread,
    x:
      start.x +
      (end.x - start.x) * fraction -
      ((dx * spec.length) / 2) * perMeter -
      dy * PUFF.tailpipeOffset * spec.width * perMeter,
    y:
      start.y +
      (end.y - start.y) * fraction -
      ((dy * spec.length) / 2) * perMeter +
      dx * PUFF.tailpipeOffset * spec.width * perMeter,
  };
  drift(p, Math.max(0, clock - at), windComponent(wind, 0), windComponent(wind, 1), perMeter);
  return p;
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
  rebaseEmitter(state, clock, dt);
  const low = before < PUFF.pullAway.v;
  const stopped = after < PUFF.pullAway.v;
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
    if (!low || state.stoppedSince === undefined) state.stoppedSince = low ? start : crossing;
    if (!low || state.nextIdle === Infinity) {
      state.nextIdle = (low ? start : crossing) + interval();
      state.burstCount = 0;
    }
    while (state.nextIdle <= clock + 1e-9) {
      puff(state.nextIdle);
      state.idle++;
      state.nextIdle += interval();
    }
  } else {
    if (low && stoppedFor(state, crossing) >= PUFF.pullAway.minStop - 1e-9) {
      state.burstAt = crossing;
      state.burstCount =
        PUFF.pullAway.count[0] +
        Math.floor(
          sample(state.seed, state.burst++, 61) *
            (PUFF.pullAway.count[1] - PUFF.pullAway.count[0] + 1),
        );
      state.burstNext = 0;
    }
    state.stoppedSince = undefined;
    state.nextIdle = Infinity;
    while (state.burstNext < state.burstCount) {
      const i = state.burstNext;
      const at = burstDeadline(state);
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
    const wx = windComponent(wind, 0),
      wy = windComponent(wind, 1);
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
        drift(p, elapsed, wx, wy, perMeter);
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

type PuffSelectionTile = {
  tile: TileId;
  perMeter: number;
  puffs: PuffStore;
};
type Candidate = { p: Puff; tile: TileId; d: number };

/** Bounded selection in tile units; only winners are projected into reply-owned storage. */
export class PuffSelector {
  private readonly heap: Candidate[] = [];
  private readonly pool: Candidate[] = [];
  clear() {
    this.heap.length = this.pool.length = 0;
  }
  select(
    tiles: Iterable<PuffSelectionTile>,
    sources: ReadonlyMap<number, number>,
    center: readonly [number, number],
    clock: number,
    inside: (tile: TileId) => (x: number, y: number) => boolean,
  ) {
    const heap = this.heap;
    heap.length = 0;
    if (!sources.size) return EMPTY_PUFFS;
    let reference: TileId | undefined;
    let origin = { x: 0, y: 0 };
    for (const life of tiles) {
      if (!reference) {
        reference = life.tile;
        origin = lngLatToTile(reference, ...center);
      }
      const frame = frameBetween(life.tile, reference);
      const contains = inside(life.tile);
      for (const p of life.puffs.active(clock)) {
        if (!sources.has(p.sourceId) || !contains(p.x, p.y)) continue;
        const d =
          (frame.x + p.x * frame.scale - origin.x) ** 2 +
          (frame.y + p.y * frame.scale - origin.y) ** 2;
        if (heap.length < PUFF.visible) {
          const entry = (this.pool[heap.length] ??= { p, tile: { ...life.tile }, d });
          entry.p = p;
          Object.assign(entry.tile, life.tile);
          entry.d = d;
          let i = heap.length;
          heap.push(entry);
          while (i > 0) {
            const parent = (i - 1) >> 1;
            if (heap[parent]!.d >= d) break;
            heap[i] = heap[parent]!;
            heap[parent] = entry;
            i = parent;
          }
        } else if (d < heap[0]!.d) {
          const entry = heap[0]!;
          entry.p = p;
          Object.assign(entry.tile, life.tile);
          entry.d = d;
          for (let i = 0; ;) {
            let child = i * 2 + 1;
            if (child >= heap.length) break;
            if (child + 1 < heap.length && heap[child + 1]!.d > heap[child]!.d) child++;
            if (heap[i]!.d >= heap[child]!.d) break;
            [heap[i], heap[child]] = [heap[child]!, heap[i]!];
            i = child;
          }
        }
      }
    }
    heap.sort((a, b) => a.d - b.d);
    if (!heap.length) return EMPTY_PUFFS;
    const packet = new Float64Array(heap.length * PUFF_STRIDE);
    for (let i = 0; i < heap.length; i++) {
      const { p, tile } = heap[i]!;
      const [lng, lat] = tileToLngLat(tile, p);
      const at = i * PUFF_STRIDE;
      packet[at] = sources.get(p.sourceId)!;
      packet[at + 1] = lng;
      packet[at + 2] = lat;
      packet[at + 3] = Math.max(0, Math.min(1, (clock - p.t0) / p.life));
      packet[at + 4] = p.kind === 'twoStroke' ? 1 : 0;
    }
    return packet;
  }
}

export const puffGlyph = (age: number) =>
  PUFF_GLYPHS[Math.min(2, Math.floor(Math.max(0, age) * 3))]!;
