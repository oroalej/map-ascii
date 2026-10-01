/** Versioned, bounded roof partitions. This module is safe to import in the tile worker. */
import { ROOF_PLAN_MAX_LEAVES, ROOF_PLAN_MAX_NODES } from './constants';
import type { AtlasClass } from './schemas';
export type RoofPoint = [number, number];
export type RoofNode =
  | { type: 'split'; at: RoofPoint; angleDeg: number; negative: number; positive: number }
  | { type: 'roof'; center: RoofPoint; angleDeg: number; halfLengthM: number; halfWidthM: number };
export type RoofPlan = { version: 1; origin: RoofPoint; nodes: RoofNode[] };

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const point = (v: unknown): v is RoofPoint =>
  Array.isArray(v) && v.length === 2 && v.every((n) => finite(n) && Math.abs(n) <= 1_000_000);
const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const keys = (v: Record<string, unknown>, names: string[]) =>
  Object.keys(v).length === names.length && names.every((name) => name in v);

/** Validate before dereferencing any node; no recursion or unbounded runtime work. */
export function isRoofPlan(value: unknown): value is RoofPlan {
  if (
    !object(value) ||
    !keys(value, ['version', 'origin', 'nodes']) ||
    value.version !== 1 ||
    !point(value.origin) ||
    Math.abs(value.origin[0]) > 180 ||
    Math.abs(value.origin[1]) > 85.05112878 ||
    !Array.isArray(value.nodes) ||
    value.nodes.length < 1 ||
    value.nodes.length > ROOF_PLAN_MAX_NODES
  )
    return false;
  const parents = new Uint8Array(value.nodes.length);
  let leaves = 0;
  for (const [i, node] of value.nodes.entries()) {
    if (!object(node) || !finite(node.angleDeg) || node.angleDeg < 0 || node.angleDeg >= 180)
      return false;
    if (node.type === 'roof') {
      if (
        !keys(node, ['type', 'center', 'angleDeg', 'halfLengthM', 'halfWidthM']) ||
        !point(node.center) ||
        !finite(node.halfLengthM) ||
        !finite(node.halfWidthM) ||
        node.halfWidthM <= 0 ||
        node.halfLengthM > 1_000_000 ||
        node.halfLengthM < node.halfWidthM
      )
        return false;
      leaves++;
    } else if (node.type === 'split') {
      if (!keys(node, ['type', 'at', 'angleDeg', 'negative', 'positive']) || !point(node.at))
        return false;
      for (const child of [node.negative, node.positive]) {
        if (!finite(child) || !Number.isInteger(child) || child <= i || child >= value.nodes.length)
          return false;
        parents[child] = parents[child]! + 1;
      }
    } else return false;
  }
  return (
    leaves <= ROOF_PLAN_MAX_LEAVES &&
    parents[0] === 0 &&
    parents.slice(1).every((count) => count === 1)
  );
}

export function parseRoofPlan(value: unknown): RoofPlan | undefined {
  if (typeof value !== 'string' || value.length > 4096) return undefined;
  try {
    const plan: unknown = JSON.parse(value);
    return isRoofPlan(plan) ? plan : undefined;
  } catch {
    return undefined;
  }
}

const R = 40_075_016.686 / (2 * Math.PI);
const RAD = Math.PI / 180;
/** Conformal local meters, east/south, using the origin's scale for every tile. */
export function roofFrame(origin: readonly [number, number]) {
  const scale = Math.cos(origin[1] * RAD);
  const y0 = Math.asinh(Math.tan(origin[1] * RAD));
  return {
    toLocal: (p: readonly number[]): RoofPoint => [
      (p[0]! - origin[0]) * RAD * R * scale,
      (y0 - Math.asinh(Math.tan(p[1]! * RAD))) * R * scale,
    ],
    toLngLat: (p: readonly number[]): RoofPoint => [
      origin[0] + p[0]! / (R * scale * RAD),
      Math.atan(Math.sinh(y0 - p[1]! / (R * scale))) / RAD,
    ],
    metersPerTileUnit: (zoom: number, extent = 4096) =>
      (2 * Math.PI * R * scale) / (2 ** zoom * extent),
  };
}

export const ROOF_BUILDING_CLASSES: readonly AtlasClass[] = [
  'building',
  'building_religious',
  'building_school',
  'building_market',
  'building_station',
];
export const isRoofBuilding = (cls: string) =>
  (ROOF_BUILDING_CLASSES as readonly string[]).includes(cls);
