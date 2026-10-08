import {
  decodeEmergency,
  encodeEmergency,
  type EmergencyNetwork,
  type EmergencyPoint,
} from '@atlas/shared';
import { geometryOutsideVoid, inTerritory, type Territory } from './territory';

const admittedPath = (shape: EmergencyPoint[], territory: Territory) =>
  shape.every(([lng, lat]) => inTerritory(lng, lat, territory)) &&
  geometryOutsideVoid({ type: 'LineString', coordinates: shape }, territory);
const distance2 = (a: EmergencyPoint, b: EmergencyPoint) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;

/** Nearest codec lattice choices; never loosen territorial admission to accommodate rounding. */
function candidates(
  point: EmergencyPoint,
  origin: EmergencyPoint,
  scale: number,
  territory: Territory,
): EmergencyPoint[] {
  const x = Math.round((point[0] - origin[0]) * scale),
    y = Math.round((point[1] - origin[1]) * scale);
  const points: EmergencyPoint[] = [];
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++) {
      const p: EmergencyPoint = [origin[0] + (x + dx) / scale, origin[1] + (y + dy) / scale];
      if (inTerritory(...p, territory)) points.push(p);
    }
  return points.sort(
    (a, b) => distance2(a, point) - distance2(b, point) || a[0] - b[0] || a[1] - b[1],
  );
}

function encodedShape(
  shape: EmergencyPoint[],
  start: EmergencyPoint,
  end: EmergencyPoint,
  origin: EmergencyPoint,
  territory: Territory,
): EmergencyPoint[] {
  const choices = shape.map((p, i) =>
    i === 0 ? [start] : i === shape.length - 1 ? [end] : candidates(p, origin, 1e5, territory),
  );
  const nearest = choices.map((ps) => ps[0]!);
  if (choices.some((ps) => !ps.length))
    throw new Error('emergency shape has no admitted encoded coordinate');
  if (admittedPath(nearest, territory)) return nearest;
  const costs: number[][] = [[0]],
    parents: number[][] = [[-1]];
  for (let i = 1; i < choices.length; i++) {
    costs[i] = choices[i]!.map(() => Infinity);
    parents[i] = choices[i]!.map(() => -1);
    for (let j = 0; j < choices[i]!.length; j++)
      for (let k = 0; k < choices[i - 1]!.length; k++) {
        const prior = costs[i - 1]![k]!;
        if (
          !Number.isFinite(prior) ||
          !admittedPath([choices[i - 1]![k]!, choices[i]![j]!], territory)
        )
          continue;
        const cost = prior + distance2(choices[i]![j]!, shape[i]!);
        if (cost < costs[i]![j]!) {
          costs[i]![j] = cost;
          parents[i]![j] = k;
        }
      }
  }
  if (!Number.isFinite(costs.at(-1)![0]!))
    throw new Error('emergency edge cannot be encoded inside territory');
  const result: EmergencyPoint[] = [];
  let index = 0;
  for (let i = choices.length - 1; i >= 0; i--) {
    result.push(choices[i]![index]!);
    index = parents[i]![index]!;
  }
  return result.reverse();
}

/** Preserve graph references and mandatory targets, then validate the actual decoded output. */
export function encodeEmergencyInTerritory(network: EmergencyNetwork, territory: Territory) {
  if (!territory.territory) return encodeEmergency(network);
  const origin = network.nodes[0]!;
  if (!origin || !inTerritory(...origin, territory))
    throw new Error('emergency origin leaves territory');
  const neighbours = network.nodes.map(() => [] as EmergencyPoint[]);
  for (const edge of network.edges) {
    neighbours[edge.from]!.push(edge.shape[1]!);
    neighbours[edge.to]!.push(edge.shape.at(-2)!);
  }
  const nodes = network.nodes.map((p, i): EmergencyPoint => {
    if (!i) return [...origin]; // This exact coordinate anchors both codec lattices.
    const point = candidates(p, origin, 1e5, territory).find((q) =>
      neighbours[i]!.every((next) => admittedPath([q, next], territory)),
    );
    if (!point) throw new Error('emergency node has no admitted encoded coordinate');
    return point;
  });
  const edges = network.edges.map((e) => ({
    ...e,
    shape: encodedShape(e.shape, nodes[e.from]!, nodes[e.to]!, origin, territory),
  }));
  const targets = network.targets.map((target) => {
    const at = candidates(target.at, origin, 1e6, territory)[0];
    if (!at) throw new Error('emergency target has no admitted encoded coordinate');
    return { ...target, at };
  });
  const data = encodeEmergency({ ...network, nodes, edges, targets });
  const decoded = decodeEmergency(data);
  if (
    !decoded.nodes.every((p) => inTerritory(...p, territory)) ||
    !decoded.edges.every((e) => admittedPath(e.shape, territory)) ||
    !decoded.targets.every((t) => inTerritory(...t.at, territory))
  )
    throw new Error('encoded emergency geometry leaves territory');
  return data;
}
