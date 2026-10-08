import {
  isRoofBuilding,
  foldRoofAngle as fold,
  ROOF_PLAN_MAX_LEAVES,
  roofFrame,
  type RoofNode,
  type RoofPlan,
  type RoofPoint,
} from '@atlas/shared';
import { RoofPlanSchema } from '@atlas/shared/schemas';
import { intersection } from 'polyclip-ts';
import type { AtlasFeature } from '../03-normalize';

type Ring = RoofPoint[];
const area2 = (r: Ring) =>
  r.reduce((a, p, i) => {
    const q = r[(i + 1) % r.length]!;
    return a + p[0] * q[1] - p[1] * q[0];
  }, 0);
const area = (r: Ring) => Math.abs(area2(r)) / 2;
const round = (x: number, places = 1) => Math.round(x * 10 ** places) / 10 ** places;
const rotate = (p: RoofPoint, theta: number): RoofPoint => [
  p[0] * Math.cos(theta) - p[1] * Math.sin(theta),
  p[0] * Math.sin(theta) + p[1] * Math.cos(theta),
];
const bounds = (r: Ring) => {
  const xs = r.map((p) => p[0]),
    ys = r.map((p) => p[1]);
  const x0 = Math.min(...xs),
    x1 = Math.max(...xs),
    y0 = Math.min(...ys),
    y1 = Math.max(...ys);
  return {
    x0,
    x1,
    y0,
    y1,
    width: x1 - x0,
    height: y1 - y0,
    rectangularity: area(r) / ((x1 - x0) * (y1 - y0)),
  };
};
function clean(input: Ring): Ring {
  let r = input.filter((p, i) => i === 0 || p[0] !== input[i - 1]![0] || p[1] !== input[i - 1]![1]);
  if (r.length > 1 && r[0]![0] === r.at(-1)![0] && r[0]![1] === r.at(-1)![1]) r = r.slice(0, -1);
  if (area2(r) < 0) r.reverse();
  const first = r.reduce(
    (best, p, i) => (p[0] < r[best]![0] || (p[0] === r[best]![0] && p[1] < r[best]![1]) ? i : best),
    0,
  );
  return [...r.slice(first), ...r.slice(0, first)];
}
function simplify(input: Ring): Ring {
  const r = clean(input);
  for (let changed = true; changed && r.length > 4;) {
    changed = false;
    for (let i = 0; i < r.length; i++) {
      const a = r[(i + r.length - 1) % r.length]!,
        b = r[i]!,
        c = r[(i + 1) % r.length]!;
      const x = c[0] - a[0],
        y = c[1] - a[1],
        length = Math.hypot(x, y);
      const dot = (b[0] - a[0]) * x + (b[1] - a[1]) * y;
      if (
        length &&
        dot >= 0 &&
        dot <= length * length &&
        Math.abs(x * (b[1] - a[1]) - y * (b[0] - a[0])) / length <= 0.3
      ) {
        r.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return clean(r);
}
type Tree = {
  ring: Ring;
  leaves: number;
  score: number;
  split?: { at: RoofPoint; angle: number; negative: Tree; positive: Tree };
};

/** Conservative, deterministic partitions of a complete footprint in local east/south meters. */
export function roofPlan(input: Ring, origin: RoofPoint = [0, 0]): RoofPlan | undefined {
  const ring = simplify(input);
  if (
    ring.length < 6 ||
    ring.length > 16 ||
    !ring.every((p) => p.every(Number.isFinite)) ||
    area(ring) <= 0
  )
    return;
  const edges = ring.map((p, i) => {
    const q = ring[(i + 1) % ring.length]!;
    return {
      angle: Math.atan2(q[1] - p[1], q[0] - p[0]),
      length: Math.hypot(q[0] - p[0], q[1] - p[1]),
    };
  });
  const theta =
    fold(
      Math.atan2(
        edges.reduce((s, e) => s + e.length * Math.sin(4 * e.angle), 0),
        edges.reduce((s, e) => s + e.length * Math.cos(4 * e.angle), 0),
      ) / 4,
    ) %
    (Math.PI / 2);
  const aligned = edges.map(
    (e) =>
      Math.abs(((e.angle - theta + Math.PI * 4 + Math.PI / 4) % (Math.PI / 2)) - Math.PI / 4) <=
      Math.PI / 12,
  );
  const perimeter = edges.reduce((s, e) => s + e.length, 0);
  if (edges.reduce((s, e, i) => s + (aligned[i] ? e.length : 0), 0) < perimeter * 0.9) return;
  // Off-axis bevels may be convex, but an oblique notch cannot become an invented wing.
  for (let i = 0; i < ring.length; i++) {
    const a = ring[(i + ring.length - 1) % ring.length]!,
      b = ring[i]!,
      c = ring[(i + 1) % ring.length]!;
    if (
      (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) < -1e-7 &&
      (!aligned[i] || !aligned[(i + ring.length - 1) % ring.length])
    )
      return;
  }
  const full = ring.map((p) => rotate(p, -theta));
  if (bounds(full).rectangularity >= 0.85) return;
  const memo = new Map<string, Tree | undefined>();
  const solve = (r: Ring, budget: number): Tree | undefined => {
    const b = bounds(r);
    if (Math.min(b.width, b.height) < 3 - 1e-6) return;
    if (b.rectangularity >= 0.9) return { ring: r, leaves: 1, score: b.rectangularity };
    if (budget < 2) return;
    const key = `${budget}:${JSON.stringify(r)}`;
    if (memo.has(key)) return memo.get(key);
    const candidates: { dimension: 0 | 1; value: number }[] = [];
    for (let i = 0; i < r.length; i++) {
      const a = r[(i + r.length - 1) % r.length]!,
        p = r[i]!,
        c = r[(i + 1) % r.length]!;
      if ((p[0] - a[0]) * (c[1] - p[1]) - (p[1] - a[1]) * (c[0] - p[0]) < -1e-6)
        for (const dimension of [0, 1] as const)
          candidates.push({ dimension, value: p[dimension] });
    }
    candidates.sort((a, b) => a.dimension - b.dimension || a.value - b.value);
    let best: Tree | undefined;
    for (const { dimension, value } of candidates) {
      const box = (low: boolean): Ring[] => {
        const x0 = dimension === 0 && !low ? value : b.x0 - 1;
        const x1 = dimension === 0 && low ? value : b.x1 + 1;
        const y0 = dimension === 1 && !low ? value : b.y0 - 1;
        const y1 = dimension === 1 && low ? value : b.y1 + 1;
        return [
          [
            [x0, y0],
            [x1, y0],
            [x1, y1],
            [x0, y1],
            [x0, y0],
          ],
        ];
      };
      const low = intersection([r], box(true)),
        high = intersection([r], box(false));
      if (low.length !== 1 || high.length !== 1 || low[0]!.length !== 1 || high[0]!.length !== 1)
        continue;
      const left = clean(low[0]![0]!),
        right = clean(high[0]![0]!);
      if (Math.abs(area(left) + area(right) - area(r)) > area(r) * 0.000001) continue;
      for (let n = 1; n < budget; n++) {
        const l = solve(left, n),
          h = solve(right, budget - n);
        if (!l || !h) continue;
        const angle = fold(theta + (dimension === 0 ? Math.PI / 2 : 0));
        const at = rotate(dimension === 0 ? [value, 0] : [0, value], theta);
        // A boundary vertex may lie on the cut; use the box center to choose its side.
        const lb = bounds(left),
          center = rotate([(lb.x0 + lb.x1) / 2, (lb.y0 + lb.y1) / 2], theta);
        const negativeLow =
          Math.cos(angle) * (center[1] - at[1]) - Math.sin(angle) * (center[0] - at[0]) < 0;
        const next: Tree = {
          ring: r,
          leaves: l.leaves + h.leaves,
          score: Math.min(l.score, h.score),
          split: { at, angle, negative: negativeLow ? l : h, positive: negativeLow ? h : l },
        };
        if (
          !best ||
          next.leaves < best.leaves ||
          (next.leaves === best.leaves && next.score > best.score + 1e-9)
        )
          best = next;
      }
    }
    memo.set(key, best);
    return best;
  };
  const tree = solve(full, ROOF_PLAN_MAX_LEAVES);
  if (!tree || tree.leaves < 2) return;
  const nodes: RoofNode[] = [];
  const emit = (t: Tree): number => {
    const index = nodes.length;
    if (t.split) {
      const node: Extract<RoofNode, { type: 'split' }> = {
        type: 'split',
        at: t.split.at.map((v) => round(v)) as RoofPoint,
        angleDeg: round((t.split.angle * 180) / Math.PI, 2) % 180,
        negative: 0,
        positive: 0,
      };
      const flipped = Math.abs((node.angleDeg * Math.PI) / 180 - t.split.angle) > Math.PI / 2;
      nodes.push(node);
      node.negative = emit(flipped ? t.split.positive : t.split.negative);
      node.positive = emit(flipped ? t.split.negative : t.split.positive);
    } else {
      const b = bounds(t.ring),
        center = rotate([(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2], theta);
      nodes.push({
        type: 'roof',
        center: center.map((v) => round(v)) as RoofPoint,
        angleDeg:
          round((fold(theta + (b.height > b.width ? Math.PI / 2 : 0)) * 180) / Math.PI, 2) % 180,
        halfLengthM: round(Math.max(b.width, b.height) / 2),
        halfWidthM: round(Math.min(b.width, b.height) / 2),
      });
    }
    return index;
  };
  emit(tree);
  return RoofPlanSchema.parse({ version: 1, origin, nodes });
}

export function enrichRoofs(features: AtlasFeature[]) {
  const stats = {
    buildings: 0,
    plans: 0,
    leaves: {} as Record<number, number>,
    rejected: { flat: 0, topology: 0, shapeOrWings: 0 },
  };
  for (const f of features) {
    const p = f.properties;
    delete p.roof_plan;
    if (
      !isRoofBuilding(p.class) ||
      !(p.height! > 0) ||
      !['Polygon', 'MultiPolygon'].includes(f.geometry.type)
    )
      continue;
    stats.buildings++;
    if (p.variant === 'flat') {
      stats.rejected.flat++;
      continue;
    }
    if (f.geometry.type !== 'Polygon' || f.geometry.coordinates.length !== 1) {
      stats.rejected.topology++;
      continue;
    }
    const ring = f.geometry.coordinates[0]!;
    const west = Math.min(...ring.map((p) => p[0]!)),
      east = Math.max(...ring.map((p) => p[0]!));
    const south = Math.min(...ring.map((p) => p[1]!)),
      north = Math.max(...ring.map((p) => p[1]!));
    const origin: RoofPoint = [round((west + east) / 2, 7), round((south + north) / 2, 7)];
    const frame = roofFrame(origin);
    const plan = roofPlan(ring.map(frame.toLocal), origin);
    if (!plan) {
      stats.rejected.shapeOrWings++;
      continue;
    }
    p.roof_plan = JSON.stringify(plan);
    stats.plans++;
    const n = plan.nodes.filter((node) => node.type === 'roof').length;
    stats.leaves[n] = (stats.leaves[n] ?? 0) + 1;
  }
  if (stats.buildings >= 200 && stats.plans > stats.buildings * 0.1)
    throw new Error('Roof plans exceed 10% of standing buildings; inspect candidate rules');
  return stats;
}
