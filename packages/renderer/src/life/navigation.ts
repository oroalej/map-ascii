import { usableLines } from './config';
import type { LifeGeometry, LifeLine } from './geometry';
import { boundsOf, pointInside, PolygonIndex, type Body } from './occupancy';
import { prepareRoadTerrain, type RoadAccess } from './terrain';

export type WalkPoint = { x: number; y: number };
type Edge = { a: number; b: number; length: number };
type Obstacle = { points: WalkPoint[]; closed: boolean; bounds: number[] };
const distance = (a: WalkPoint, b: WalkPoint) => Math.hypot(a.x - b.x, a.y - b.y);
const cross = (a: WalkPoint, b: WalkPoint, c: WalkPoint) =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);

function intersects(a: WalkPoint, b: WalkPoint, c: WalkPoint, d: WalkPoint): boolean {
  if (
    Math.max(a.x, b.x) < Math.min(c.x, d.x) ||
    Math.max(c.x, d.x) < Math.min(a.x, b.x) ||
    Math.max(a.y, b.y) < Math.min(c.y, d.y) ||
    Math.max(c.y, d.y) < Math.min(a.y, b.y)
  )
    return false;
  return cross(a, b, c) * cross(a, b, d) <= 0 && cross(c, d, a) * cross(c, d, b) <= 0;
}

const inside = (p: WalkPoint, ring: readonly WalkPoint[]) => pointInside(p, [ring]);

/** A small tile-local graph. Unsafe connectors and unreachable sites are rejected. */
export class WalkingGraph {
  readonly points: WalkPoint[] = [];
  private readonly edges: Edge[] = [];
  private readonly adjacent: { to: number; length: number }[][] = [];
  private readonly obstacles: Obstacle[] = [];
  private readonly obstacleBins = new Map<string, number[]>();
  private readonly edgeBins = new Map<string, number[]>();
  private readonly bin: number;
  private readonly roadAccess: RoadAccess;

  constructor(
    geo: LifeGeometry,
    readonly perMeter: number,
  ) {
    this.bin = 20 * perMeter;
    const crossings = (geo.areas ?? []).filter((a) => a.kind === 'crossing').map((a) => a.rings);
    this.roadAccess = prepareRoadTerrain(geo, perMeter).access;
    const crossingReach = new PolygonIndex();
    for (const polygon of crossings) crossingReach.add(polygon);
    for (let i = 0; i < geo.obstacleClosed.length; i++) {
      const points: WalkPoint[] = [];
      for (let v = geo.obstacleStarts[i]!; v < geo.obstacleStarts[i + 1]!; v++)
        points.push({ x: geo.obstacles[v * 2]!, y: geo.obstacles[v * 2 + 1]! });
      if (points.length < 2) continue;
      const bounds = boundsOf(points);
      const index = this.obstacles.length;
      this.obstacles.push({ points, bounds, closed: geo.obstacleClosed[i] === 1 });
      this.index(this.obstacleBins, bounds, index);
    }
    const nodes = new Map<string, number>();
    const node = (p: WalkPoint) => {
      const key = `${Math.round(p.x)},${Math.round(p.y)}`;
      let id = nodes.get(key);
      if (id === undefined) {
        id = this.points.length;
        nodes.set(key, id);
        this.points.push(p);
        this.adjacent.push([]);
      }
      return id;
    };
    const connected = new Set<string>();
    const edge = (a: WalkPoint, b: WalkPoint) => {
      if (this.points.length >= 4096 || distance(a, b) < 0.01 || !this.clear(a, b)) return;
      const ai = node(a);
      const bi = node(b);
      const pair = `${Math.min(ai, bi)},${Math.max(ai, bi)}`;
      if (ai === bi || connected.has(pair)) return;
      connected.add(pair);
      const length = distance(a, b);
      const index = this.edges.length;
      this.edges.push({ a: ai, b: bi, length });
      this.adjacent[ai]!.push({ to: bi, length });
      this.adjacent[bi]!.push({ to: ai, length });
      this.index(
        this.edgeBins,
        [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)],
        index,
      );
    };
    for (let l = 0; l < geo.kinds.length; l++) {
      const kind = geo.kinds[l]! as LifeLine;
      // Only mapped walking lines and plaza routes, including decoded mapped sidewalks.
      if (!usableLines.person.includes(kind)) continue;
      for (let v = geo.starts[l]!; v < geo.starts[l + 1]! - 1; v++) {
        const a = { x: geo.coords[v * 2]!, y: geo.coords[v * 2 + 1]! };
        const b = { x: geo.coords[v * 2 + 2]!, y: geo.coords[v * 2 + 3]! };
        edge(a, b);
      }
    }
    // A mapped crossing can meet the middle of a long sidewalk segment. Attach its end to
    // that segment, rather than requiring OSM to repeat the crossing anchor as a way vertex.
    const originalPoints = this.points.length;
    const reach = 3 * perMeter;
    for (let i = 0; crossings.length && i < originalPoints; i++) {
      const p = this.points[i]!;
      if (!crossingReach.hits([{ ...p, hx: 1, hy: 0, length: 2 * reach, width: 2 * reach }]))
        continue;
      for (const index of this.candidates(
        this.edgeBins,
        { x: p.x - reach, y: p.y - reach },
        { x: p.x + reach, y: p.y + reach },
      )) {
        const e = this.edges[index]!;
        if (e.a === i || e.b === i) continue;
        const a = this.points[e.a]!,
          b = this.points[e.b]!;
        const dx = b.x - a.x,
          dy = b.y - a.y;
        const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy);
        if (t <= 0 || t >= 1) continue;
        const q = { x: a.x + dx * t, y: a.y + dy * t };
        if (distance(p, q) > reach || !this.clear(p, q)) continue;
        edge(p, q);
        edge(a, q);
        edge(q, b);
      }
    }
    // Join nearby mapped walking ends with the same terrain check as a site connector.
    const bins = new Map<string, number[]>();
    this.points.forEach((p, i) => {
      const bx = Math.floor(p.x / this.bin);
      const by = Math.floor(p.y / this.bin);
      for (let x = bx - 1; x <= bx + 1; x++)
        for (let y = by - 1; y <= by + 1; y++) {
          for (const j of bins.get(`${x},${y}`) ?? []) {
            const q = this.points[j]!;
            const length = distance(p, q);
            if (length <= 3 * perMeter && this.clear(p, q)) {
              this.adjacent[i]!.push({ to: j, length });
              this.adjacent[j]!.push({ to: i, length });
            }
          }
        }
      this.index(bins, [p.x, p.y, p.x, p.y], i);
    });
  }

  private index(map: Map<string, number[]>, bounds: number[], value: number) {
    for (let x = Math.floor(bounds[0]! / this.bin); x <= Math.floor(bounds[2]! / this.bin); x++)
      for (let y = Math.floor(bounds[1]! / this.bin); y <= Math.floor(bounds[3]! / this.bin); y++) {
        const key = `${x},${y}`;
        const list = map.get(key) ?? [];
        list.push(value);
        map.set(key, list);
      }
  }

  private candidates(map: Map<string, number[]>, a: WalkPoint, b: WalkPoint): Set<number> {
    const out = new Set<number>();
    for (
      let x = Math.floor(Math.min(a.x, b.x) / this.bin);
      x <= Math.floor(Math.max(a.x, b.x) / this.bin);
      x++
    )
      for (
        let y = Math.floor(Math.min(a.y, b.y) / this.bin);
        y <= Math.floor(Math.max(a.y, b.y) / this.bin);
        y++
      )
        for (const i of map.get(`${x},${y}`) ?? []) out.add(i);
    return out;
  }

  clear(a: WalkPoint, b: WalkPoint): boolean {
    if (
      !this.roadAccess.clear(
        { x: a.x / this.perMeter, y: a.y / this.perMeter },
        { x: b.x / this.perMeter, y: b.y / this.perMeter },
      )
    )
      return false;
    for (const i of this.candidates(this.obstacleBins, a, b)) {
      const obstacle = this.obstacles[i]!;
      if (obstacle.closed && (inside(a, obstacle.points) || inside(b, obstacle.points)))
        return false;
      const count = obstacle.points.length - (obstacle.closed ? 0 : 1);
      for (let p = 0; p < count; p++)
        if (
          intersects(a, b, obstacle.points[p]!, obstacle.points[(p + 1) % obstacle.points.length]!)
        )
          return false;
    }
    return true;
  }

  allowsBodies(bodies: readonly Body[]): boolean {
    return this.roadAccess.allows(
      bodies.map((b) => ({
        ...b,
        x: b.x / this.perMeter,
        y: b.y / this.perMeter,
        length: b.length / this.perMeter,
        width: b.width / this.perMeter,
      })),
    );
  }

  /** Roofed sites are approached at a reachable exterior entrance, never through the roof. */
  entrance(p: WalkPoint): WalkPoint | undefined {
    if (this.clear(p, p) && this.attach(p)) return p;
    let best = 30 * this.perMeter;
    let found: WalkPoint | undefined;
    for (const i of this.candidates(this.obstacleBins, p, p)) {
      const obstacle = this.obstacles[i]!;
      if (!obstacle.closed || !inside(p, obstacle.points)) continue;
      for (let j = 0; j < obstacle.points.length; j++) {
        const a = obstacle.points[j]!;
        const b = obstacle.points[(j + 1) % obstacle.points.length]!;
        const length = distance(a, b);
        if (length < 0.001) continue;
        const t = Math.max(
          0,
          Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / length ** 2),
        );
        const x = a.x + (b.x - a.x) * t;
        const y = a.y + (b.y - a.y) * t;
        for (const sign of [-1, 1]) {
          const candidate = {
            x: x - ((b.y - a.y) / length) * this.perMeter * sign,
            y: y + ((b.x - a.x) / length) * this.perMeter * sign,
          };
          const d = distance(p, candidate);
          if (d < best && this.clear(candidate, candidate) && this.attach(candidate)) {
            best = d;
            found = candidate;
          }
        }
      }
    }
    return found;
  }

  private attach(p: WalkPoint): { point: WalkPoint; edge: Edge; t: number } | undefined {
    const reach = 8 * this.perMeter;
    let best = reach;
    let attachment: { point: WalkPoint; edge: Edge; t: number } | undefined;
    for (const i of this.candidates(
      this.edgeBins,
      { x: p.x - reach, y: p.y - reach },
      { x: p.x + reach, y: p.y + reach },
    )) {
      const edge = this.edges[i]!;
      const a = this.points[edge.a]!;
      const b = this.points[edge.b]!;
      const t = Math.max(
        0,
        Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / edge.length ** 2),
      );
      const point = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      const d = distance(p, point);
      if (d <= best && this.clear(p, point)) {
        best = d;
        attachment = { point, edge, t };
      }
    }
    return attachment;
  }

  route(from: WalkPoint, to: WalkPoint): WalkPoint[] | undefined {
    const start = this.attach(from);
    const end = this.attach(to);
    if (!start || !end) return undefined;
    if (start.edge === end.edge) return [from, start.point, end.point, to];
    // Short clear connections let a walker reach a neighboring curb without walking to
    // the ends of two long parallel edges. This uses the graph's same 3 m join limit.
    if (distance(start.point, end.point) <= 3 * this.perMeter && this.clear(start.point, end.point))
      return [from, start.point, end.point, to];
    const costs = new Float64Array(this.points.length).fill(Infinity);
    const previous = new Int32Array(this.points.length).fill(-1);
    const done = new Uint8Array(this.points.length);
    const open = new Set<number>([start.edge.a, start.edge.b]);
    costs[start.edge.a] = distance(start.point, this.points[start.edge.a]!);
    costs[start.edge.b] = distance(start.point, this.points[start.edge.b]!);
    let found = -1;
    // Local trips only; bounded searches cannot stall a frame on a sprawling graph.
    for (let visit = 0; open.size && visit < 512; visit++) {
      let current = -1;
      let best = Infinity;
      for (const i of open) {
        const score = costs[i]! + distance(this.points[i]!, end.point);
        if (score < best) {
          best = score;
          current = i;
        }
      }
      if (current < 0 || costs[current]! > 100 * this.perMeter) break;
      open.delete(current);
      done[current] = 1;
      if (current === end.edge.a || current === end.edge.b) {
        found = current;
        break;
      }
      for (const { to: next, length } of this.adjacent[current]!) {
        const cost = costs[current]! + length;
        if (!done[next] && cost < costs[next]!) {
          costs[next] = cost;
          previous[next] = current;
          open.add(next);
        }
      }
    }
    if (found < 0) return undefined;
    const middle: WalkPoint[] = [];
    for (let i = found; i >= 0; i = previous[i]!) middle.push(this.points[i]!);
    return [from, start.point, ...middle.reverse(), end.point, to];
  }
}
