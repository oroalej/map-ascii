import { roofFrame, RoofShape, foldRoofAngle, type RoofPlan, type RoofNode } from '@atlas/shared';
export { RoofShape, foldRoofAngle } from '@atlas/shared';

export type RoofVertex = { x: number; y: number };
export type RoofSurface = [along: number, across: number, ridgeHalf: number, endScale: number];
/** Precomputed once per roof, then written directly into the vertex buffer. */
export type RoofSurfaceFrame = {
  cx: number;
  cy: number;
  ux: number;
  uy: number;
  unit: number;
  ridgeHalf: number;
  endScale: number;
  angle: number;
};

export function roofParameters(halfLength: number, halfWidth: number, shape: number) {
  return {
    ridgeHalf:
      shape === RoofShape.gabled
        ? halfLength
        : shape === RoofShape.pyramidal
          ? 0
          : Math.max(0, halfLength - halfWidth),
    endScale:
      shape === RoofShape.gabled ? 0 : shape === RoofShape.pyramidal ? halfWidth / halfLength : 1,
  };
}

/** Pack distances at <=1/64m steps unless the mesh needs a larger range; never clamp. */
export function packRoofSurface(source: Float32Array, count: number) {
  let maximum = 0,
    fallback = false;
  for (let i = 0; i < count * 4; i += 4) {
    maximum = Math.max(
      maximum,
      Math.abs(source[i] ?? 0),
      Math.abs(source[i + 1] ?? 0),
      Math.abs(source[i + 2] ?? 0),
    );
    const end = source[i + 3] ?? 0;
    if (end < 0 || end > 1 || (end > 0 && Math.round(end * 32767) === 0)) fallback = true;
  }
  if (fallback) {
    const surface = new Float32Array(count * 4);
    surface.set(source.subarray(0, surface.length));
    return { surface };
  }
  const surfaceScale = Math.max(1 / 64, maximum / 32767);
  const surface = new Int16Array(count * 4);
  for (let i = 0; i < surface.length; i += 4) {
    surface[i] = Math.round((source[i] ?? 0) / surfaceScale);
    surface[i + 1] = Math.round((source[i + 1] ?? 0) / surfaceScale);
    surface[i + 2] = Math.round((source[i + 2] ?? 0) / surfaceScale);
    surface[i + 3] = Math.round((source[i + 3] ?? 0) * 32767);
  }
  return { surface, surfaceScale };
}

export function plannedRoofFrame(
  leaf: Leaf,
  originInTile: RoofVertex,
  unit: number,
  shape: number,
): RoofSurfaceFrame {
  const angle = (leaf.angleDeg * Math.PI) / 180;
  return {
    cx: originInTile.x + leaf.center[0] / unit,
    cy: originInTile.y + leaf.center[1] / unit,
    ux: Math.cos(angle),
    uy: Math.sin(angle),
    unit,
    angle: roofAngleByte(angle),
    ...roofParameters(leaf.halfLengthM, leaf.halfWidthM, shape),
  };
}
export const roofAngleByte = (angle: number) =>
  Math.min(255, Math.round((foldRoofAngle(angle) / Math.PI) * 255));

export function roofSurface(
  p: RoofVertex,
  center: RoofVertex,
  angle: number,
  halfLength: number,
  halfWidth: number,
  shape: number,
): RoofSurface {
  const u = Math.cos(angle),
    v = Math.sin(angle);
  const x = p.x - center.x,
    y = p.y - center.y;
  const { ridgeHalf, endScale } = roofParameters(halfLength, halfWidth, shape);
  return [x * u + y * v, y * u - x * v, ridgeHalf, endScale];
}

/** Oriented bounds, not the vertex centroid: extra vertices must not move the roof center. */
export function roofBounds(ring: readonly RoofVertex[], angle: number) {
  let u0 = Infinity,
    u1 = -Infinity,
    v0 = Infinity,
    v1 = -Infinity;
  const u = Math.cos(angle),
    v = Math.sin(angle);
  for (const p of ring) {
    const a = p.x * u + p.y * v,
      b = p.y * u - p.x * v;
    u0 = Math.min(u0, a);
    u1 = Math.max(u1, a);
    v0 = Math.min(v0, b);
    v1 = Math.max(v1, b);
  }
  const a = (u0 + u1) / 2,
    b = (v0 + v1) / 2;
  return {
    center: { x: a * u - b * v, y: a * v + b * u },
    halfLength: (u1 - u0) / 2,
    halfWidth: (v1 - v0) / 2,
  };
}

type Leaf = Extract<RoofNode, { type: 'roof' }>;
export type RoofTriangle = { points: RoofVertex[]; leaf: Leaf };

/** Clip convex triangles, never whole concave rings or holes. Boundary coordinates are shared. */
export function partitionRoofTriangles(
  points: readonly RoofVertex[],
  indices: readonly number[],
  plan: RoofPlan,
  originInTile: RoofVertex,
  tileZoom: number,
): RoofTriangle[] | undefined {
  const unit = roofFrame(plan.origin).metersPerTileUnit(tileZoom);
  const local = points.map((p) => ({
    x: (p.x - originInTile.x) * unit,
    y: (p.y - originInTile.y) * unit,
  }));
  const result: RoofTriangle[] = [];
  const clip = (
    ring: RoofVertex[],
    node: Extract<RoofNode, { type: 'split' }>,
    positive: boolean,
  ) => {
    const theta = (node.angleDeg * Math.PI) / 180;
    const signed = (p: RoofVertex) =>
      Math.cos(theta) * (p.y - node.at[1]) - Math.sin(theta) * (p.x - node.at[0]);
    const inside = (d: number) => (positive ? d >= 0 : d <= 0);
    const out: RoofVertex[] = [];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!,
        b = ring[(i + 1) % ring.length]!;
      const da = signed(a),
        db = signed(b);
      if (inside(da)) out.push(a);
      if (inside(da) !== inside(db)) {
        // Canonical edge order produces bit-identical intersections from either triangle.
        const forward = a.x < b.x || (a.x === b.x && a.y < b.y);
        const p = forward ? a : b,
          q = forward ? b : a;
        const d = forward ? da : db,
          e = forward ? db : da;
        const t = d / (d - e);
        out.push({ x: p.x + t * (q.x - p.x), y: p.y + t * (q.y - p.y) });
      }
    }
    return out;
  };
  const walk = (ring: RoofVertex[], index: number) => {
    if (ring.length < 3) return;
    const node = plan.nodes[index]!;
    if (node.type === 'split') {
      walk(clip(ring, node, false), node.negative);
      walk(clip(ring, node, true), node.positive);
    } else {
      const tile = ring.map((p) => ({
        x: Math.round(p.x / unit + originInTile.x),
        y: Math.round(p.y / unit + originInTile.y),
      }));
      for (let i = 1; i < tile.length - 1; i++) {
        const a = tile[0]!,
          b = tile[i]!,
          c = tile[i + 1]!;
        if ((b.x - a.x) * (c.y - a.y) !== (b.y - a.y) * (c.x - a.x))
          result.push({ points: [a, b, c], leaf: node });
      }
    }
  };
  for (let i = 0; i < indices.length; i += 3)
    walk(
      indices.slice(i, i + 3).map((n) => local[n]!),
      0,
    );
  return result.length &&
    result.every((t) => t.points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)))
    ? result
    : undefined;
}

export function plannedSurface(
  p: RoofVertex,
  leaf: Leaf,
  plan: RoofPlan,
  originInTile: RoofVertex,
  zoom: number,
  shape: number,
  unit = roofFrame(plan.origin).metersPerTileUnit(zoom),
): RoofSurface {
  return roofSurface(
    { x: (p.x - originInTile.x) * unit, y: (p.y - originInTile.y) * unit },
    { x: leaf.center[0], y: leaf.center[1] },
    (leaf.angleDeg * Math.PI) / 180,
    leaf.halfLengthM,
    leaf.halfWidthM,
    shape,
  );
}
