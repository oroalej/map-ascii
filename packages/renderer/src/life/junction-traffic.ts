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
};
const BIN = 32,
  COS20 = Math.cos(Math.PI / 9);
/** One ownership-filtered, deduplicated metric traffic index for the entire arbitration step. */
export class JunctionTraffic {
  private reference?: TileLife;
  private readonly bins = new Map<string, TrafficBody[]>();
  private readonly bodies = new Map<Mover, TrafficBody>();
  private readonly identities = new Set<string>();
  private readonly candidates = new Set<TrafficBody>();
  private readonly cache = new WeakMap<Mover, TrafficBody>();
  private readonly metric = { x: 0, y: 0, scale: 1, radius: 0 };
  begin(reference: TileLife) {
    this.reference = reference;
    for (const bin of this.bins.values()) bin.length = 0;
    this.bodies.clear();
    this.identities.clear();
  }
  add(life: TileLife, m: Mover) {
    if (m.kind !== 'vehicle' || !m.vehicle) return;
    const ref = this.reference!,
      f = frameBetween(life.tile, ref.tile),
      scale = (life.perMeter * f.scale) / ref.perMeter;
    const x = (f.x + m.x * f.scale) / ref.perMeter,
      y = (f.y + m.y * f.scale) / ref.perMeter;
    const identity = `${Math.round(x * 1000)}/${Math.round(y * 1000)}/${m.vehicle}/${Math.round(m.hx * 1000)}/${Math.round(m.hy * 1000)}`;
    if (this.identities.has(identity)) return;
    this.identities.add(identity);
    let body = this.cache.get(m);
    if (!body) this.cache.set(m, (body = { m, life, x, y, hx: m.hx, hy: m.hy, length: 0 }));
    Object.assign(body, {
      life,
      x,
      y,
      hx: m.hx,
      hy: m.hy,
      length: VEHICLES[m.vehicle].length * scale,
    });
    this.bodies.set(m, body);
    const key = `${Math.floor(x / BIN)}/${Math.floor(y / BIN)}`;
    let bin = this.bins.get(key);
    if (!bin) this.bins.set(key, (bin = []));
    bin.push(body);
  }
  private frame(life: TileLife, p: Movement, exit: boolean) {
    const ref = this.reference!,
      f = frameBetween(life.tile, ref.tile),
      a = exit ? p.exit : p.entry;
    const out = this.metric;
    out.x = (f.x + (a?.x ?? p.junction.x) * f.scale) / ref.perMeter;
    out.y = (f.y + (a?.y ?? p.junction.y) * f.scale) / ref.perMeter;
    out.scale = (life.perMeter * f.scale) / ref.perMeter;
    out.radius = (p.junction.radius * f.scale) / ref.perMeter;
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
      )
        for (const b of this.bins.get(`${bx}/${by}`) ?? []) this.candidates.add(b);
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
      ref = this.reference!,
      transform = frameBetween(life.tile, ref.tile);
    const mx = (transform.x + m.x * transform.scale) / ref.perMeter,
      my = (transform.y + m.y * transform.scale) / ref.perMeter;
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
