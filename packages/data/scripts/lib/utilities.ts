/** Illustrative utility geometry, finalized before tiling. No runtime topology discovery. */
import {
  UTILITY,
  UtilityRecordSchema,
  utilityRandom,
  utilitySeed,
  utilitySpanId,
  type BBox,
  type UtilityPoint,
  type UtilityPole,
  type UtilitySpan,
  type UtilityRecord,
} from '@atlas/shared';
import type { Position } from 'geojson';
import type { AtlasFeature } from '../03-normalize';

export type UtilityLamp = { key: string; road: string; at: UtilityPoint };
type XY = UtilityPoint;
type Component = {
  id: string;
  road: string;
  width: number;
  closed: boolean;
  points: XY[];
  geographic: XY[];
  distances: number[];
  length: number;
};
type Placed = { pole: UtilityPole; p: XY; along: number; component: Component };
const distance = (a: XY, b: XY) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const same = (a: Position, b: Position) => a[0] === b[0] && a[1] === b[1];
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function utilityProjection(bounds: BBox) {
  const latitude = (bounds[1] + bounds[3]) / 2;
  const longitude = (bounds[0] + bounds[2]) / 2;
  const scale = Math.cos((latitude * Math.PI) / 180);
  const radius = 6378137;
  const ox = (radius * longitude * Math.PI) / 180;
  const oy = radius * Math.log(Math.tan(Math.PI / 4 + (latitude * Math.PI) / 360));
  return {
    latitude,
    longitude,
    scale,
    project: (p: Position): XY => [
      ((radius * p[0]! * Math.PI) / 180 - ox) * scale,
      (radius * Math.log(Math.tan(Math.PI / 4 + (p[1]! * Math.PI) / 360)) - oy) * scale,
    ],
    unproject: (p: XY): XY => [
      (((p[0] / scale + ox) / radius) * 180) / Math.PI,
      ((2 * Math.atan(Math.exp((p[1] / scale + oy) / radius)) - Math.PI / 2) * 180) / Math.PI,
    ],
  };
}

/** Stable under reversal, component reordering and a closed ring's starting vertex. */
export function canonicalUtilityLine(input: readonly Position[]): XY[] {
  const points = input
    .filter((p, i) => !i || !same(p, input[i - 1]!))
    .map((p): XY => [p[0]!, p[1]!]);
  if (points.length < 2) return [];
  const closed = same(points[0]!, points.at(-1)!);
  if (closed) points.pop();
  if (points.length < 2) return [];
  const candidates: XY[][] = [];
  for (const order of [points, points.slice().reverse()]) {
    if (!closed) candidates.push(order);
    else {
      const minimum = order.map((p) => JSON.stringify(p)).sort()[0];
      for (let i = 0; i < order.length; i++)
        if (JSON.stringify(order[i]) === minimum)
          candidates.push([...order.slice(i), ...order.slice(0, i)]);
    }
  }
  candidates.sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
  const result = candidates[0]!;
  return closed ? [...result, result[0]!] : result;
}

export const utilityEligible = (f: AtlasFeature): boolean => {
  if (f.properties.region || !f.properties.class.startsWith('road_')) return false;
  const highway = f.properties.highway ?? f.properties.kind?.replace(/^highway=/, '');
  return [
    'motorway',
    'motorway_link',
    'trunk',
    'trunk_link',
    'primary',
    'primary_link',
    'secondary',
    'secondary_link',
  ].includes(highway ?? '');
};
const lines = (f: AtlasFeature): Position[][] =>
  f.geometry.type === 'LineString'
    ? [f.geometry.coordinates]
    : f.geometry.type === 'MultiLineString'
      ? f.geometry.coordinates
      : [];

function at(c: Component, along: number): { p: XY; h: XY } {
  let i = 1;
  while (i < c.points.length - 1 && c.distances[i]! < along) i++;
  const a = c.points[i - 1]!,
    b = c.points[i]!;
  const length = distance(a, b);
  const h: XY = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
  const d = along - c.distances[i - 1]!;
  return { p: [a[0] + h[0] * d, a[1] + h[1] * d], h };
}
function nearest(c: Component, p: XY) {
  let best = { along: 0, distance: Infinity, signed: 0 };
  for (let i = 1; i < c.points.length; i++) {
    const a = c.points[i - 1]!,
      b = c.points[i]!,
      length = distance(a, b);
    const hx = (b[0] - a[0]) / length,
      hy = (b[1] - a[1]) / length;
    const d = Math.max(0, Math.min(length, (p[0] - a[0]) * hx + (p[1] - a[1]) * hy));
    const gap = distance(p, [a[0] + hx * d, a[1] + hy * d]);
    if (gap < best.distance)
      best = {
        along: c.distances[i - 1]! + d,
        distance: gap,
        signed: (p[0] - a[0]) * -hy + (p[1] - a[1]) * hx,
      };
  }
  return best;
}
function inside(rings: XY[][], p: XY): boolean {
  let yes = false;
  for (const ring of rings)
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i]!,
        b = ring[j]!;
      if (
        a[1] > p[1] !== b[1] > p[1] &&
        p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
      )
        yes = !yes;
    }
  return yes;
}

export function generateUtilities(
  features: readonly AtlasFeature[],
  bounds: BBox,
  lamps: readonly UtilityLamp[] = [],
) {
  const projection = utilityProjection(bounds);
  const stats = {
    eligibleWays: 0,
    poles: 0,
    shared: 0,
    transformers: 0,
    spans: 0,
    crossings: 0,
    junctions: 0,
    rejected: { blocked: 0, carriageway: 0, median: 0, bounds: 0, endpoint: 0 },
  };
  const roads = features.filter(
    (f) => !f.properties.region && f.properties.class.startsWith('road_'),
  );
  const components: Component[] = [];
  for (const f of roads.slice().sort((a, b) => compare(a.properties.id, b.properties.id))) {
    const canonical = lines(f)
      .map(canonicalUtilityLine)
      .filter((p) => p.length > 1)
      .sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
    canonical.forEach((geographic, index) => {
      const points = geographic.map(projection.project);
      const distances = [0];
      for (let i = 1; i < points.length; i++)
        distances.push(distances[i - 1]! + distance(points[i - 1]!, points[i]!));
      components.push({
        id: `${f.properties.id}/${index}`,
        road: f.properties.id,
        width: f.properties.width ?? 6,
        closed: same(geographic[0]!, geographic.at(-1)!),
        points,
        geographic,
        distances,
        length: distances.at(-1)!,
      });
    });
  }
  const eligible = new Set(roads.filter(utilityEligible).map((f) => f.properties.id));
  stats.eligibleWays = eligible.size;
  const selected = components.filter((c) => eligible.has(c.road));
  const blocked: { rings: XY[][]; min: XY; max: XY }[] = [];
  const waterLines: { a: XY; b: XY; radius: number }[] = [];
  for (const f of features) {
    const p = f.properties;
    if (
      p.region ||
      !(
        p.detail_blocked ||
        (!p.detail_overhead && p.class.startsWith('building') && (p.height ?? 0) > 0) ||
        ['water_area', 'water_sea', 'water_river', 'water_stream'].includes(p.class)
      )
    )
      continue;
    if (p.class === 'water_river' || p.class === 'water_stream')
      for (const line of lines(f)) {
        const points = line.map(projection.project);
        for (let i = 1; i < points.length; i++)
          waterLines.push({
            a: points[i - 1]!,
            b: points[i]!,
            radius: (p.width ?? (p.class === 'water_river' ? 8 : 2)) / 2,
          });
      }
    const polygons =
      f.geometry.type === 'Polygon'
        ? [f.geometry.coordinates]
        : f.geometry.type === 'MultiPolygon'
          ? f.geometry.coordinates
          : [];
    for (const polygon of polygons) {
      const rings = polygon.map((r) => r.map(projection.project));
      const all = rings.flat();
      blocked.push({
        rings,
        min: [Math.min(...all.map((v) => v[0])), Math.min(...all.map((v) => v[1]))],
        max: [Math.max(...all.map((v) => v[0])), Math.max(...all.map((v) => v[1]))],
      });
    }
  }
  const rejection = (
    p: XY,
    c: Component,
    h: XY,
    normal: XY,
  ): keyof typeof stats.rejected | undefined => {
    const geographic = projection.unproject(p);
    if (
      geographic[0] < bounds[0] ||
      geographic[0] > bounds[2] ||
      geographic[1] < bounds[1] ||
      geographic[1] > bounds[3]
    )
      return 'bounds';
    if (
      blocked.some(
        (b) =>
          p[0] >= b.min[0] &&
          p[0] <= b.max[0] &&
          p[1] >= b.min[1] &&
          p[1] <= b.max[1] &&
          inside(b.rings, p),
      )
    )
      return 'blocked';
    if (
      waterLines.some(({ a, b, radius }) => {
        const dx = b[0] - a[0],
          dy = b[1] - a[1],
          squared = dx * dx + dy * dy;
        const t = squared
          ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / squared))
          : 0;
        return distance(p, [a[0] + t * dx, a[1] + t * dy]) <= radius;
      })
    )
      return 'blocked';
    for (const other of components) {
      if (other.road === c.road) continue;
      const near = nearest(other, p);
      if (near.distance <= other.width / 2) return 'carriageway';
      if (near.distance > 25) continue;
      const q = at(other, near.along);
      const own = nearest(c, p),
        center = at(c, own.along).p;
      const dx = q.p[0] - center[0],
        dy = q.p[1] - center[1];
      const d = Math.hypot(dx, dy),
        sideways = dx * normal[0] + dy * normal[1];
      if (
        Math.abs(q.h[0] * h[0] + q.h[1] * h[1]) >= 0.9 &&
        d < 25 &&
        sideways > 2 &&
        sideways > d * 0.7
      )
        return 'median';
    }
    return undefined;
  };
  const usedLamps = new Set<string>();
  const placed: Placed[] = [];
  const catalog = lamps.map((l) => ({ ...l, p: projection.project(l.at) }));
  for (const c of selected) {
    const side = utilitySeed(c.id) & 1 ? 1 : -1;
    const phase = utilityRandom(c.id, 'phase') * UTILITY.spacing;
    const start = c.closed ? 0 : UTILITY.setback;
    const end = c.length - (c.closed ? 0 : UTILITY.setback);
    const proposals: { id: string; slot: number; target: number }[] = [];
    for (let slot = 0; start + phase + slot * UTILITY.spacing < end; slot++)
      proposals.push({
        id: `utility:pole:${c.id}/${slot}`,
        slot,
        target: start + phase + slot * UTILITY.spacing,
      });
    for (const { id, slot, target } of proposals.sort((a, b) => compare(a.id, b.id))) {
      let along = target + (utilityRandom(id, 'jitter') * 2 - 1) * UTILITY.jitter;
      if (along < start || along >= end) {
        stats.rejected.endpoint++;
        continue;
      }
      let pose = at(c, along);
      let normal: XY = [-pose.h[1] * side, pose.h[0] * side];
      const lateral =
        c.width / 2 +
        UTILITY.lateral[0] +
        utilityRandom(id, 'lateral') * (UTILITY.lateral[1] - UTILITY.lateral[0]);
      let p: XY = [pose.p[0] + normal[0] * lateral, pose.p[1] + normal[1] * lateral];
      let shared: UtilityLamp | undefined;
      if (utilityRandom(id, 'share') < UTILITY.sharedChance) {
        const choices = catalog
          .filter((l) => l.road === c.road && !usedLamps.has(l.key))
          .map((l) => ({ l, near: nearest(c, l.p) }))
          .filter(
            ({ near }) =>
              Math.abs(near.along - target) <= UTILITY.jitter &&
              near.along >= start &&
              near.along < end &&
              near.signed * side > 0 &&
              near.distance <= c.width / 2 + 1,
          )
          .sort(
            (a, b) =>
              Math.abs(a.near.along - target) - Math.abs(b.near.along - target) ||
              compare(a.l.key, b.l.key),
          );
        for (const choice of choices) {
          const candidatePose = at(c, choice.near.along);
          const candidateNormal: XY = [-candidatePose.h[1] * side, candidatePose.h[0] * side];
          if (rejection(choice.l.p, c, candidatePose.h, candidateNormal)) continue;
          shared = choice.l;
          p = choice.l.p;
          along = choice.near.along;
          pose = candidatePose;
          normal = candidateNormal;
          break;
        }
      }
      const reason = rejection(p, c, pose.h, normal);
      if (reason) {
        stats.rejected[reason]++;
        continue;
      }
      if (shared) usedLamps.add(shared.key);
      const pole: UtilityPole = {
        id,
        road: c.road,
        component: c.id,
        at: shared ? shared.at : projection.unproject(p),
        heading: pose.h,
        normal,
        transformer: !shared && utilityRandom(id, 'transformer') < UTILITY.transformer,
        ...(shared ? { sharedLamp: shared.key } : {}),
      };
      placed.push({ pole, p, along, component: c });
      if (slot % UTILITY.crossingEvery !== utilitySeed(c.id) % UTILITY.crossingEvery) continue;
      let dropAt = along + UTILITY.crossingOffset;
      if (c.closed) dropAt %= c.length;
      if (dropAt >= end) continue;
      const drop = at(c, dropAt),
        n: XY = [drop.h[1] * side, -drop.h[0] * side];
      const dp: XY = [drop.p[0] + n[0] * lateral, drop.p[1] + n[1] * lateral];
      const why = rejection(dp, c, drop.h, n);
      if (why) {
        stats.rejected[why]++;
        continue;
      }
      placed.push({
        pole: {
          id: `${id}/drop`,
          road: c.road,
          component: c.id,
          at: projection.unproject(dp),
          heading: drop.h,
          normal: n,
          transformer: false,
          partner: id,
        },
        p: dp,
        along: dropAt,
        component: c,
      });
    }
  }
  const spans = new Map<string, UtilitySpan>();
  const connect = (
    a: Placed,
    b: Placed,
    kind: UtilitySpan['kind'],
    max: number = UTILITY.maxSpan,
  ): boolean => {
    const d = distance(a.p, b.p);
    if (a.pole.id === b.pole.id || d < 0.01 || d > max) return false;
    const [from, to] = [a.pole, b.pole].sort((p, q) => compare(p.id, q.id));
    const id = utilitySpanId(from!.id, to!.id);
    if (spans.has(id)) return false;
    spans.set(id, { id, kind, from: from!, to: to!, seed: utilitySeed(id) });
    return true;
  };
  const byId = new Map(placed.map((p) => [p.pole.id, p]));
  for (const p of placed) if (p.pole.partner) connect(p, byId.get(p.pole.partner)!, 'crossing');
  const mains = placed.filter((p) => !p.pole.partner);
  for (const c of selected) {
    const chain = mains.filter((p) => p.component === c).sort((a, b) => a.along - b.along);
    for (let i = 1; i < chain.length; i++)
      if (chain[i]!.along - chain[i - 1]!.along <= UTILITY.maxSpan)
        connect(chain[i - 1]!, chain[i]!, 'corridor');
    if (
      c.closed &&
      chain.length > 1 &&
      c.length - chain.at(-1)!.along + chain[0]!.along <= UTILITY.maxSpan
    )
      connect(chain.at(-1)!, chain[0]!, 'corridor');
  }
  const vertices = new Map<string, { c: Component; along: number; end: boolean }[]>();
  for (const c of selected)
    c.geographic.forEach((p, i) => {
      const key = JSON.stringify(p),
        list = vertices.get(key) ?? [];
      list.push({
        c,
        along: c.distances[i]!,
        end: !c.closed && (i === 0 || i === c.points.length - 1),
      });
      vertices.set(key, list);
    });
  const junctions: { a: Placed; b: Placed; d: number }[] = [];
  for (const touches of vertices.values()) {
    if (new Set(touches.map((t) => t.c.road)).size < 2) continue;
    for (const end of touches.filter((t) => t.end)) {
      const a = mains
        .filter(
          (p) => p.component === end.c && Math.abs(p.along - end.along) <= UTILITY.junctionLink,
        )
        .sort((p, q) => Math.abs(p.along - end.along) - Math.abs(q.along - end.along))[0];
      if (!a) continue;
      for (const other of touches.filter((t) => t.c.road !== end.c.road))
        for (const b of mains)
          if (b.component === other.c && Math.abs(b.along - other.along) <= UTILITY.junctionLink)
            junctions.push({ a, b, d: distance(a.p, b.p) });
    }
  }
  const linked = new Set<string>();
  junctions.sort(
    (a, b) =>
      a.d - b.d ||
      compare(utilitySpanId(a.a.pole.id, a.b.pole.id), utilitySpanId(b.a.pole.id, b.b.pole.id)),
  );
  for (const { a, b } of junctions)
    if (
      !linked.has(a.pole.id) &&
      !linked.has(b.pole.id) &&
      connect(a, b, 'junction', UTILITY.junctionLink)
    ) {
      linked.add(a.pole.id);
      linked.add(b.pole.id);
    }
  const records: UtilityRecord[] = [
    ...placed.map(({ pole }): UtilityRecord => ({ version: 1, kind: 'pole', pole })),
    ...[...spans.values()].map((span): UtilityRecord => ({ version: 1, kind: 'span', span })),
  ].sort((a, b) =>
    compare(a.kind === 'pole' ? a.pole.id : a.span.id, b.kind === 'pole' ? b.pole.id : b.span.id),
  );
  for (const record of records) UtilityRecordSchema.parse(record);
  stats.poles = placed.length;
  stats.shared = placed.filter((p) => p.pole.sharedLamp).length;
  stats.transformers = placed.filter((p) => p.pole.transformer).length;
  stats.spans = spans.size;
  stats.crossings = [...spans.values()].filter((s) => s.kind === 'crossing').length;
  stats.junctions = [...spans.values()].filter((s) => s.kind === 'junction').length;
  return {
    records,
    stats,
    projection: {
      latitude: projection.latitude,
      longitude: projection.longitude,
      scale: projection.scale,
    },
  };
}
