import { frameBetween } from './frames';
import { VEHICLES } from './vehicles';
import { JUNCTION } from './config';
import type { JunctionTable, Movement } from './junctions';
import type { Mover, TileLife } from './simulate';

type TrafficBody = {
  m: Mover;
  life: TileLife;
  x: number;
  y: number;
  hx: number;
  hy: number;
  length: number;
  qx: number;
  qy: number;
  qhx: number;
  qhy: number;
};
type TrafficFrame = { reference: TileLife; x: number; y: number; units: number; scale: number };
const BIN = 32,
  COS20 = Math.cos(Math.PI / 9);
/** One ownership-filtered, deduplicated metric traffic index for the entire arbitration step. */
export class JunctionTraffic {
  private reference?: TileLife;
  // Two numeric keys avoid strings and impose no packed-key coordinate range.
  private readonly bins = new Map<number, Map<number, TrafficBody[]>>();
  private readonly bodies = new Map<Mover, TrafficBody>();
  private readonly candidates = new Set<TrafficBody>();
  private readonly cache = new WeakMap<Mover, TrafficBody>();
  private readonly frames = new WeakMap<TileLife, TrafficFrame>();
  private readonly metric = { x: 0, y: 0, scale: 1, radius: 0 };
  begin(reference: TileLife) {
    if (reference !== this.reference) this.bins.clear();
    this.reference = reference;
    for (const row of this.bins.values()) for (const bin of row.values()) bin.length = 0;
    this.bodies.clear();
  }
  private tileFrame(life: TileLife): TrafficFrame {
    const ref = this.reference!;
    let cached = this.frames.get(life);
    if (cached?.reference === ref) return cached;
    const f = frameBetween(life.tile, ref.tile);
    if (!cached) {
      cached = { reference: ref, x: 0, y: 0, units: 0, scale: 0 };
      this.frames.set(life, cached);
    }
    cached.reference = ref;
    cached.x = f.x / ref.perMeter;
    cached.y = f.y / ref.perMeter;
    cached.units = f.scale / ref.perMeter;
    cached.scale = life.perMeter * cached.units;
    return cached;
  }
  add(life: TileLife, m: Mover) {
    if (m.kind !== 'vehicle' || !m.vehicle) return;
    const f = this.tileFrame(life),
      x = f.x + m.x * f.units,
      y = f.y + m.y * f.units,
      qx = Math.round(x * 1000),
      qy = Math.round(y * 1000),
      qhx = Math.round(m.hx * 1000),
      qhy = Math.round(m.hy * 1000);
    // Quantized copies at a bin edge use the same bucket; compare every identity component.
    const bx = Math.floor(qx / (BIN * 1000)),
      by = Math.floor(qy / (BIN * 1000));
    let row = this.bins.get(bx);
    if (!row) this.bins.set(bx, (row = new Map<number, TrafficBody[]>()));
    let bin = row.get(by);
    if (!bin) row.set(by, (bin = []));
    for (const b of bin)
      if (b.qx === qx && b.qy === qy && b.qhx === qhx && b.qhy === qhy && b.m.vehicle === m.vehicle)
        return;
    let body = this.cache.get(m);
    if (!body)
      this.cache.set(
        m,
        (body = { m, life, x, y, hx: m.hx, hy: m.hy, length: 0, qx, qy, qhx, qhy }),
      );
    body.life = life;
    body.x = x;
    body.y = y;
    body.hx = m.hx;
    body.hy = m.hy;
    body.length = VEHICLES[m.vehicle].length * f.scale;
    body.qx = qx;
    body.qy = qy;
    body.qhx = qhx;
    body.qhy = qhy;
    this.bodies.set(m, body);
    bin.push(body);
  }
  private frame(life: TileLife, p: Movement, exit: boolean) {
    const f = this.tileFrame(life),
      a = exit ? p.exit : p.entry;
    const out = this.metric;
    out.x = f.x + (a?.x ?? p.junction.x) * f.units;
    out.y = f.y + (a?.y ?? p.junction.y) * f.units;
    out.scale = f.scale;
    out.radius = p.junction.radius * f.units;
    return out;
  }
  private nearby(x: number, y: number, hx: number, hy: number, reach: number) {
    const x2 = x + hx * reach,
      y2 = y + hy * reach;
    this.candidates.clear();
    for (
      let by = Math.floor((Math.min(y, y2) - 12) / BIN);
      by <= Math.floor((Math.max(y, y2) + 12) / BIN);
      by++
    )
      for (
        let bx = Math.floor((Math.min(x, x2) - 12) / BIN);
        bx <= Math.floor((Math.max(x, x2) + 12) / BIN);
        bx++
      ) {
        const bin = this.bins.get(bx)?.get(by);
        if (bin) for (const b of bin) this.candidates.add(b);
      }
    return this.candidates;
  }
  private inExit(b: TrafficBody, p: Movement, f: ReturnType<JunctionTraffic['frame']>) {
    const dx = b.x - f.x,
      dy = b.y - f.y;
    return (
      dx * p.outHx + dy * p.outHy >= 0 &&
      Math.abs(dx * p.outHy - dy * p.outHx) < 4 * f.scale &&
      b.hx * p.outHx + b.hy * p.outHy > COS20
    );
  }
  occupiesExit(m: Mover, p: Movement, life: TileLife): boolean {
    const b = this.bodies.get(m);
    return !!b && this.inExit(b, p, this.frame(life, p, true));
  }
  room(m: Mover, p: Movement, life: TileLife): number {
    const f = this.frame(life, p, true);
    let room = Infinity;
    for (const b of this.nearby(f.x, f.y, p.outHx, p.outHy, f.radius + 60 * f.scale)) {
      if (b.m === m || !this.inExit(b, p, f)) continue;
      const past = (b.x - f.x) * p.outHx + (b.y - f.y) * p.outHy;
      room = Math.min(room, (past - b.length / 2 - f.radius) / f.scale);
    }
    return room;
  }
  atLine(m: Mover, p: Movement, life: TileLife, table: JunctionTable): boolean {
    if (p.ahead / life.perMeter > JUNCTION.atLine) return false;
    const f = this.frame(life, p, false),
      transform = this.tileFrame(life);
    const mx = transform.x + m.x * transform.units,
      my = transform.y + m.y * transform.units;
    const toLine = (f.x - mx) * p.inHx + (f.y - my) * p.inHy;
    for (const b of this.nearby(f.x, f.y, -p.inHx, -p.inHy, 60 * f.scale)) {
      if (b.m === m || table.granted(b.m, p.key) || b.hx * p.inHx + b.hy * p.inHy <= COS20)
        continue;
      const ahead = (b.x - mx) * p.inHx + (b.y - my) * p.inHy;
      if (
        ahead > 1e-6 &&
        ahead < toLine &&
        Math.abs((b.x - f.x) * p.inHy - (b.y - f.y) * p.inHx) < 4 * f.scale
      )
        return false;
    }
    return true;
  }
}
