import type { EmergencyNetwork, EmergencyTarget } from '@atlas/shared';
type Arc = { node: number; edge: number };
class Heap {
  private entries: Array<{ node: number; cost: number }> = [];
  push(node: number, cost: number) {
    const value = { node, cost };
    let i = this.entries.length;
    this.entries.push(value);
    while (i) {
      const parent = (i - 1) >> 1,
        p = this.entries[parent]!;
      if (p.cost < cost || (p.cost === cost && p.node <= node)) break;
      this.entries[i] = p;
      i = parent;
    }
    this.entries[i] = value;
  }
  pop() {
    const first = this.entries[0],
      last = this.entries.pop();
    if (!this.entries.length || !last) return first;
    let i = 0;
    while (i * 2 + 1 < this.entries.length) {
      let child = i * 2 + 1;
      const right = child + 1;
      if (
        right < this.entries.length &&
        (this.entries[right]!.cost < this.entries[child]!.cost ||
          (this.entries[right]!.cost === this.entries[child]!.cost &&
            this.entries[right]!.node < this.entries[child]!.node))
      )
        child = right;
      const p = this.entries[child]!;
      if (last.cost < p.cost || (last.cost === p.cost && last.node <= p.node)) break;
      this.entries[i] = p;
      i = child;
    }
    this.entries[i] = last;
    return first;
  }
}
/** Retain exact shortest directed dispatch paths, including weighted interior terminals. */
export function dispatchNetwork(
  network: EmergencyNetwork,
  targets: readonly EmergencyTarget[],
): EmergencyNetwork {
  const forward = network.nodes.map(() => [] as Arc[]),
    reverse = network.nodes.map(() => [] as Arc[]);
  network.edges.forEach((e, i) => {
    const add = (from: number, to: number) => {
      forward[from]!.push({ node: to, edge: i });
      reverse[to]!.push({ node: from, edge: i });
    };
    if (e.oneway >= 0) add(e.from, e.to);
    if (e.oneway <= 0) add(e.to, e.from);
  });
  const keep = new Set(targets.map((t) => t.edge));
  const services = targets.filter((t) => t.kind !== 'building');
  if (!services.length) return { ...network, targets: [...targets] };
  for (const station of services)
    for (const outgoing of [true, false]) {
      const distances = new Float64Array(network.nodes.length).fill(Infinity),
        parents = new Int32Array(network.nodes.length).fill(-1),
        edges = new Int32Array(network.nodes.length).fill(-1),
        heap = new Heap();
      const e = network.edges[station.edge]!;
      const seed = (node: number, cost: number) => {
        if (cost < distances[node]!) {
          distances[node] = cost;
          heap.push(node, cost);
        }
      };
      if (e.oneway >= 0)
        seed(outgoing ? e.to : e.from, e.length * (outgoing ? 1 - station.t : station.t));
      if (e.oneway <= 0)
        seed(outgoing ? e.from : e.to, e.length * (outgoing ? station.t : 1 - station.t));
      const adjacent = outgoing ? forward : reverse;
      for (let item = heap.pop(); item; item = heap.pop()) {
        if (item.cost !== distances[item.node]) continue;
        for (const arc of adjacent[item.node]!) {
          const cost = item.cost + network.edges[arc.edge]!.length;
          if (cost >= distances[arc.node]!) continue;
          distances[arc.node] = cost;
          parents[arc.node] = item.node;
          edges[arc.node] = arc.edge;
          heap.push(arc.node, cost);
        }
      }
      // Keep the codec's existing origin connected in both directions; retaining
      // it also preserves the admitted coordinate lattice after reindexing.
      if (station === services[0]) {
        let node = 0;
        if (!Number.isFinite(distances[node])) throw new Error('Disconnected emergency origin');
        while (edges[node]! >= 0) {
          keep.add(edges[node]!);
          node = parents[node]!;
        }
      }
      for (const target of targets) {
        if (target.id === station.id) continue;
        const edge = network.edges[target.edge]!;
        let node = -1,
          cost = Infinity;
        const choose = (at: number, offset: number) => {
          const next = distances[at]! + offset;
          if (next < cost) {
            node = at;
            cost = next;
          }
        };
        if (edge.oneway >= 0)
          choose(
            outgoing ? edge.from : edge.to,
            edge.length * (outgoing ? target.t : 1 - target.t),
          );
        if (edge.oneway <= 0)
          choose(
            outgoing ? edge.to : edge.from,
            edge.length * (outgoing ? 1 - target.t : target.t),
          );
        if (target.edge === station.edge) {
          const delta = outgoing ? target.t - station.t : station.t - target.t;
          if (
            ((delta >= 0 && edge.oneway >= 0) || (delta <= 0 && edge.oneway <= 0)) &&
            Math.abs(delta) * edge.length <= cost
          )
            continue;
        }
        if (!Number.isFinite(cost))
          throw new Error(`No directed dispatch path for ${station.id} and ${target.id}`);
        while (edges[node]! >= 0) {
          keep.add(edges[node]!);
          node = parents[node]!;
        }
      }
    }
  // Ambulances may start on any retained edge: keep a shortest hospital route
  // from both endpoints, including endpoints newly introduced by these paths.
  const distances = new Float64Array(network.nodes.length).fill(Infinity),
    parents = new Int32Array(network.nodes.length).fill(-1),
    nearestEdges = new Int32Array(network.nodes.length).fill(-1),
    heap = new Heap();
  const seed = (node: number, cost: number) => {
    if (cost < distances[node]!) {
      distances[node] = cost;
      heap.push(node, cost);
    }
  };
  for (const target of targets.filter((t) => t.kind === 'hospital')) {
    const edge = network.edges[target.edge]!;
    if (edge.oneway >= 0) seed(edge.from, edge.length * target.t);
    if (edge.oneway <= 0) seed(edge.to, edge.length * (1 - target.t));
  }
  for (let item = heap.pop(); item; item = heap.pop()) {
    if (item.cost !== distances[item.node]) continue;
    for (const arc of reverse[item.node]!) {
      const cost = item.cost + network.edges[arc.edge]!.length;
      if (cost >= distances[arc.node]!) continue;
      distances[arc.node] = cost;
      parents[arc.node] = item.node;
      nearestEdges[arc.node] = arc.edge;
      heap.push(arc.node, cost);
    }
  }
  const visited = new Set<number>();
  for (const edgeIndex of keep)
    for (let node of [network.edges[edgeIndex]!.from, network.edges[edgeIndex]!.to]) {
      while (!visited.has(node) && nearestEdges[node]! >= 0) {
        visited.add(node);
        keep.add(nearestEdges[node]!);
        node = parents[node]!;
      }
    }
  const oldEdges = [...keep].sort((a, b) => a - b),
    oldNodes = [
      ...new Set([0, ...oldEdges.flatMap((i) => [network.edges[i]!.from, network.edges[i]!.to])]),
    ].sort((a, b) => a - b);
  const nodeMap = new Map(oldNodes.map((v, i) => [v, i])),
    edgeMap = new Map(oldEdges.map((v, i) => [v, i]));
  return {
    ...network,
    nodes: oldNodes.map((i) => network.nodes[i]!),
    edges: oldEdges.map((i) => ({
      ...network.edges[i]!,
      from: nodeMap.get(network.edges[i]!.from)!,
      to: nodeMap.get(network.edges[i]!.to)!,
    })),
    targets: targets.map((t) => ({ ...t, edge: edgeMap.get(t.edge)! })),
  };
}
