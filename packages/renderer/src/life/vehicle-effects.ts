import {
  emitter,
  emitterWake,
  stoppedFor,
  shiftEmitter,
  burstDue,
  spawnPuff,
  stepEmitter,
  exhaustKind,
  PUFF,
  type ExhaustEmitter,
  type PuffKind,
  type Wind,
} from './exhaust';
import { BRAKE, brakeHold } from './lamps';
import { hasTurnSignals, SIGNAL_VEHICLES } from './turn-signals';
import { VEHICLES, STAMP_MIN_CELLS, type CraftType } from './vehicles';
import { kinematicsOf } from './config';
import { frameBetween } from './frames';
import { hashString } from './random';
import type { Mover, TileLife } from './simulate';

export type VehicleEffects = {
  brake: number;
  sourceId?: number;
  exhaust?: ExhaustEmitter;
  inactiveAt?: number;
};
// Movement snapshots copy movers frequently. Keep decorative state off their hot shapes.
// Identity-preserving transfers retain it; detached continuity previews copy it explicitly.
const states = new WeakMap<object, VehicleEffects>();
export const vehicleEffects = (mover: object) => states.get(mover);
export function ensureVehicleEffects(mover: object) {
  let state = states.get(mover);
  if (!state) states.set(mover, (state = { brake: 0, exhaust: undefined }));
  return state;
}
export function copyVehicleEffects(source: object, preview: object) {
  const state = states.get(source);
  if (state) states.set(preview, { ...state, exhaust: state.exhaust && { ...state.exhaust } });
}

/** Normalize lazy bookkeeping for diagnostics without consuming a deadline or mutating state. */
export function vehicleEffectSnapshot(mover: object, clock: number) {
  const state = states.get(mover);
  if (!state) return;
  const at = state.inactiveAt ?? clock;
  return {
    ...state,
    exhaust: state.exhaust && {
      ...state.exhaust,
      clock: at,
      stopped: stoppedFor(state.exhaust, at),
    },
  };
}

type Cached = {
  mover?: Mover;
  vehicle?: CraftType;
  state?: VehicleEffects;
  length: number;
  accel: number;
  kind?: PuffKind;
  wake: number;
  atHold: boolean;
  initialized: boolean;
};
type Captured = {
  mover?: Mover;
  state?: VehicleEffects;
  cached?: Cached;
  v: number;
  x: number;
  y: number;
  hx: number;
  hy: number;
};
const MAX_MOTOR_LENGTH = Math.max(...SIGNAL_VEHICLES.map((craft) => VEHICLES[craft].length));
const NO_PUFF = () => {};

/** Decorative state follows accepted movement; cached records never own movement decisions. */
export class VehicleEffectTracker {
  private readonly cache: Cached[] = [];
  private readonly captured: Captured[] = [];
  private count = 0;
  private serial = 0;
  private lastClock?: number;
  private clock = 0;
  private dt = 0;
  private minimum = 0;
  private nextSourceId?: () => number;
  private enabled = true;

  constructor(
    private readonly tile: TileLife,
    private readonly seed: () => number,
  ) {}

  begin(clock: number, dt: number, cellMeters: number, wind: Wind, nextSourceId?: () => number) {
    this.count = 0;
    this.clock = clock;
    this.dt = dt;
    this.minimum = STAMP_MIN_CELLS * cellMeters;
    this.nextSourceId = nextSourceId;
    const gap = Math.max(0, clock - dt - (this.lastClock ?? clock - dt));
    this.lastClock = clock;
    if (this.cache.length > this.tile.movers.length) this.cache.length = this.tile.movers.length;
    // Tile retirement has no per-mover callbacks. Shift active records once on return.
    if (gap > 1e-8)
      for (let i = 0; i < this.cache.length; i++) {
        const c = this.cache[i]!;
        if (!c || c.mover !== this.tile.movers[i] || !c.state || c.state.inactiveAt !== undefined)
          continue;
        if (c.state.exhaust) shiftEmitter(c.state.exhaust, gap);
        c.wake += gap;
      }
    this.tile.puffs.advance(clock, dt, wind, this.tile.perMeter);
    if (this.minimum > MAX_MOTOR_LENGTH) {
      if (this.enabled) this.pause(clock - dt);
      this.enabled = false;
      return false;
    }
    this.enabled = true;
    return true;
  }

  /** Eligibility transitions write once; already inactive records remain untouched. */
  pause(at: number) {
    for (let i = 0; i < this.tile.movers.length; i++) {
      const m = this.tile.movers[i]!,
        c = this.cache[i];
      if (c?.mover === m) this.deactivate(c, at);
      else {
        const state = vehicleEffects(m);
        if (state && state.inactiveAt === undefined) {
          state.inactiveAt = at;
          state.brake = 0;
        }
      }
    }
  }

  /** A transfer can enter a tile whose coarse-scale capture loop is entirely skipped. */
  adopt(m: Mover, clock?: number, state = vehicleEffects(m)) {
    if (!state || !m.vehicle || VEHICLES[m.vehicle].length >= this.minimum) return;
    state.inactiveAt = clock ?? state.exhaust?.clock ?? this.lastClock ?? this.tile.elapsed;
    state.brake = 0;
  }

  private deactivate(c: Cached, at: number) {
    if (c.state && c.state.inactiveAt === undefined) {
      c.state.inactiveAt = at;
      c.state.brake = 0;
      c.atHold = false;
    }
  }

  capture(
    m: Mover,
    index: number,
    eligible: boolean,
    target: number,
    cap: number,
    services: boolean,
  ) {
    const c = this.cache[index];
    if (c?.mover === m && c.vehicle === m.vehicle) {
      if (!eligible || !c.length || c.length < this.minimum) {
        if (c.state) this.deactivate(c, this.clock - this.dt);
        return;
      }
      if (
        c.atHold &&
        c.state?.inactiveAt === undefined &&
        !services &&
        this.clock + 1e-9 < c.wake
      ) {
        const speed = m.v ?? m.speed;
        if (
          speed < BRAKE.stopped * this.tile.perMeter &&
          (target <= speed + 1e-9 || cap <= speed + 1e-9)
        )
          return;
      }
    }
    this.record(m, index, eligible, target, cap);
  }

  private record(m: Mover, index: number, eligible: boolean, target: number, cap: number) {
    let c = this.cache[index];
    if (m.kind !== 'vehicle') {
      if (c) {
        c.mover = undefined;
        c.state = undefined;
      }
      return;
    }
    if (!c)
      this.cache[index] = c = {
        length: 0,
        accel: 0,
        wake: Infinity,
        atHold: false,
        initialized: false,
      };
    if (c.mover !== m || c.vehicle !== m.vehicle) {
      // Reuse the allocation through splice/reordering. Only resolve a new canonical identity.
      if (c.vehicle !== m.vehicle) {
        c.vehicle = m.vehicle;
        c.length = hasTurnSignals(m.vehicle) ? VEHICLES[m.vehicle].length : 0;
        const motor = c.length > 0;
        c.accel = motor ? kinematicsOf(m.vehicle).accel : 0;
        c.kind = motor ? exhaustKind(m.vehicle) : undefined;
      }
      c.mover = m;
      c.state = c.length ? vehicleEffects(m) : undefined;
      c.atHold = false;
      c.initialized = false;
      c.wake = c.state?.exhaust ? emitterWake(c.state.exhaust) : Infinity;
    }
    if (!eligible || !c.length || c.length < this.minimum) {
      this.deactivate(c, this.clock - this.dt);
      return;
    }
    if (!c.initialized) {
      const state = c.state ?? ensureVehicleEffects(m);
      if (c.kind)
        state.sourceId ??= this.nextSourceId?.() ?? (this.seed() >>> 0) * 1048576 + ++this.serial;
      c.state = state;
      c.initialized = true;
      c.wake = state.exhaust ? emitterWake(state.exhaust) : Infinity;
    }
    const v = (m.v ?? m.speed) / this.tile.perMeter;
    const state = c.state!;
    if (state.inactiveAt !== undefined) {
      const gap = Math.max(0, this.clock - this.dt - state.inactiveAt);
      if (state.exhaust) shiftEmitter(state.exhaust, gap);
      delete state.inactiveAt;
    }
    const e = state.exhaust;
    // Eligible lazy time is active time. Prevent the emitter's standalone gap handling from
    // treating it as retirement; stoppedSince already accounts for all these idle updates.
    if (e) e.clock = this.clock - this.dt;
    const r = (this.captured[this.count++] ??= { v: 0, x: 0, y: 0, hx: 0, hy: 0 });
    r.mover = m;
    r.state = state;
    r.cached = c;
    r.v = v;
    const pose =
      e &&
      ((stoppedFor(e, this.clock - this.dt) >= PUFF.pullAway.minStop - this.dt &&
        v < PUFF.pullAway.v &&
        v + c.accel * this.dt >= PUFF.pullAway.v &&
        Math.min(target, cap) >= PUFF.pullAway.v * this.tile.perMeter) ||
        burstDue(e, this.clock) ||
        e.nextIdle <= this.clock + 1e-9)
        ? this.tile.pose(m)
        : m;
    r.x = pose.x;
    r.y = pose.y;
    r.hx = pose.hx;
    r.hy = pose.hy;
  }

  finish(clock: number, dt: number, wind: Wind, owners?: ReadonlyMap<Mover, TileLife>) {
    for (let i = 0; i < this.count; i++) {
      const r = this.captured[i]!,
        m = r.mover!,
        c = r.cached!,
        state = r.state!;
      const owner = owners?.get(m) ?? this.tile;
      const v = (m.v ?? m.speed) / owner.perMeter;
      const held = owner.scenes.held(m);
      const brake = brakeHold(state.brake, r.v, v, dt, held);
      if (state.brake !== brake) state.brake = brake;
      const kind = c.kind;
      if (
        kind &&
        (r.v < PUFF.pullAway.v ||
          v < PUFF.pullAway.v ||
          (state.exhaust && state.exhaust.burstNext < state.exhaust.burstCount))
      ) {
        const e = (state.exhaust ??= emitter(
          m.routing?.seed ??
            hashString(`${this.seed()}/exhaust/${m.vehicle}/${m.line}/${m.x}/${m.y}`),
          clock - dt,
        ));
        const due =
          e.nextIdle <= clock + 1e-9 ||
          burstDue(e, clock) ||
          (r.v < PUFF.pullAway.v &&
            v >= PUFF.pullAway.v &&
            stoppedFor(e, clock) >= PUFF.pullAway.minStop - 1e-9) ||
          dt >= PUFF.idle[0];
        stepEmitter(
          e,
          kind,
          r.v,
          v,
          clock,
          dt,
          due
            ? (at, life, spread) => {
                const end = owner.pose(m);
                const frame = frameBetween(this.tile.tile, owner.tile);
                owner.puffs.add(
                  spawnPuff(
                    state.sourceId!,
                    m.vehicle!,
                    kind,
                    {
                      x: frame.x + r.x * frame.scale,
                      y: frame.y + r.y * frame.scale,
                      hx: r.hx,
                      hy: r.hy,
                    },
                    end,
                    at,
                    life,
                    spread,
                    clock,
                    dt,
                    owner.perMeter,
                    wind,
                  ),
                );
              }
            : NO_PUFF,
        );
      } else if (state.exhaust) {
        state.exhaust.clock = clock;
        state.exhaust.stoppedSince = undefined;
        state.exhaust.nextIdle = Infinity;
      }
      if (owner !== this.tile) owner.effects.adopt(m, clock, state);
      c.wake = state.exhaust ? emitterWake(state.exhaust) : Infinity;
      c.atHold =
        state.inactiveAt === undefined &&
        !held &&
        brake === BRAKE.hold &&
        v < BRAKE.stopped &&
        v <= r.v + 1e-9;
      r.mover = undefined;
      r.state = undefined;
      r.cached = undefined;
    }
    this.count = 0;
  }
}
