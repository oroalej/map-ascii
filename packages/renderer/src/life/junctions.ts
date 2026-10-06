import { EXTENT, MERCATOR_METERS, lngLatToTile } from '../raster/geometry';
import { signalApproaches, signalJunctionKey } from './signal-approaches';
import type { TileId } from '../tiles';
import { COS20, COS30, JUNCTION } from './config';
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
import type { JunctionTraffic } from './junction-traffic';
import { binKeys, bodyCorners, type Body, type Point } from './occupancy';

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
  controlled?: boolean;
};
type RouteCursor = Pick<
  Mover,
  'line' | 'dir' | 'from' | 'd' | 'vehicle' | 'next' | 'routing' | 'junctionRoute'
>;

export type Movement = {
  key: string;
  junction: Junction;
  inHx: number;
  inHy: number;
  outHx: number;
  outHy: number;
  stop: number;
  line: number;
  dir: 1 | -1;
  exit: Arm;
  ahead: number;
  /** Physical box admission is distinct from a hold upstream of an entrance stripe. */
  boxAhead?: number;
  entry?: Arm;
};

/** Project an occupied/carried approach in its local frame; routed candidates keep route distance. */
export function boxAhead(m: Mover, p: Movement, pm: number): number {
  return (
    ((p.entry?.x ?? p.junction.x) - m.x) * p.inHx +
    ((p.entry?.y ?? p.junction.y) - m.y) * p.inHy -
    p.junction.radius -
    (JUNCTION.gap + VEHICLES[m.vehicle!].length / 2) * pm
  );
}

/** Connectivity comes from shared vertices, never geometric crossing/bridge intersections. */
export class JunctionIndex {
  junctions!: Junction[];
  hasLinked!: boolean;
  private readonly internalLines = new Set<number>();
  private readonly lines = new Map<number, Junction[]>();
  private readonly boxBins = new Map<number, Junction[]>();
  private readonly boxKeys: number[] = [];
  private readonly boxPoints = [
    { x: 0, y: 0 },
    { x: 0, y: 0 },
  ];
  private readonly spawnCorners: Point[] = [];
  private readonly spawnCandidates = new Set<Junction>();
  private readonly spawnBody: Body = { x: 0, y: 0, hx: 1, hy: 0, length: 0, width: 0 };
  private readonly found: Movement[] = [];
  private readonly visited = new Set<number>();
  private readonly routeCursor: RouteCursor = { line: 0, dir: 1, from: 0, d: 0 };
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
            j.arms.push({ line, along: along[v]!, out, hx: dx / length, hy: dy / length });
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
        controlled: true,
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
    this.boxBins.clear();
    for (const j of this.junctions) {
      yield;
      for (const line of new Set(j.arms.map((a) => a.line))) {
        const list = this.lines.get(line) ?? [];
        list.push(j);
        this.lines.set(line, list);
      }
      // The old overlap predicate's square rotates with the vehicle; contain every orientation.
      const reach = (Math.SQRT2 * j.radius) / pm;
      for (const arm of j.arms) {
        const x = (arm.x ?? j.x) / pm,
          y = (arm.y ?? j.y) / pm;
        this.boxPoints[0]!.x = x - reach;
        this.boxPoints[0]!.y = y - reach;
        this.boxPoints[1]!.x = x + reach;
        this.boxPoints[1]!.y = y + reach;
        for (const key of binKeys(this.boxPoints, 0, this.boxKeys)) {
          let bin = this.boxBins.get(key);
          if (!bin) this.boxBins.set(key, (bin = []));
          if (!bin.includes(j)) bin.push(j);
        }
      }
    }
  }

  /** Seed footprints must enter every box through arbitration, including ordinary junctions. */
  canSpawnVehicle(m: Mover): boolean {
    if (this.internalLines.has(m.line)) return false;
    const linked = this.hasLinked ? this.movement(m, 60 * this.pm) : undefined;
    if (linked?.junction.linked && linked.ahead < 0) return false;
    const spec = VEHICLES[m.vehicle!];
    const progress = this.along[m.from]! + m.dir * m.d;
    for (const j of this.lines.get(m.line) ?? []) {
      if (!j.controlled) continue;
      const entry = j.arms.find(
        (a) => a.line === m.line && a.out === -m.dir && a.inbound !== false,
      );
      if (entry?.stopAlong === undefined) continue;
      const frontPastStop = m.dir * (progress - entry.stopAlong) + (spec.length * this.pm) / 2;
      const rearPastBox = m.dir * (progress - entry.along) - (spec.length * this.pm) / 2;
      if (frontPastStop > 0 && rearPastBox <= j.radius) return false;
    }
    const body = this.spawnBody;
    body.x = m.x / this.pm;
    body.y = m.y / this.pm;
    body.hx = m.hx;
    body.hy = m.hy;
    body.length = spec.length;
    body.width = spec.width;
    this.spawnCandidates.clear();
    for (const key of binKeys(bodyCorners(body, this.spawnCorners), 0, this.boxKeys)) {
      const bin = this.boxBins.get(key);
      if (bin) for (const j of bin) this.spawnCandidates.add(j);
    }
    for (const j of this.spawnCandidates)
      for (const a of j.arms) {
        const dx = (a.x ?? j.x) - m.x,
          dy = (a.y ?? j.y) - m.y;
        if (
          Math.abs(dx * m.hx + dy * m.hy) < j.radius + (spec.length * this.pm) / 2 &&
          Math.abs(-dx * m.hy + dy * m.hx) < j.radius + (spec.width * this.pm) / 2
        )
          return false;
      }
    return true;
  }

  movement(m: Mover, reach: number): Movement | undefined {
    return this.movements(m, reach)[0];
  }
  /** Reuses the result array; movement objects remain owned by their retained records.
   * Only committed/uniquely legal continuations are enumerated; this never chooses a route. */
  movements(
    m: Mover,
    reach: number,
    next?: (line: number, dir: 1 | -1) => number | undefined,
  ): Movement[] {
    const found = this.found;
    found.length = 0;
    let cursor: RouteCursor = m,
      distance = 0;
    const visited = this.visited;
    visited.clear();
    while (distance <= reach) {
      const route = cursor.line * 2 + Number(cursor.dir === 1);
      if (visited.has(route)) break;
      visited.add(route);
      const code = next?.(cursor.line, cursor.dir);
      if (cursor !== m) cursor.next = code;
      this.lineMovements(cursor, reach - distance, distance, found);
      if (!next) break;
      const end =
        cursor.dir === 1 ? this.geo.starts[cursor.line + 1]! - 1 : this.geo.starts[cursor.line]!;
      distance += cursor.dir * (this.along[end]! - this.along[cursor.from]!) - cursor.d;
      if (code === undefined || code < 0 || distance > reach) break;
      const line = code >> 1,
        dir = code & 1 ? -1 : 1;
      cursor = this.routeCursor;
      cursor.line = line;
      cursor.dir = dir;
      cursor.from = dir === 1 ? this.geo.starts[line]! : this.geo.starts[line + 1]! - 1;
      cursor.d = 0;
      cursor.vehicle = m.vehicle;
      cursor.junctionRoute = m.junctionRoute;
      cursor.routing = undefined;
    }
    found.sort((a, b) => a.ahead - b.ahead || a.key.localeCompare(b.key));
    return found;
  }
  private lineMovements(m: RouteCursor, reach: number, routeDistance: number, found: Movement[]) {
    const progress = this.along[m.from]! + m.dir * m.d;
    for (const j of this.lines.get(m.line) ?? []) {
      if (found.some((p) => p.key === j.key)) continue;
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
      if (!exit) exit = incoming; // Dead-end fallback is still a movement to protect.
      const ahead =
        incoming.stopAlong !== undefined
          ? m.dir * (incoming.stopAlong - progress) - length / 2
          : distance - j.radius - (JUNCTION.gap * this.pm + length / 2);
      found.push({
        key: j.key,
        junction: j,
        inHx: -incoming.hx,
        inHy: -incoming.hy,
        outHx: exit.hx,
        outHy: exit.hy,
        stop: incoming.along,
        line: m.line,
        dir: m.dir,
        exit,
        ahead: routeDistance + ahead,
        entry: incoming,
      });
    }
  }
}

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

/** Tile y points south: northbound traffic yields to westbound traffic from the east. */
export function fromRight(a: Movement, b: Movement): boolean {
  return a.inHx * b.inHy - a.inHy * b.inHx < -0.5;
}
const leftTurn = (m: Movement) => m.inHx * m.outHy - m.inHy * m.outHx < -0.5;
const stable = (a: JunctionRequest, b: JunctionRequest) =>
  a.tileKey.localeCompare(b.tileKey) || a.index - b.index;

/** Reused adjacency/Tarjan buffers. SCCs break cycles without dropping external precedence. */
class Precedence {
  private edges = new Uint8Array(0);
  private visits: number[] = [];
  private lows: number[] = [];
  private stack: number[] = [];
  private active: boolean[] = [];
  private components: number[] = [];
  private degrees: number[] = [];
  private done: boolean[] = [];
  private output: Hold[] = [];
  order(rows: Hold[], precedes: (a: Hold, b: Hold) => boolean): Hold[] {
    const n = rows.length;
    if (this.edges.length < n * n) this.edges = new Uint8Array(n * n);
    this.edges.fill(0, 0, n * n);
    this.visits.length = this.lows.length = this.active.length = this.components.length = n;
    this.visits.fill(-1);
    this.active.fill(false);
    this.stack.length = 0;
    let visit = 0,
      count = 0;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++)
        if (i !== j && precedes(rows[i]!, rows[j]!)) this.edges[i * n + j] = 1;
    const dfs = (i: number) => {
      this.visits[i] = this.lows[i] = visit++;
      this.stack.push(i);
      this.active[i] = true;
      for (let j = 0; j < n; j++)
        if (this.edges[i * n + j]) {
          if (this.visits[j] === -1) {
            dfs(j);
            this.lows[i] = Math.min(this.lows[i], this.lows[j]!);
          } else if (this.active[j]) this.lows[i] = Math.min(this.lows[i], this.visits[j]!);
        }
      if (this.lows[i] !== this.visits[i]) return;
      let j: number;
      do {
        j = this.stack.pop()!;
        this.active[j] = false;
        this.components[j] = count;
      } while (j !== i);
      count++;
    };
    for (let i = 0; i < n; i++) if (this.visits[i] === -1) dfs(i);
    this.degrees.length = count;
    this.degrees.fill(0);
    this.done.length = n;
    this.done.fill(false);
    this.output.length = 0;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++)
        if (this.edges[i * n + j] && this.components[i] !== this.components[j])
          this.degrees[this.components[j]!]!++;
    while (this.output.length < n) {
      const first = rows.findIndex(
        (_, i) => !this.done[i] && this.degrees[this.components[i]!] === 0,
      );
      const component = this.components[first]!;
      // Stable order inside a cycle; baseline order selects among unconstrained components.
      const members: number[] = this.stack;
      members.length = 0;
      for (let i = 0; i < n; i++) if (this.components[i] === component) members.push(i);
      members.sort((a, b) => stable(rows[a]!, rows[b]!));
      for (const i of members) {
        this.output.push(rows[i]!);
        this.done[i] = true;
      }
      for (const i of members)
        for (let j = 0; j < n; j++)
          if (this.edges[i * n + j] && this.components[j] !== component)
            this.degrees[this.components[j]!]!--;
    }
    return this.output;
  }
}

export type JunctionRequest = {
  m: Mover;
  life: TileLife;
  tileKey: string;
  index: number;
  movement: Movement;
  ready: boolean;
  inside: boolean;
  atLine?: boolean;
  /** Immediately preceding reservation on this mover's committed route. */
  precedingKey?: string;
  traffic?: JunctionTraffic;
  /** Free metres beyond the exit box; pending holders consume this space too. */
  room?: number;
};
type Hold = JunctionRequest & {
  arrival?: number;
  since?: number;
  /** Signal clearing is earned by an outside grant, never by first observing occupancy. */
  authorizedOutside?: boolean;
  carried?: boolean;
  seen?: boolean;
  surrenderedAt?: number;
  /** Derived from the current committed-route requests. */
  followingKey?: string;
};
const NO_RECORDS: readonly Hold[] = [];
function sameExit(a: Hold, b: Hold): boolean {
  const x = a.movement,
    y = b.movement;
  if (x.outHx * y.outHx + x.outHy * y.outHy <= COS20) return false;
  let dx = (x.exit.x ?? x.junction.x) - (y.exit.x ?? y.junction.x),
    dy = (x.exit.y ?? x.junction.y) - (y.exit.y ?? y.junction.y);
  if (a.life !== b.life) {
    const f = frameBetween(a.life.tile, b.life.tile);
    dx = f.x + (x.exit.x ?? x.junction.x) * f.scale - (y.exit.x ?? y.junction.x);
    dy = f.y + (x.exit.y ?? x.junction.y) * f.scale - (y.exit.y ?? y.junction.y);
  }
  return Math.abs(dx * y.outHy - dy * y.outHx) < JUNCTION.exitHalfWidth * b.life.perMeter;
}

/** Two-phase world arbitration. Physical occupants never expire or authorize running red. */
export class JunctionTable {
  private records = new Map<Mover, Map<string, Hold>>();
  private requests: JunctionRequest[] = [];
  private clock = 0;
  private readonly precedence = new Precedence();
  private readonly batch: Hold[] = [];
  private readonly ordered: Hold[] = [];
  private readonly blocking: Hold[] = [];
  private readonly yielded = new Set<Hold>();
  private readonly eligibleRows = new Set<Hold>();
  get empty(): boolean {
    return this.records.size === 0;
  }
  begin(live: ReadonlySet<TileLife>): void {
    this.requests.length = 0;
    for (const [m, records] of this.records) {
      for (const [key, r] of records) {
        r.seen = false;
        if (!live.has(r.life)) records.delete(key);
      }
      if (!records.size) this.records.delete(m);
    }
  }
  request(r: JunctionRequest): void {
    this.requests.push(r);
  }
  holds(m: Mover): Iterable<Hold> {
    return this.records.get(m)?.values() ?? NO_RECORDS;
  }
  private record(m: Mover, key?: string): Hold | undefined {
    const records = this.records.get(m);
    if (key !== undefined) return records?.get(key);
    let primary: Hold | undefined;
    for (const r of records?.values() ?? NO_RECORDS) {
      if (
        !primary ||
        (r.inside && !primary.inside) ||
        (r.inside === primary.inside && r.movement.ahead < primary.movement.ahead)
      )
        primary = r;
    }
    return primary;
  }
  movement(m: Mover, key?: string): Movement | undefined {
    return this.record(m, key)?.movement;
  }
  granted(m: Mover, key?: string): boolean {
    return this.record(m, key)?.since !== undefined;
  }
  /** Keep provisional reservations available to the next box, while holding entry upstream
   * when a denied downstream stop cannot store the complete vehicle outside this box. */
  canEnter(m: Mover, key: string): boolean {
    const records = this.records.get(m),
      r = records?.get(key);
    return !!records && !!r && this.admission(r, records, records.size);
  }
  private admission(r: Hold, records: Map<string, Hold>, remaining: number): boolean {
    if (r.since === undefined) return false;
    if (r.inside) return true;
    if (remaining <= 0) return false;
    const next = r.followingKey === undefined ? undefined : records.get(r.followingKey);
    return !next || this.admission(next, records, remaining - 1) || this.storage(r, next);
  }
  private storage(a: Hold, b: Hold): boolean {
    const first = a.movement,
      next = b.movement;
    if (a.life !== b.life || first.outHx * next.inHx + first.outHy * next.inHy <= COS20)
      return false;
    const half = (VEHICLES[a.m.vehicle!].length * a.life.perMeter) / 2,
      entry = next.entry,
      offset =
        entry?.stopAlong !== undefined
          ? next.dir * (entry.along - entry.stopAlong) + half
          : next.junction.radius +
            JUNCTION.gap * a.life.perMeter +
            half +
            ((next.boxAhead ?? next.ahead) - next.ahead),
      dx = (entry?.x ?? next.junction.x) - next.inHx * offset - (first.exit.x ?? first.junction.x),
      dy = (entry?.y ?? next.junction.y) - next.inHy * offset - (first.exit.y ?? first.junction.y);
    return dx * first.outHx + dy * first.outHy >= first.junction.radius + half;
  }
  private revoke(r: Hold): void {
    r.since = undefined;
    r.authorizedOutside = undefined;
  }
  waited(m: Mover, key?: string): number {
    const r = this.record(m, key);
    return r?.arrival === undefined ? 0 : this.clock - r.arrival;
  }
  revokeGrant(m: Mover, key: string): void {
    const r = this.record(m, key);
    if (!r || r.inside) return;
    this.revoke(r);
    const records = this.records.get(m)!;
    for (const downstream of records.values()) {
      let preceding = downstream.precedingKey;
      for (let remaining = records.size; preceding !== undefined && remaining > 0; remaining--) {
        if (preceding === key) {
          if (!downstream.inside) this.revoke(downstream);
          break;
        }
        preceding = records.get(preceding)?.precedingKey;
      }
    }
  }
  release(m: Mover, key?: string): void {
    if (key === undefined) this.records.delete(m);
    else {
      const records = this.records.get(m);
      records?.delete(key);
      if (!records?.size) this.records.delete(m);
    }
  }
  carried(m: Mover, key?: string): boolean {
    return !!this.record(m, key)?.carried;
  }
  /** Keep the original world reservation and waiting age; only its local coordinate frame changes. */
  rebind(m: Mover, target: TileLife, tileKey: string, source: TileLife) {
    const f = frameBetween(source.tile, target.tile);
    const arm = (a: Arm): Arm => ({
      ...a,
      line: -1,
      along: a.along * f.scale,
      x: a.x === undefined ? undefined : f.x + a.x * f.scale,
      y: a.y === undefined ? undefined : f.y + a.y * f.scale,
      stopAlong: a.stopAlong === undefined ? undefined : a.stopAlong * f.scale,
    });
    for (const r of this.holds(m)) {
      const old = r.movement;
      const local =
        !r.inside &&
        target.junctionIndex.movements(m, 100 * target.perMeter).find((p) => p.key === old.key);
      r.movement =
        local && local.key === old.key
          ? local
          : {
              ...old,
              line: -1,
              stop: old.stop * f.scale,
              ahead: old.ahead * f.scale,
              boxAhead: old.boxAhead === undefined ? undefined : old.boxAhead * f.scale,
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
  }
  refreshCarried(
    m: Mover,
    ready: (movement: Movement) => boolean,
    room: number,
    key?: string,
    traffic?: JunctionTraffic,
    index?: number,
  ) {
    const r = this.record(m, key);
    if (!r?.carried) return;
    const p = r.movement,
      j = p.junction,
      pm = r.life.perMeter;
    r.index = index ?? r.life.movers.indexOf(m);
    const length = VEHICLES[m.vehicle!].length * pm;
    const past = (m.x - (p.exit.x ?? j.x)) * p.outHx + (m.y - (p.exit.y ?? j.y)) * p.outHy;
    if (past > j.radius + length / 2) {
      this.release(m, p.key);
      return;
    }
    p.ahead = boxAhead(m, p, pm);
    p.boxAhead = p.ahead;
    r.inside = p.boxAhead < -JUNCTION.insideToleranceM * pm;
    r.room = room;
    r.ready = ready(p);
    r.atLine = traffic ? traffic.atLine(m, p, r.life, this) : false;
    r.traffic = traffic;
    this.request(r);
    return r;
  }
  clear(): void {
    this.records.clear();
    this.requests = [];
  }
  snapshot() {
    return [...this.records.values()].flatMap((records) =>
      [...records.values()].map((r) => ({
        tileKey: r.tileKey,
        index: r.index,
        movement: r.movement,
        arrival: r.arrival,
        since: r.since,
        authorizedOutside: r.authorizedOutside,
        inside: r.inside,
        ready: r.ready,
        key: r.movement.key,
        atLine: r.atLine,
        surrenderedAt: r.surrenderedAt,
        precedingKey: r.precedingKey,
      })),
    );
  }
  private over(r: Hold): boolean {
    return r.arrival !== undefined && this.clock - r.arrival >= JUNCTION.maxWait;
  }
  private oncoming(a: Hold, b: Hold): boolean {
    return (
      a !== b &&
      leftTurn(a.movement) &&
      !this.over(a) &&
      !leftTurn(b.movement) &&
      ((b.atLine === true && b.ready && this.eligibleRows.has(b)) ||
        (b.inside && b.since !== undefined)) &&
      a.movement.inHx * b.movement.inHx + a.movement.inHy * b.movement.inHy < -COS20 &&
      (b.room ?? Infinity) >= VEHICLES[b.m.vehicle!].length + JUNCTION.gap
    );
  }
  private revalidateRoutes(): void {
    for (const [m, records] of this.records) {
      for (const r of records.values()) {
        if (r.inside) continue;
        let preceding = r.precedingKey;
        for (let remaining = records.size; preceding !== undefined; remaining--) {
          const upstream = records.get(preceding);
          if (upstream?.inside) break;
          if (
            !remaining ||
            !upstream ||
            upstream.since === undefined ||
            !upstream.ready ||
            (upstream.room ?? Infinity) < VEHICLES[m.vehicle!].length + JUNCTION.gap
          ) {
            r.ready = false;
            this.revoke(r);
            break;
          }
          preceding = upstream.precedingKey;
        }
      }
    }
  }
  resolve(clock: number): void {
    this.clock = clock;
    const groups = new Map<string, Hold[]>();
    for (const request of this.requests) {
      let records = this.records.get(request.m);
      if (!records) this.records.set(request.m, (records = new Map<string, Hold>()));
      const previous = records.get(request.movement.key);
      const r: Hold = previous ? Object.assign(previous, request) : { ...request };
      if (r.arrival === undefined && (r.atLine === true || r.inside)) r.arrival = clock;
      if (r.inside) r.since ??= clock;
      else if (r.since !== undefined) {
        if (clock - r.since > JUNCTION.holdMax) {
          this.revoke(r);
          r.arrival = r.atLine === true ? clock : undefined;
          r.surrenderedAt = clock;
        } else if (!r.ready || (r.room ?? Infinity) < VEHICLES[r.m.vehicle!].length + JUNCTION.gap)
          this.revoke(r);
      }
      records.set(r.movement.key, r);
      r.seen = true;
      const list = groups.get(r.movement.key) ?? [];
      list.push(r);
      groups.set(r.movement.key, list);
    }
    for (const [m, records] of this.records) {
      for (const [key, r] of records) if (!r.seen) records.delete(key);
      if (!records.size) this.records.delete(m);
      for (const r of records.values()) r.followingKey = undefined;
      for (const r of records.values())
        if (r.precedingKey !== undefined) {
          const previous = records.get(r.precedingKey);
          if (previous) previous.followingKey = r.movement.key;
        }
    }
    this.revalidateRoutes();
    this.eligibleRows.clear();
    this.yielded.clear();
    for (const group of groups.values())
      for (const r of group)
        if (
          r.ready &&
          (r.room ?? Infinity) >= VEHICLES[r.m.vehicle!].length + JUNCTION.gap &&
          group.every((b) => !b.inside || b === r || compatible(r.movement, b.movement))
        )
          this.eligibleRows.add(r);
    // Determine all upstream yields before any downstream group can arbitrate.
    for (const group of groups.values())
      for (const r of group)
        if (!r.inside && group.some((b) => this.oncoming(r, b))) {
          this.revoke(r);
          this.yielded.add(r);
        }
    this.revalidateRoutes();
    for (const group of groups.values()) {
      group.sort(
        (a, b) =>
          Number(this.over(b)) - Number(this.over(a)) ||
          (a.arrival ?? Infinity) - (b.arrival ?? Infinity) ||
          stable(a, b),
      );
      const ordered = this.ordered;
      ordered.length = 0;
      for (let i = 0; i < group.length;) {
        const anchor = group[i]!;
        if (this.over(anchor) || anchor.arrival === undefined || !anchor.ready) {
          ordered.push(anchor);
          i++;
          continue;
        }
        const batch = this.batch;
        batch.length = 0;
        let end = i;
        while (
          end < group.length &&
          group[end]!.arrival !== undefined &&
          group[end]!.arrival! - anchor.arrival < JUNCTION.tie
        )
          end++;
        for (; i < end; i++)
          if (group[i]!.ready) batch.push(group[i]!);
          else ordered.push(group[i]!);
        ordered.push(
          ...this.precedence.order(
            batch,
            (a, b) => !compatible(a.movement, b.movement) && fromRight(b.movement, a.movement),
          ),
        );
      }
      const eligible = (r: Hold) => r.ready && this.eligibleRows.has(r);
      const surrender = (a: Hold, b: Hold) =>
        !this.yielded.has(a) &&
        b.surrenderedAt !== undefined &&
        !this.over(b) &&
        a.surrenderedAt === undefined &&
        a.arrival !== undefined &&
        a.arrival <= b.surrenderedAt &&
        a.atLine === true &&
        eligible(a) &&
        !compatible(a.movement, b.movement);
      const final = this.precedence.order(
        ordered,
        (a, b) => this.oncoming(b, a) || surrender(a, b),
      );
      const blocking = this.blocking;
      blocking.length = 0;
      for (const r of group) if (r.inside || r.since !== undefined) blocking.push(r);
      for (const r of final) {
        if (this.yielded.has(r)) {
          if (r.ready && r.arrival !== undefined) blocking.push(r);
          continue;
        }
        if (r.since !== undefined || !r.ready) continue;
        let reserved = 0;
        for (const b of blocking)
          if (
            b !== r &&
            b.since !== undefined &&
            sameExit(b, r) &&
            !r.traffic?.occupiesExit(b.m, r.movement, r.life)
          )
            reserved += VEHICLES[b.m.vehicle!].length + JUNCTION.gap;
        if ((r.room ?? Infinity) - reserved < VEHICLES[r.m.vehicle!].length + JUNCTION.gap)
          continue;
        if (blocking.every((b) => b === r || compatible(r.movement, b.movement))) {
          r.since = clock;
          r.authorizedOutside = true;
          r.surrenderedAt = undefined;
          blocking.push(r);
        } else if (r.arrival !== undefined) blocking.push(r);
      }
    }
  }
}
