import {
  CLASS_ZOOM,
  tileZoomRange,
  isRoofBuilding,
  type LandmarkPlan,
  type PlanPart,
} from '@atlas/shared';
import type { Feature, Geometry, Polygon, Position } from 'geojson';
import type { AtlasFeature } from '../03-normalize';
import { TILE_ZOOMS } from '../03-normalize';

/** Meters per degree of latitude (and of longitude at the equator). */
const METERS_PER_DEGREE = 111_320;

const compass = {
  n: [0, 1],
  ne: [Math.SQRT1_2, Math.SQRT1_2],
  e: [1, 0],
  se: [Math.SQRT1_2, -Math.SQRT1_2],
  s: [0, -1],
  sw: [-Math.SQRT1_2, -Math.SQRT1_2],
  w: [-1, 0],
  nw: [-Math.SQRT1_2, Math.SQRT1_2],
} as const;

type Vec = [number, number];

/** A local meters frame around a point (east, north), and back to lng/lat. */
function localFrame([lng0, lat0]: Vec) {
  const mx = METERS_PER_DEGREE * Math.cos((lat0 * Math.PI) / 180);
  return {
    toMeters: ([lng, lat]: Position): Vec => [
      (lng! - lng0) * mx,
      (lat! - lat0) * METERS_PER_DEGREE,
    ],
    toLngLat: ([x, y]: Vec): Vec => [lng0 + x / mx, lat0 + y / METERS_PER_DEGREE],
  };
}

/** The outer ring of an area feature's largest polygon, or null for other geometries. */
function outerRing(geometry: Geometry): Position[] | null {
  if (geometry.type === 'Polygon') return geometry.coordinates[0] ?? null;
  if (geometry.type === 'MultiPolygon') {
    const rings = geometry.coordinates.map((p) => p[0] ?? []);
    return rings.sort((a, b) => b.length - a.length)[0] ?? null;
  }
  return null;
}

/**
 * The footprint's long axis (principal axis of its outline), pointing toward `front`, and its
 * extent along it. `section(a)` gives the footprint's left and right edges across the axis at
 * `a` meters along it (left and right as seen looking at the front).
 */
export function footprintAxis(ring: readonly Vec[], front: Vec) {
  const n = ring.length - 1 || 1;
  const c: Vec = [0, 0];
  for (let i = 0; i < n; i++) [c[0], c[1]] = [c[0] + ring[i]![0] / n, c[1] + ring[i]![1] / n];
  let [sxx, syy, sxy] = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const [dx, dy] = [ring[i]![0] - c[0], ring[i]![1] - c[1]];
    [sxx, syy, sxy] = [sxx + dx * dx, syy + dy * dy, sxy + dx * dy];
  }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let u: Vec = [Math.cos(theta), Math.sin(theta)];
  if (u[0] * front[0] + u[1] * front[1] < 0) u = [-u[0], -u[1]];
  // Someone looking at the front faces -u; their right-hand side is (-u.y, u.x).
  const right: Vec = [-u[1], u[0]];
  const local = ring.map(([x, y]): Vec => {
    const [dx, dy] = [x - c[0], y - c[1]];
    return [dx * u[0] + dy * u[1], dx * right[0] + dy * right[1]];
  });
  const alongs = local.map(([a]) => a);
  const section = (a: number): [number, number] | null => {
    const crossings: number[] = [];
    for (let i = 0; i < local.length - 1; i++) {
      const [a0, b0] = local[i]!;
      const [a1, b1] = local[i + 1]!;
      if (a0 !== a1 && (a0 - a) * (a1 - a) <= 0)
        crossings.push(b0 + ((b1 - b0) * (a - a0)) / (a1 - a0));
    }
    return crossings.length ? [Math.min(...crossings), Math.max(...crossings)] : null;
  };
  return {
    center: c,
    along: u,
    right,
    back: Math.min(...alongs),
    front: Math.max(...alongs),
    section,
  };
}

/** A regular polygon for a part: circle (16 sides), hexagon, or square, turned by `angle`. */
export function partOutline(part: Pick<PlanPart, 'shape' | 'size_m'>, center: Vec, angle: number) {
  const sides = part.shape === 'circle' ? 16 : part.shape === 'hexagon' ? 6 : 4;
  // Squares are measured side to side, the others across their corners (circles: diameter).
  const radius = part.shape === 'square' ? part.size_m / Math.SQRT2 : part.size_m / 2;
  const start = angle + (part.shape === 'square' ? Math.PI / 4 : 0);
  const ring: Vec[] = [];
  for (let i = 0; i < sides; i++) {
    const t = start + (i / sides) * 2 * Math.PI;
    ring.push([center[0] + radius * Math.cos(t), center[1] + radius * Math.sin(t)]);
  }
  ring.push(ring[0]!);
  return ring;
}

type Placed = Feature<Geometry, { id: string; class?: string; height?: number }>;

/**
 * Turn landmark plans into `building_part` features: each part a small footprint with its own
 * height, placed on its feature (`at`, along the long axis toward `front`) or around its point
 * (`offset_m`). Fails loudly when a plan's feature is missing or a part doesn't fit its feature;
 * returns warnings for parts whose center falls outside the footprint.
 */
export function planParts(
  features: readonly Placed[],
  plans: readonly LandmarkPlan[],
): { parts: AtlasFeature[]; warnings: string[] } {
  const byId = new Map(features.map((f) => [f.properties.id, f]));
  const parts: AtlasFeature[] = [];
  const warnings: string[] = [];
  const problems: string[] = [];
  const band = tileZoomRange(CLASS_ZOOM.building_part, TILE_ZOOMS);

  for (const plan of plans) {
    const feature = byId.get(plan.osm_id);
    if (!feature) {
      problems.push(`${plan.id}: ${plan.osm_id} is not in the OSM data`);
      continue;
    }
    const slug = plan.id.replace('plan/', '');
    const ring = outerRing(feature.geometry);
    const point = feature.geometry.type === 'Point' ? (feature.geometry.coordinates as Vec) : null;
    const origin: Vec = point ?? ((ring?.[0] ?? [0, 0]) as Vec);
    const frame = localFrame(origin);
    const axis = ring
      ? footprintAxis(ring.map(frame.toMeters), compass[plan.front ?? 'n'] as unknown as Vec)
      : null;

    plan.parts.forEach((part, i) => {
      let center: Vec;
      let angle = 0;
      if (part.at) {
        if (!axis) {
          problems.push(`${plan.id} part ${i + 1}: \`at\` needs an area feature`);
          return;
        }
        if (!isRoofBuilding(feature.properties.class ?? '') || !(feature.properties.height! > 0)) {
          problems.push(`${plan.id} part ${i + 1}: \`at\` needs a standing building, not grounds`);
          return;
        }
        const a = part.at.along >= 0 ? part.at.along * axis.front : -part.at.along * axis.back;
        const section = axis.section(a);
        if (!section) {
          warnings.push(`${plan.id} part ${i + 1}: outside the footprint`);
          return;
        }
        const mid = (section[0] + section[1]) / 2;
        const b = mid + (part.at.across * (section[1] - section[0])) / 2;
        center = [
          axis.center[0] + axis.along[0] * a + axis.right[0] * b,
          axis.center[1] + axis.along[1] * a + axis.right[1] * b,
        ];
        angle = Math.atan2(axis.along[1], axis.along[0]);
      } else if (part.offset_m && point) {
        center = [part.offset_m[0], part.offset_m[1]];
      } else {
        problems.push(`${plan.id} part ${i + 1}: \`offset_m\` needs a point feature`);
        return;
      }
      const outline = partOutline(part, center, angle).map(frame.toLngLat);
      const geometry: Polygon = { type: 'Polygon', coordinates: [outline] };
      parts.push({
        type: 'Feature',
        geometry,
        properties: {
          id: `plan:${slug}/${i + 1}`,
          class: 'building_part',
          height: part.height_m,
          variant: part.kind,
        },
        tippecanoe: { layer: 'buildings', ...band },
      });
    });
  }
  if (problems.length > 0) throw new Error(`Landmark plans:\n  ${problems.join('\n  ')}`);
  return { parts, warnings };
}

/** Preserve author/license attribution supplied by the city pack. */
export function planCredits(plans: readonly LandmarkPlan[]): string[] {
  return [...new Set(plans.map((p) => p.credit?.trim()).filter((s): s is string => !!s))];
}
