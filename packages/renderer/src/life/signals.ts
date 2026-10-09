import type { TileId } from '../tiles';
import { EXTENT, MERCATOR_METERS } from '../raster/geometry';
import { signalApproaches, signalJunctionKey, type SignalApproach } from './signal-approaches';
import { COS20, SIGNAL, kinematicsOf } from './config';
import { approach, type MotionLimit } from './motion';
import {
  LifeLine,
  SIGNAL_STRIDE,
  TILE_QUANTIZATION_TOLERANCE,
  type LifeGeometry,
} from './geometry';
import { placeSeed } from './lights';
import type { Mover } from './simulate';
import { VEHICLES } from './vehicles';
import { complete } from './cooperate';
import type { LifeDiagnostics } from './diagnostics';
import type { Movement } from './junctions';

export type SignalColor = 'green' | 'amber' | 'red';
export type SignalOffsets = Readonly<Record<string, number>>;
export const signalIdentity = (seed: number, midBlock: boolean) => `${seed}/${Number(midBlock)}`;
/** Lazily owned by the world; buffered copies lend the same offsets to every consumer. */
export class SignalPresses {
  readonly offsets: Record<string, number> = {};
  private readonly pressed = new Map<string, number>();
  press(seed: number, midBlock: boolean, clock: number) {
    const key = signalIdentity(seed, midBlock);
    if (clock - (this.pressed.get(key) ?? -Infinity) < 5) return false;
    this.pressed.set(key, clock);
    const phase = signalState(seed, clock, midBlock, this.offsets);
    // Clearance and the mid-block pedestrian window must finish in full.
    if (phase.a === 'green' || phase.b === 'green')
      this.offsets[key] = (this.offsets[key] ?? 0) + phase.left;
    return true;
  }
  snapshot(): SignalOffsets | undefined {
    return Object.keys(this.offsets).length ? { ...this.offsets } : undefined;
  }
}
export type SignalPhase = {
  a: SignalColor;
  b: SignalColor;
  walkA: boolean;
  walkB: boolean;
  left: number;
};
/** Pure position-seeded phases, independent of tile RNG and update rate. */
export function signalState(
  seed: number,
  clock: number,
  midBlock = false,
  offsets?: SignalOffsets,
): SignalPhase {
  if (offsets) clock += offsets[signalIdentity(seed, midBlock)] ?? 0;
  const a = midBlock ? SIGNAL.midBlock.green : SIGNAL.greenA[0] + (seed % 16);
  const b = midBlock ? SIGNAL.midBlock.walk : SIGNAL.greenB[0] + ((seed >>> 8) % 16);
  const stages: {
    length: number;
    a: SignalColor;
    b: SignalColor;
    walkA: boolean;
    walkB: boolean;
  }[] = [
    { length: a, a: 'green', b: 'red', walkA: !midBlock, walkB: false },
    { length: SIGNAL.amber, a: 'amber', b: 'red', walkA: false, walkB: false },
    { length: SIGNAL.allRed, a: 'red', b: 'red', walkA: false, walkB: false },
    { length: b, a: 'red', b: midBlock ? 'red' : 'green', walkA: midBlock, walkB: !midBlock },
    { length: midBlock ? 0 : SIGNAL.amber, a: 'red', b: 'amber', walkA: false, walkB: false },
    { length: SIGNAL.allRed, a: 'red', b: 'red', walkA: false, walkB: false },
  ];
  const cycle = stages.reduce((n, s) => n + s.length, 0);
  let phase = (((clock + (seed % cycle)) % cycle) + cycle) % cycle;
  for (const stage of stages) {
    if (phase < stage.length)
      return {
        a: stage.a,
        b: stage.b,
        walkA: stage.walkA,
        walkB: stage.walkB,
        left: stage.length - phase,
      };
    phase -= stage.length;
  }
  throw new Error('invalid signal clock');
}
/** One permission/clearance clock shared by pedestrian heads and curb gates. */
export function pedestrianState(
  seed: number,
  clock: number,
  midBlock: boolean,
  group: 'a' | 'b',
  offsets?: SignalOffsets,
): 'walk' | 'flash' | 'dont' {
  const phase = signalState(seed, clock, midBlock, offsets);
  if (!(group === 'a' ? phase.walkA : phase.walkB)) return 'dont';
  return phase.left >= SIGNAL.walkMin ? 'walk' : 'flash';
}
type Point = { x: number; y: number };
type Signal = Point & {
  radius: number;
  a: number;
  b: number;
  seed: number;
  approaches?: SignalApproach[];
  key?: string;
};
type Stop = { along: number; signal: Signal; group: 'a' | 'b'; dir?: 1 | -1; exact?: boolean };
const axis = (x: number, y: number) => ((Math.atan2(x, -y) * 180) / Math.PI + 180) % 180;
const angle = (a: number, b: number) => Math.min(Math.abs(a - b), 180 - Math.abs(a - b));
const group = (s: Signal, x: number, y: number): 'a' | 'b' =>
  s.a < 0 || angle(axis(x, y), s.a) <= angle(axis(x, y), s.b) ? 'a' : 'b';

export class SignalControl {
  offsets?: SignalOffsets;
  readonly signals: Signal[] = [];
  private readonly stops = new Map<number, Stop[]>();
  constructor(
    tile: TileId,
    private readonly geo: LifeGeometry,
    private readonly perMeter: number,
    private readonly along: Float64Array,
    deferred = false,
  ) {
    if (!deferred) complete(this.prepare(tile, geo));
  }
  *prepare(tile: TileId, geo: LifeGeometry): Generator<void, void, void> {
    const { perMeter, along } = this;
    const values = geo.signals ?? [];
    const scale = MERCATOR_METERS / (EXTENT * 2 ** tile.z);
    for (let i = 0; i < values.length; i += SIGNAL_STRIDE) {
      yield;
      const x = values[i]!,
        y = values[i + 1]!;
      const layout = geo.signalLayouts?.[i / SIGNAL_STRIDE];
      const exact = geo.signalStops?.[i / SIGNAL_STRIDE];
      this.signals.push({
        x,
        y,
        radius: values[i + 2]!,
        a: values[i + 3]!,
        b: values[i + 4]!,
        seed:
          geo.signalSeeds?.[i / SIGNAL_STRIDE] ??
          placeSeed((tile.x * EXTENT + x) * scale, (tile.y * EXTENT + y) * scale),
        approaches:
          (layout || exact) &&
          signalApproaches(tile, geo, layout ?? { members: [], arms: exact! }, along, true),
        key: layout && signalJunctionKey(layout),
      });
    }
    for (let line = 0; line < geo.kinds.length; line++) {
      yield;
      if (geo.kinds[line]! > LifeLine.path) continue;
      const stops: Stop[] = [];
      for (const s of this.signals) {
        if (s.approaches) {
          for (const a of s.approaches) {
            if (a.line === line && a.arm.inbound && a.stopAlong !== undefined)
              stops.push({
                along: a.stopAlong,
                signal: s,
                group: a.arm.group,
                dir: a.arm.stop_direction ?? a.arm.direction,
                exact: true,
              });
          }
          continue;
        }
        for (let v = geo.starts[line]! + 1; v < geo.starts[line + 1]!; v++) {
          if ((v & 63) === 0) yield;
          const x = geo.coords[(v - 1) * 2]!,
            y = geo.coords[(v - 1) * 2 + 1]!;
          const dx = geo.coords[v * 2]! - x,
            dy = geo.coords[v * 2 + 1]! - y,
            length = Math.hypot(dx, dy);
          const t = Math.max(
            0,
            Math.min(1, ((s.x - x) * dx + (s.y - y) * dy) / (length * length || 1)),
          );
          if (Math.hypot(s.x - x - t * dx, s.y - y - t * dy) > (s.radius + 1) * perMeter) continue;
          const at = along[v - 1]! + length * t;
          if (!stops.some((stop) => stop.signal === s && Math.abs(stop.along - at) < perMeter))
            stops.push({ along: at, signal: s, group: group(s, dx, dy) });
        }
      }
      if (stops.length) this.stops.set(line, stops);
    }
  }
  vehicleSpeed(m: Mover, dt: number, clock: number): number {
    const out = { target: m.speed, cap: Infinity };
    this.vehicleLimit(m, dt, clock, out);
    return Math.min(out.target, out.cap);
  }
  /** The extra entrance hold belongs only to crossings without an existing controller. */
  controlsCrossing(centre: Point): boolean {
    return (this.geo.controlledCrossings ?? []).some(
      (crossing) =>
        Math.hypot(crossing.anchor.x - centre.x, crossing.anchor.y - centre.y) <=
        TILE_QUANTIZATION_TOLERANCE,
    );
  }
  /** Junction entry ownership is separate from exact, tagged pedestrian crossing anchors. */
  controlsApproach(line: number, centre: Point): boolean {
    for (const s of this.signals) {
      const reach = (s.radius + 2) * this.perMeter;
      if (s.approaches) {
        if (
          s.approaches.some(
            (a) => a.line === line && Math.hypot(a.x - centre.x, a.y - centre.y) <= reach,
          )
        )
          return true;
      } else if (
        this.stops.get(line)?.some((stop) => stop.signal === s) &&
        Math.hypot(s.x - centre.x, s.y - centre.y) <= reach
      )
        return true;
    }
    return false;
  }
  vehicleLimit(
    m: Mover,
    dt: number,
    clock: number,
    out: MotionLimit,
    clearing?: ReadonlySet<string>,
    diagnostics?: LifeDiagnostics,
  ): boolean {
    const stops = this.stops.get(m.line);
    if (!stops) return false;
    let held = false;

    const progress = this.along[m.from]! + m.dir * m.d;
    for (const stop of stops) {
      if (stop.dir !== undefined && stop.dir !== m.dir) continue;
      if (clearing?.has(stop.signal.key ?? `legacy:${stop.signal.x}/${stop.signal.y}`)) continue;
      const ahead = this.stopAhead(m, stop, progress);
      if (ahead < -0.5 * this.perMeter || ahead >= SIGNAL.lookahead * this.perMeter) continue;
      const state = signalState(stop.signal.seed, clock, stop.signal.a < 0, this.offsets)[
        stop.group
      ];
      const brake = (m.vehicle ? kinematicsOf(m.vehicle).brake : SIGNAL.brake) * this.perMeter;
      const v = m.v ?? m.speed;
      if (state === 'red' || (state === 'amber' && (v * v) / (2 * brake) <= ahead)) {
        if (ahead <= 0.5 * this.perMeter) {
          held = true;
          diagnostics?.hold(m, 'signal');
        }
        out.target = Math.min(out.target, approach(ahead, 0, brake));
        out.cap = Math.min(out.cap, Math.max(0, ahead) / dt);
      }
    }
    return held;
  }
  /** Distance to the next protected stop, including green approaches, in tile units. */
  caught(m: Mover, seed: number, midBlock: boolean, clock: number) {
    const v = m.v ?? m.speed;
    if (v <= 0.5 * this.perMeter) return false;
    const progress = this.along[m.from]! + m.dir * m.d;
    const brake = kinematicsOf(m.vehicle).brake * this.perMeter;
    return (this.stops.get(m.line) ?? []).some((stop) => {
      if (
        stop.signal.seed !== seed ||
        stop.signal.a < 0 !== midBlock ||
        (stop.dir !== undefined && stop.dir !== m.dir)
      )
        return false;
      const ahead = this.stopAhead(m, stop, progress);
      return (
        ahead >= 0 &&
        ahead < SIGNAL.lookahead * this.perMeter &&
        (v * v) / (2 * brake) <= ahead &&
        signalState(seed, clock, midBlock, this.offsets)[stop.group] !== 'green'
      );
    });
  }
  protectedRoom(m: Mover): number {
    let room = Infinity;
    const progress = this.along[m.from]! + m.dir * m.d;
    for (const stop of this.stops.get(m.line) ?? []) {
      if (stop.dir !== undefined && stop.dir !== m.dir) continue;
      const ahead = this.stopAhead(m, stop, progress);
      if (ahead >= -0.5 * this.perMeter) room = Math.min(room, Math.max(0, ahead));
    }
    return room;
  }
  private stopAhead(m: Mover, stop: Stop, progress: number): number {
    return (
      m.dir * (stop.along - progress) -
      ((stop.exact ? 0 : stop.signal.radius + SIGNAL.gap) +
        (m.vehicle ? VEHICLES[m.vehicle].length / 2 : 2)) *
        this.perMeter
    );
  }
  allows(
    m: Mover,
    x: number,
    y: number,
    clock: number,
    ahead: number,
    movement?: Movement,
  ): boolean {
    for (const s of this.signals) {
      if (movement && s.key && s.approaches?.length && s.key !== movement.key) continue;
      // An unmatched exact layout adds no stop. A real box still needs red admission safety.
      if (s.approaches && (s.approaches.length || !movement)) {
        const entry = s.approaches.find(
          (a) =>
            a.arm.inbound &&
            (movement?.entry?.line === -1
              ? -a.hx * movement.inHx - a.hy * movement.inHy > COS20
              : a.line === (movement?.entry?.line ?? m.line) &&
                a.arm.direction === (movement?.dir ?? m.dir)) &&
            Math.hypot(a.x - x, a.y - y) <= TILE_QUANTIZATION_TOLERANCE,
        );
        if (!entry) continue;
        const state = signalState(s.seed, clock, s.a < 0, this.offsets)[entry.arm.group];
        const brake = kinematicsOf(m.vehicle).brake * this.perMeter;
        if (state === 'red' || (state === 'amber' && (m.v ?? m.speed) ** 2 / (2 * brake) <= ahead))
          return false;
        continue;
      }
      if (Math.hypot(s.x - x, s.y - y) > (s.radius + 2) * this.perMeter) continue;
      const state = signalState(s.seed, clock, s.a < 0, this.offsets)[
        group(s, movement?.inHx ?? m.hx, movement?.inHy ?? m.hy)
      ];
      const brake = kinematicsOf(m.vehicle).brake * this.perMeter;
      if (state === 'red' || (state === 'amber' && (m.v ?? m.speed) ** 2 / (2 * brake) <= ahead))
        return false;
    }
    return true;
  }
  /** A signal's explicit stop may lie before the junction's geometric admission line. */
  atStoppingLine(m: Mover, movement: Movement): boolean {
    const progress = this.along[m.from]! + m.dir * m.d;
    return (
      this.stops.get(m.line)?.some((stop) => {
        if (
          (stop.dir !== undefined && stop.dir !== m.dir) ||
          (stop.signal.key && stop.signal.key !== movement.key)
        )
          return false;
        const ahead =
          m.dir * (stop.along - progress) -
          ((stop.exact ? 0 : stop.signal.radius + SIGNAL.gap) +
            (m.vehicle ? VEHICLES[m.vehicle].length / 2 : 2)) *
            this.perMeter;
        return Math.abs(ahead) <= 0.5 * this.perMeter;
      }) ?? false
    );
  }
  /** Older archives lack layout keys; match only the controller at the admitted box. */
  controllerKeys(movement: Movement): string[] {
    return this.signals
      .filter(
        (s) =>
          s.key === movement.key ||
          (!s.key &&
            Math.hypot(s.x - movement.junction.x, s.y - movement.junction.y) <=
              (s.radius + 2) * this.perMeter),
      )
      .map((s) => s.key ?? `legacy:${s.x}/${s.y}`);
  }
  controllerRadius(movement: Movement): number {
    return Math.max(
      0,
      ...this.signals
        .filter(
          (s) =>
            s.key === movement.key ||
            (!s.key &&
              Math.hypot(s.x - movement.junction.x, s.y - movement.junction.y) <=
                (s.radius + 2) * this.perMeter),
        )
        .map((s) => s.radius),
    );
  }
}
