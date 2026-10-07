import {
  decodeEmergency,
  localMetricProjection,
  type EmergencyData,
  type EmergencyNetwork,
  type EmergencyPoint,
  type EmergencyTarget,
} from '@atlas/shared';

export type EmergencyPosition = Readonly<{ edge: number; t: number; dir: 1 | -1 }>;
export type EmergencyLeg = Readonly<{ edge: number; dir: 1 | -1; fromT: number; toT: number }>;
type Arc = { edge: number; dir: 1 | -1; from: number; to: number; length: number; bearing: number };
type Tree = { distance: Float64Array; winner: Int32Array; approach: Int8Array; next: Int32Array };
type Route = {
  cost: number;
  target: EmergencyTarget;
  approach: 1 | -1;
  arc: number;
  terminal: boolean;
};
type Segment = {
  edge: number;
  ax: number;
  ay: number;
  dx: number;
  dy: number;
  length: number;
  along: number;
  total: number;
};
const angleDifference = (a: number, b: number) =>
  Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
const before = (a: string, b: string) => a < b;
const tolerance = 3;

class Heap {
  private values: { node: number; cost: number }[] = [];
  push(node: number, cost: number) {
    const value = { node, cost },
      a = this.values;
    let i = a.length;
    a.push(value);
    while (i) {
      const parent = (i - 1) >> 1,
        p = a[parent]!;
      if (p.cost < cost || (p.cost === cost && p.node <= node)) break;
      a[i] = p;
      i = parent;
    }
    a[i] = value;
  }
  pop() {
    const a = this.values,
      result = a[0],
      last = a.pop();
    if (!a.length || !last) return result;
    let i = 0;
    while (i * 2 + 1 < a.length) {
      let child = i * 2 + 1;
      const right = child + 1;
      if (
        right < a.length &&
        (a[right]!.cost < a[child]!.cost ||
          (a[right]!.cost === a[child]!.cost && a[right]!.node < a[child]!.node))
      )
        child = right;
      const v = a[child]!;
      if (last.cost < v.cost || (last.cost === v.cost && last.node <= v.node)) break;
      a[i] = v;
      i = child;
    }
    a[i] = last;
    return result;
  }
}

/** Citywide directed routing; weighted terminals stop at the actual roadside destination. */
export class EmergencyRouter {
  readonly network: EmergencyNetwork;
  readonly targets: ReadonlyMap<string, EmergencyTarget>;
  readonly offsets: Uint32Array;
  readonly adjacency: Uint32Array;
  private readonly reverseOffsets: Uint32Array;
  private readonly reverse: Uint32Array;
  private readonly arcs: Arc[] = [];
  private readonly trees = new Map<string, Tree>();
  private readonly nodes = new Map<string, number[]>();
  private readonly segments = new Map<string, Segment[]>();
  private readonly projection: ReturnType<typeof localMetricProjection>;
  private readonly xy: EmergencyPoint[];

  constructor(data: EmergencyData) {
    this.network = decodeEmergency(data);
    this.targets = new Map(this.network.targets.map((t) => [t.id, t]));
    this.projection = localMetricProjection(this.network.nodes[0] ?? [0, 0]);
    this.xy = this.network.nodes.map((point) => this.metric(point));
    this.xy.forEach(([x, y], i) => {
      const key = `${Math.floor(x / tolerance)}/${Math.floor(y / tolerance)}`;
      const bin = this.nodes.get(key) ?? [];
      bin.push(i);
      this.nodes.set(key, bin);
    });
    this.network.edges.forEach((edge, index) => {
      if (edge.oneway >= 0)
        this.arcs.push({
          edge: index,
          dir: 1,
          from: edge.from,
          to: edge.to,
          length: edge.length,
          bearing: edge.bearing[0],
        });
      if (edge.oneway <= 0)
        this.arcs.push({
          edge: index,
          dir: -1,
          from: edge.to,
          to: edge.from,
          length: edge.length,
          bearing: edge.bearing[1] + Math.PI,
        });
      const points = edge.shape.map((point) => this.metric(point));
      const lengths = points
        .slice(1)
        .map((p, i) => Math.hypot(p[0] - points[i]![0], p[1] - points[i]![1]));
      const total = lengths.reduce((a, b) => a + b, 0);
      let along = 0;
      for (let i = 1; i < points.length; i++) {
        const [ax, ay] = points[i - 1]!,
          [bx, by] = points[i]!,
          length = lengths[i - 1]!;
        if (!length) continue;
        const segment: Segment = {
          edge: index,
          ax,
          ay,
          dx: bx - ax,
          dy: by - ay,
          length,
          along,
          total,
        };
        for (
          let x = Math.floor(Math.min(ax, bx) / 100);
          x <= Math.floor(Math.max(ax, bx) / 100);
          x++
        )
          for (
            let y = Math.floor(Math.min(ay, by) / 100);
            y <= Math.floor(Math.max(ay, by) / 100);
            y++
          ) {
            const key = `${x}/${y}`,
              bin = this.segments.get(key) ?? [];
            bin.push(segment);
            this.segments.set(key, bin);
          }
        along += length;
      }
    });
    const csr = (reverse: boolean) => {
      const offsets = new Uint32Array(this.xy.length + 1);
      for (const arc of this.arcs) offsets[(reverse ? arc.to : arc.from) + 1]!++;
      for (let i = 1; i < offsets.length; i++) offsets[i]! += offsets[i - 1]!;
      const values = new Uint32Array(this.arcs.length),
        cursors = offsets.slice();
      this.arcs.forEach((arc, i) => {
        values[cursors[reverse ? arc.to : arc.from]!] = i;
        cursors[reverse ? arc.to : arc.from]!++;
      });
      return { offsets, values };
    };
    const forward = csr(false),
      reverse = csr(true);
    this.offsets = forward.offsets;
    this.adjacency = forward.values;
    this.reverseOffsets = reverse.offsets;
    this.reverse = reverse.values;
  }

  private metric(point: readonly [number, number]): EmergencyPoint {
    const [x, north] = this.projection.to(point);
    return [x, -north];
  }
  nodeAt(point: readonly [number, number]): number | undefined {
    const [x, y] = this.metric(point),
      cx = Math.floor(x / tolerance),
      cy = Math.floor(y / tolerance);
    let best = tolerance * tolerance + 1e-9,
      found: number | undefined;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const index of this.nodes.get(`${cx + dx}/${cy + dy}`) ?? []) {
          const p = this.xy[index]!,
            d = (x - p[0]) ** 2 + (y - p[1]) ** 2;
          if (d < best || (d === best && index < (found ?? Infinity))) {
            best = d;
            found = index;
          }
        }
    return found;
  }
  private selected(key: string) {
    return key === 'hospital'
      ? this.network.targets.filter((t) => t.kind === 'hospital')
      : [this.targets.get(key)].filter((t): t is EmergencyTarget => !!t);
  }
  private tree(key: string): Tree {
    const saved = this.trees.get(key);
    if (saved) return saved;
    const size = this.xy.length,
      tree: Tree = {
        distance: new Float64Array(size).fill(Infinity),
        winner: new Int32Array(size).fill(-1),
        approach: new Int8Array(size),
        next: new Int32Array(size).fill(-1),
      };
    const heap = new Heap(),
      targets = this.network.targets;
    const put = (
      node: number,
      distance: number,
      winner: number,
      approach: 1 | -1,
      next: number,
    ) => {
      const old = tree.winner[node]!;
      if (
        distance > tree.distance[node]! ||
        (distance === tree.distance[node]! &&
          old >= 0 &&
          !before(targets[winner]!.id, targets[old]!.id))
      )
        return;
      tree.distance[node] = distance;
      tree.winner[node] = winner;
      tree.approach[node] = approach;
      tree.next[node] = next;
      heap.push(node, distance);
    };
    for (const target of this.selected(key)) {
      const winner = targets.indexOf(target);
      for (let i = 0; i < this.arcs.length; i++) {
        const arc = this.arcs[i]!;
        if (arc.edge === target.edge)
          put(arc.from, arc.length * (arc.dir === 1 ? target.t : 1 - target.t), winner, arc.dir, i);
      }
    }
    for (let item = heap.pop(); item; item = heap.pop()) {
      const { node, cost } = item;
      if (cost !== tree.distance[node]) continue;
      for (let i = this.reverseOffsets[node]!; i < this.reverseOffsets[node + 1]!; i++) {
        const arcIndex = this.reverse[i]!,
          arc = this.arcs[arcIndex]!;
        put(
          arc.from,
          cost + arc.length,
          tree.winner[node]!,
          tree.approach[node]! as 1 | -1,
          arcIndex,
        );
      }
    }
    this.trees.set(key, tree);
    return tree;
  }
  private route(arcIndex: number, t: number, key: string): Route | undefined {
    const arc = this.arcs[arcIndex]!,
      tree = this.tree(key),
      winner = tree.winner[arc.to]!;
    let best: Route | undefined =
      winner < 0
        ? undefined
        : {
            cost: arc.length * (arc.dir === 1 ? 1 - t : t) + tree.distance[arc.to]!,
            target: this.network.targets[winner]!,
            approach: tree.approach[arc.to]! as 1 | -1,
            arc: arcIndex,
            terminal: false,
          };
    for (const target of this.selected(key)) {
      if (target.edge !== arc.edge || (target.t - t) * arc.dir < -1e-8) continue;
      const cost = Math.abs(target.t - t) * arc.length;
      if (!best || cost < best.cost || (cost === best.cost && before(target.id, best.target.id)))
        best = { cost, target, approach: arc.dir, arc: arcIndex, terminal: true };
    }
    return best && Number.isFinite(best.cost) ? best : undefined;
  }

  /** Geographic cursors also resolve partial contracted edges with no loaded graph node. */
  positions(
    point: readonly [number, number],
    heading?: readonly [number, number],
  ): EmergencyPosition[] {
    const [x, y] = this.metric(point),
      candidates = new Set<Segment>();
    for (let cx = Math.floor((x - tolerance) / 100); cx <= Math.floor((x + tolerance) / 100); cx++)
      for (
        let cy = Math.floor((y - tolerance) / 100);
        cy <= Math.floor((y + tolerance) / 100);
        cy++
      )
        for (const segment of this.segments.get(`${cx}/${cy}`) ?? []) candidates.add(segment);
    const matches: { position: EmergencyPosition; distance: number }[] = [];
    for (const segment of candidates) {
      const u = Math.max(
        0,
        Math.min(
          1,
          ((x - segment.ax) * segment.dx + (y - segment.ay) * segment.dy) / segment.length ** 2,
        ),
      );
      const distance = Math.hypot(x - segment.ax - u * segment.dx, y - segment.ay - u * segment.dy);
      if (distance > tolerance + 1e-8) continue;
      const edge = this.network.edges[segment.edge]!,
        t = (segment.along + u * segment.length) / segment.total;
      for (const dir of [1, -1] as const) {
        if (
          (edge.oneway && edge.oneway !== dir) ||
          (heading &&
            angleDifference(
              Math.atan2(heading[1], heading[0]),
              Math.atan2(segment.dy * dir, segment.dx * dir),
            ) >
              Math.PI / 6)
        )
          continue;
        matches.push({ position: { edge: segment.edge, t, dir }, distance });
      }
    }
    matches.sort(
      (a, b) =>
        a.distance - b.distance ||
        a.position.edge - b.position.edge ||
        b.position.dir - a.position.dir,
    );
    return matches.map((m) => m.position);
  }
  resolve(position: EmergencyPosition, key: string): Route | undefined {
    const index = this.arcs.findIndex(
      (arc) => arc.edge === position.edge && arc.dir === position.dir,
    );
    return index < 0 ? undefined : this.route(index, position.t, key);
  }
  routeAt(point: readonly [number, number], key: string, heading?: readonly [number, number]) {
    let best: (Route & { position: EmergencyPosition }) | undefined;
    for (const position of this.positions(point, heading)) {
      const route = this.resolve(position, key);
      if (
        route &&
        (!best ||
          route.cost < best.cost ||
          (route.cost === best.cost && before(route.target.id, best.target.id)))
      )
        best = { ...route, position };
    }
    return best;
  }
  scoreExits<T>(
    point: readonly [number, number],
    options: readonly T[],
    heading: (option: T) => readonly [number, number],
    key: string,
  ): { option: T; target: EmergencyTarget; approach: 1 | -1; cost: number } | undefined {
    const node = this.nodeAt(point);
    if (node === undefined) return;
    let best:
      | { option: T; target: EmergencyTarget; approach: 1 | -1; cost: number; ordinal: number }
      | undefined;
    options.forEach((option, ordinal) => {
      const h = heading(option),
        angle = Math.atan2(h[1], h[0]);
      let match: number | undefined,
        error = Math.PI / 6 + 1e-9;
      for (let i = this.offsets[node]!; i < this.offsets[node + 1]!; i++) {
        const index = this.adjacency[i]!,
          arc = this.arcs[index]!,
          difference = angleDifference(angle, arc.bearing);
        if (difference < error || (difference === error && index < (match ?? Infinity))) {
          error = difference;
          match = index;
        }
      }
      if (match === undefined) return;
      const arc = this.arcs[match]!,
        route = this.route(match, arc.dir === 1 ? 0 : 1, key);
      if (
        route &&
        (!best ||
          route.cost < best.cost ||
          (route.cost === best.cost &&
            (before(route.target.id, best.target.id) ||
              (route.target.id === best.target.id && ordinal < best.ordinal))))
      )
        best = {
          option,
          target: route.target,
          approach: route.approach,
          cost: route.cost,
          ordinal,
        };
    });
    return best;
  }

  path(point: readonly [number, number], key: string): EmergencyLeg[] {
    const start = this.routeAt(point, key);
    if (!start) return [];
    const tree = this.tree(start.target.id),
      legs: EmergencyLeg[] = [];
    let arcIndex = start.arc,
      fromT = start.position.t;
    const visited = new Set<string>();
    while (arcIndex >= 0 && !visited.has(`${arcIndex}/${fromT}`)) {
      visited.add(`${arcIndex}/${fromT}`);
      const arc = this.arcs[arcIndex]!,
        route = this.route(arcIndex, fromT, start.target.id);
      if (!route) return [];
      legs.push({
        edge: arc.edge,
        dir: arc.dir,
        fromT,
        toT: route.terminal ? route.target.t : arc.dir === 1 ? 1 : 0,
      });
      if (route.terminal) return legs;
      arcIndex = tree.next[arc.to]!;
      fromT = arcIndex < 0 || this.arcs[arcIndex]!.dir === 1 ? 0 : 1;
    }
    return [];
  }
}
