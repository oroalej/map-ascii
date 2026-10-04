import type { TileId } from '../tiles';
import { EXTENT, MERCATOR_METERS, lngLatToTile } from '../raster/geometry';
import { signalApproaches, signalJunctionKey, type SignalApproach } from './signal-approaches';
import { SIGNAL, kinematicsOf } from './config';
import { approach, type MotionLimit } from './motion';
import { LifeLine, SIGNAL_STRIDE, type LifeGeometry } from './geometry';
import { placeSeed } from './lights';
import type { Mover } from './simulate';
import { VEHICLES } from './vehicles';
import { complete } from './cooperate';
import type { LifeDiagnostics } from './diagnostics';

export type SignalColor = 'green' | 'amber' | 'red';
export type SignalPhase = {
  a: SignalColor;
  b: SignalColor;
  walkA: boolean;
  walkB: boolean;
  left: number;
};
/** Pure position-seeded phases, independent of tile RNG and update rate. */
export function signalState(seed: number, clock: number, midBlock = false): SignalPhase {
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
type Point = { x: number; y: number };
type Signal = Point & {
  radius: number;
  a: number;
  b: number;
  seed: number;
  approaches?: SignalApproach[];
  members?: Point[];
  key?: string;
};
type Stop = { along: number; signal: Signal; group: 'a' | 'b'; dir?: 1 | -1; exact?: boolean };
const axis = (x: number, y: number) => ((Math.atan2(x, -y) * 180) / Math.PI + 180) % 180;
const angle = (a: number, b: number) => Math.min(Math.abs(a - b), 180 - Math.abs(a - b));
const group = (s: Signal, x: number, y: number): 'a' | 'b' =>
  s.a < 0 || angle(axis(x, y), s.a) <= angle(axis(x, y), s.b) ? 'a' : 'b';

export class SignalControl {
  readonly signals: Signal[] = [];
  private readonly stops = new Map<number, Stop[]>();
  constructor(
    tile: TileId,
    geo: LifeGeometry,
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
      this.signals.push({
        x,
        y,
        radius: values[i + 2]!,
        a: values[i + 3]!,
        b: values[i + 4]!,
        seed: placeSeed((tile.x * EXTENT + x) * scale, (tile.y * EXTENT + y) * scale),
        approaches: layout && signalApproaches(tile, geo, layout, along),
        key: layout && signalJunctionKey(layout),
        members: layout?.members.map((p) => lngLatToTile(tile, ...p)),
      });
    }
    for (let line = 0; line < geo.kinds.length; line++) {
      yield;
      if (geo.kinds[line]! > LifeLine.path) continue;
      const stops: Stop[] = [];
      for (const s of this.signals) {
        if (s.approaches?.length) {
          for (const a of s.approaches) {
            if (a.line === line && a.arm.inbound && a.stopAlong !== undefined)
              stops.push({
                along: a.stopAlong,
                signal: s,
                group: a.arm.group,
                dir: a.arm.direction,
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
  vehicleLimit(
    m: Mover,
    dt: number,
    clock: number,
    out: MotionLimit,
    clearing?: string,
    diagnostics?: LifeDiagnostics,
  ): boolean {
    let held = false;
    const progress = this.along[m.from]! + m.dir * m.d;
    for (const stop of this.stops.get(m.line) ?? []) {
      if (stop.dir !== undefined && stop.dir !== m.dir) continue;
      if (clearing && stop.signal.key === clearing) continue;
      const ahead =
        m.dir * (stop.along - progress) -
        ((stop.exact ? 0 : stop.signal.radius + SIGNAL.gap) +
          (m.vehicle ? VEHICLES[m.vehicle].length / 2 : 2)) *
          this.perMeter;
      if (ahead < -0.5 * this.perMeter || ahead >= SIGNAL.lookahead * this.perMeter) continue;
      const state = signalState(stop.signal.seed, clock, stop.signal.a < 0)[stop.group];
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
  allows(m: Mover, x: number, y: number, clock: number, ahead: number): boolean {
    for (const s of this.signals) {
      if (s.approaches?.length) {
        const entry = s.approaches.find(
          (a) =>
            a.arm.inbound &&
            a.line === m.line &&
            a.arm.direction === m.dir &&
            Math.hypot(a.x - x, a.y - y) <= 2,
        );
        if (!entry) continue;
        const state = signalState(s.seed, clock, s.a < 0)[entry.arm.group];
        const brake = kinematicsOf(m.vehicle).brake * this.perMeter;
        if (state === 'red' || (state === 'amber' && (m.v ?? m.speed) ** 2 / (2 * brake) <= ahead))
          return false;
        continue;
      }
      if (Math.hypot(s.x - x, s.y - y) > (s.radius + 2) * this.perMeter) continue;
      const state = signalState(s.seed, clock, s.a < 0)[group(s, m.hx, m.hy)];
      const brake = kinematicsOf(m.vehicle).brake * this.perMeter;
      if (state === 'red' || (state === 'amber' && (m.v ?? m.speed) ** 2 / (2 * brake) <= ahead))
        return false;
    }
    return true;
  }
  /** Clamp new crossing entries; someone inside the crossing always clears it. */
  walkDistance(
    from: Point,
    toward: Point,
    distance: number,
    clock: number,
    diagnostics?: LifeDiagnostics,
  ): number {
    const dx = toward.x - from.x,
      dy = toward.y - from.y,
      length = Math.hypot(dx, dy);
    if (!length) return distance;
    const hx = dx / length,
      hy = dy / length;
    for (const s of this.signals) {
      const radius = (s.radius + 0.5) * this.perMeter;
      const centers = s.members ?? [s];
      if (
        centers.some((p) => Math.hypot(p.x - from.x, p.y - from.y) < radius - 0.01 * this.perMeter)
      )
        continue;
      for (const center of centers) {
        const px = center.x - from.x,
          py = center.y - from.y;
        if (Math.hypot(px, py) < radius - 0.01 * this.perMeter) continue;
        const projection = px * hx + py * hy,
          lateral2 = px * px + py * py - projection * projection;
        if (projection < 0 || lateral2 >= radius * radius) continue;
        const entry = projection - Math.sqrt(Math.max(0, radius * radius - lateral2));
        if (entry < -0.01 * this.perMeter || entry > distance) continue;
        const state = signalState(s.seed, clock, s.a < 0),
          walking = group(s, hx, hy) === 'a' ? state.walkA : state.walkB;
        if (!walking || state.left < SIGNAL.walkMin) {
          distance = Math.min(distance, Math.max(0, entry));
          if (distance <= 0.01 * this.perMeter) diagnostics?.hold(from, 'signal');
        }
      }
    }
    return distance;
  }
}
