import { EXTENT, MERCATOR_METERS, lngLatToTile } from '../raster/geometry';
import { signalApproaches, signalJunctionKey } from './signal-approaches';
import type { TileId } from '../tiles';
import { JUNCTION } from './config';
import {
  LifeLine,
  SIGNAL_STRIDE,
  TILE_QUANTIZATION_TOLERANCE,
  type LifeGeometry,
} from './geometry';
import type { Mover, TileLife } from './simulate';
import { VEHICLES } from './vehicles';
import { frameBetween } from './frames';
import { complete } from './cooperate';

export type Arm = {
  line: number;
  along: number;
  out: 1 | -1;
  hx: number;
  hy: number;
  x?: number;
  y?: number;
  inbound?: boolean;
  outbound?: boolean;
  stopAlong?: number;
};
export type Junction = {
  key: string;
  x: number;
  y: number;
  radius: number;
  arms: Arm[];
  linked?: boolean;
};
export type Movement = {
  key: string;
  junction: Junction;
  inHx: number;
  inHy: number;
  outHx: number;
  outHy: number;
  rank: number;
  stop: number;
  line: number;
  dir: 1 | -1;
  exit: Arm;
  ahead: number;
  entry?: Arm;
};

/** Connectivity comes from shared vertices, never geometric crossing/bridge intersections. */
export class JunctionIndex {
  junctions!: Junction[];
  hasLinked!: boolean;
  private readonly internalLines = new Set<number>();
  private readonly lines = new Map<number, Junction[]>();
  constructor(
    tile: TileId,
    private geo: LifeGeometry,
    private pm: number,
    private along: Float64Array,
    deferred = false,
  ) {
    if (!deferred) complete(this.prepare(tile));
  }
  *prepare(tile: TileId): Generator<void, void, void> {
    const { geo, pm, along } = this;
    const vertices = new Map<string, Junction>();
    const scale = MERCATOR_METERS / (EXTENT * 2 ** tile.z);
    for (let line = 0; line < geo.kinds.length; line++) {
      if (geo.kinds[line]! > LifeLine.roadMinor) continue;
      const first = geo.starts[line]!,
        last = geo.starts[line + 1]! - 1;
      for (let v = first; v <= last; v++) {
        if ((v & 63) === 0) yield;
        const x = geo.coords[v * 2]!,
          y = geo.coords[v * 2 + 1]!;
        const key = `${x}/${y}`;
        const j = vertices.get(key) ?? {
          key: `${Math.round((tile.x * EXTENT + x) * scale)}/${Math.round((tile.y * EXTENT + y) * scale)}`,
          x,
          y,
          radius: 0,
          arms: [],
        };
        j.radius = Math.max(j.radius, ((geo.widths[line] || 6) / 2 + JUNCTION.margin) * pm);
        for (const out of [-1, 1] as const) {
          const next = v + out;
          if (next < first || next > last) continue;
          const dx = geo.coords[next * 2]! - x,
            dy = geo.coords[next * 2 + 1]! - y;
          const length = Math.hypot(dx, dy);
          if (length)
            j.arms.push({
              line,
              along: along[v]!,
              out,
              hx: dx / length,
              hy: dy / length,
              inbound: !geo.oneway?.[line] || geo.oneway[line] === -out,
              outbound: !geo.oneway?.[line] || geo.oneway[line] === out,
            });
        }
        vertices.set(key, j);
      }
    }
    const resolved: Junction[] = [];
    for (const [index, layout] of (geo.signalLayouts ?? []).entries()) {
      yield;
      if (!layout) continue;
      const members = layout.members.map((p) => lngLatToTile(tile, ...p));
      const arms = signalApproaches(tile, geo, layout, along);
      if (members.length > 1) {
        for (let line = 0; line < geo.kinds.length; line++) {
          if (geo.kinds[line]! > LifeLine.roadMinor) continue;
          const ends = [geo.starts[line]!, geo.starts[line + 1]! - 1];
          if (
            ends.every((v) =>
              members.some(
                (p) =>
                  Math.hypot(p.x - geo.coords[v * 2]!, p.y - geo.coords[v * 2 + 1]!) <=
                  TILE_QUANTIZATION_TOLERANCE,
              ),
            )
          )
            this.internalLines.add(line);
        }
      }
      // A buffered copy with no local approach does not own a reservation zone.
      if (!arms.length) continue;
      for (const [key, j] of vertices)
        if (members.some((p) => Math.hypot(p.x - j.x, p.y - j.y) <= TILE_QUANTIZATION_TOLERANCE))
          vertices.delete(key);
      resolved.push({
        key: signalJunctionKey(layout),
        x: members[0]!.x,
        y: members[0]!.y,
        radius: geo.signals![index * SIGNAL_STRIDE + 2]! * pm,
        linked: members.length > 1,
        arms: arms.map((a) => ({
          line: a.line,
          along: a.along,
          out: a.out,
          hx: a.hx,
          hy: a.hy,
          x: a.x,
          y: a.y,
          inbound: a.arm.inbound,
          outbound: a.arm.outbound,
          stopAlong: a.stopAlong,
        })),
      });
    }
    this.junctions = [...vertices.values(), ...resolved].filter(
      (j) => j.arms.length >= 3 && new Set(j.arms.map((a) => a.line)).size >= 2,
    );
    this.hasLinked = this.junctions.some((j) => j.linked);
    for (const j of this.junctions)
      for (const line of new Set(j.arms.map((a) => a.line))) {
        const list = this.lines.get(line) ?? [];
        list.push(j);
        this.lines.set(line, list);
      }
  }

  /** Initial traffic must enter a linked zone through its gates and acquire a reservation. */
  canSpawnVehicle(m: Mover): boolean {
    if (!this.hasLinked) return true;
    if (this.internalLines.has(m.line)) return false;
    const movement = this.movement(m, 60 * this.pm);
    return !movement?.junction.linked || movement.ahead >= 0;
  }

  movement(m: Mover, reach: number): Movement | undefined {
    let nearest: Movement | undefined;
    const progress = this.along[m.from]! + m.dir * m.d;
    for (const j of this.lines.get(m.line) ?? []) {
      const incoming = j.arms.find(
        (a) => a.line === m.line && a.out === -m.dir && a.inbound !== false,
      );
      if (!incoming) continue;
      const distance = m.dir * (incoming.along - progress);
      const length = VEHICLES[m.vehicle!].length * this.pm;
      if (distance < -j.radius - length / 2 || distance > reach) continue;
      let exit = j.arms.find((a) => a.line === m.line && a.out === m.dir && a.outbound !== false);
      if (!exit) {
        const code =
          m.junctionRoute?.key === j.key
            ? m.junctionRoute.exits.at(-1)
            : (m.routing?.plan?.exit ?? m.next);
        exit = j.arms.find(
          (a) =>
            a.line === (code === undefined ? -1 : code >> 1) &&
            a.out === (code! & 1 ? -1 : 1) &&
            a.outbound !== false,
        );
      }
      if (!exit) {
        if (incoming.outbound === false) continue;
        exit = incoming; // A legal two-way dead-end fallback remains protected.
      }
      const ahead =
        incoming.stopAlong !== undefined
          ? m.dir * (incoming.stopAlong - progress) - length / 2
          : distance - j.radius - (JUNCTION.gap * this.pm + length / 2);
      if (!nearest || ahead < nearest.ahead)
        nearest = {
          key: j.key,
          junction: j,
          inHx: -incoming.hx,
          inHy: -incoming.hy,
          outHx: exit.hx,
          outHy: exit.hy,
          rank: this.geo.kinds[m.line]!,
          stop: incoming.along,
          line: m.line,
          dir: m.dir,
          exit,
          ahead,
          entry: incoming,
        };
    }
    return nearest;
  }
}

const COS20 = Math.cos(Math.PI / 9),
  COS30 = Math.cos(Math.PI / 6);
export function compatible(a: Movement, b: Movement): boolean {
  const sameIn = a.inHx * b.inHx + a.inHy * b.inHy > COS20;
  // Offset member junctions can make nominally opposing straight routes cross. Reserve
  // the combined zone conservatively, allowing only followers on the same approach.
  if (a.junction.linked || b.junction.linked)
    return sameIn && a.entry?.x === b.entry?.x && a.entry?.y === b.entry?.y;
  if (sameIn) return true;
  if (a.outHx * b.outHx + a.outHy * b.outHy > COS20) return false;
  const straight = (m: Movement) => m.inHx * m.outHx + m.inHy * m.outHy > COS30;
  if (straight(a) && straight(b) && a.inHx * b.inHx + a.inHy * b.inHy < -COS20) return true;
  const right = (m: Movement) => m.inHx * m.outHy - m.inHy * m.outHx > 0.5;
  return right(a) && right(b);
}

export type JunctionRequest = {
  m: Mover;
  life: TileLife;
  tileKey: string;
  index: number;
  movement: Movement;
  ready: boolean;
  inside: boolean;
  /** Free metres beyond the exit box; pending holders consume this space too. */
  room?: number;
};
type Hold = JunctionRequest & { arrival: number; since?: number; carried?: boolean };

/** Two-phase world arbitration. Physical occupants never expire or authorize running red. */
export class JunctionTable {
  private records = new Map<Mover, Hold>();
  private requests: JunctionRequest[] = [];
  private clock = 0;
  begin(live: ReadonlySet<TileLife>): void {
    this.requests = [];
    for (const [m, r] of this.records) if (!live.has(r.life)) this.records.delete(m);
  }
  request(r: JunctionRequest): void {
    this.requests.push(r);
  }
  movement(m: Mover): Movement | undefined {
    return this.records.get(m)?.movement;
  }
  granted(m: Mover): boolean {
    return this.records.get(m)?.since !== undefined;
  }
  waited(m: Mover): number {
    const r = this.records.get(m);
    return r ? this.clock - r.arrival : 0;
  }
  release(m: Mover): void {
    this.records.delete(m);
  }
  carried(m: Mover): boolean {
    return !!this.records.get(m)?.carried;
  }
  /** Keep the original world reservation and waiting age; only its local coordinate frame changes. */
  rebind(m: Mover, target: TileLife, tileKey: string, source: TileLife) {
    const r = this.records.get(m);
    if (!r) return;
    const f = frameBetween(source.tile, target.tile);
    const arm = (a: Arm): Arm => ({
      ...a,
      line: -1,
      along: a.along * f.scale,
      x: a.x === undefined ? undefined : f.x + a.x * f.scale,
      y: a.y === undefined ? undefined : f.y + a.y * f.scale,
      stopAlong: a.stopAlong === undefined ? undefined : a.stopAlong * f.scale,
    });
    const old = r.movement;
    const local = !r.inside && target.junctionIndex.movement(m, 100 * target.perMeter);
    r.movement =
      local && local.key === old.key
        ? local
        : {
            ...old,
            line: -1,
            stop: old.stop * f.scale,
            ahead: old.ahead * f.scale,
            junction: {
              ...old.junction,
              x: f.x + old.junction.x * f.scale,
              y: f.y + old.junction.y * f.scale,
              radius: old.junction.radius * f.scale,
              arms: old.junction.arms.map(arm),
            },
            entry: old.entry && arm(old.entry),
            exit: arm(old.exit),
          };
    r.carried = !(local && local.key === old.key);
    r.life = target;
    r.tileKey = tileKey;
    r.index = target.movers.indexOf(m);
  }
  refreshCarried(m: Mover, ready: (movement: Movement) => boolean, room: number) {
    const r = this.records.get(m);
    if (!r?.carried) return;
    const p = r.movement,
      j = p.junction,
      pm = r.life.perMeter;
    const length = VEHICLES[m.vehicle!].length * pm;
    const past = (m.x - (p.exit.x ?? j.x)) * p.outHx + (m.y - (p.exit.y ?? j.y)) * p.outHy;
    if (past > j.radius + length / 2) {
      this.release(m);
      return;
    }
    p.ahead =
      ((p.entry?.x ?? j.x) - m.x) * p.inHx +
      ((p.entry?.y ?? j.y) - m.y) * p.inHy -
      j.radius -
      length / 2;
    r.inside = p.ahead < -0.05 * pm;
    r.room = room;
    r.ready = ready(p);
    this.request(r);
  }
  clear(): void {
    this.records.clear();
    this.requests = [];
  }
  snapshot() {
    return [...this.records.values()].map((r) => ({
      tileKey: r.tileKey,
      index: r.index,
      movement: r.movement,
      arrival: r.arrival,
      since: r.since,
      inside: r.inside,
      ready: r.ready,
    }));
  }
  resolve(clock: number): void {
    this.clock = clock;
    const seen = new Set<Mover>();
    const groups = new Map<string, Hold[]>();
    for (const request of this.requests) {
      const previous = this.records.get(request.m);
      const r: Hold =
        previous?.movement.key === request.movement.key
          ? Object.assign(previous, request)
          : { ...request, arrival: clock };
      if (!r.inside && r.since !== undefined && clock - r.since > JUNCTION.holdMax)
        r.since = undefined;
      this.records.set(r.m, r);
      seen.add(r.m);
      const list = groups.get(r.movement.key) ?? [];
      list.push(r);
      groups.set(r.movement.key, list);
    }
    for (const m of this.records.keys()) if (!seen.has(m)) this.records.delete(m);
    for (const group of groups.values()) {
      group.sort(
        (a, b) =>
          Number(clock - b.arrival >= JUNCTION.maxWait) -
            Number(clock - a.arrival >= JUNCTION.maxWait) ||
          Math.floor(a.arrival / JUNCTION.tie) - Math.floor(b.arrival / JUNCTION.tie) ||
          a.movement.rank - b.movement.rank ||
          a.arrival - b.arrival ||
          a.tileKey.localeCompare(b.tileKey) ||
          a.index - b.index,
      );
      const blocking = group.filter((r) => r.inside || r.since !== undefined);
      for (const r of group) {
        if (r.since !== undefined || !r.ready) continue;
        const reserved = blocking.reduce(
          (sum, b) =>
            sum +
            (b !== r &&
            b.since !== undefined &&
            !b.inside &&
            b.movement.outHx * r.movement.outHx + b.movement.outHy * r.movement.outHy > COS20
              ? VEHICLES[b.m.vehicle!].length + JUNCTION.gap
              : 0),
          0,
        );
        if ((r.room ?? Infinity) - reserved < VEHICLES[r.m.vehicle!].length + JUNCTION.gap)
          continue;
        if (blocking.every((b) => b === r || compatible(r.movement, b.movement))) {
          r.since = clock;
          blocking.push(r);
        } else blocking.push(r); // Earlier ready waiters retain priority against later conflicts.
      }
    }
  }
}
