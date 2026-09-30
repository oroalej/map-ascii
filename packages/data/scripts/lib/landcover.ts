import {
  featureZoomBand,
  tileZoomRange,
  type AtlasClass,
  type LandCover,
  type Landcover,
  type TreeKind,
} from '@atlas/shared';
import turfCentroid from '@turf/centroid';
import type { Feature, Geometry, Position } from 'geojson';
import type { AtlasFeature } from '../03-normalize';
import { TILE_ZOOMS } from '../03-normalize';
import { layerFor, treeSize, variantOf, type GeometryKind, type Tags } from './classify';

/** Meters per degree of latitude (and of longitude at the equator). */
const METERS_PER_DEGREE = 111_320;

/** The atlas class each curated land cover is drawn as. */
const coverClass: Record<LandCover, AtlasClass> = {
  grass: 'grass',
  parking: 'parking',
  woods: 'trees',
  shrubs: 'shrubs',
  planting: 'planting',
};

/** How close (meters) an OSM tree must be to a curated one to count as the same tree. */
export const SAME_TREE_M = 3;

type Placed = Pick<Feature<Geometry, { id: string; class?: string }>, 'geometry' | 'properties'>;

/**
 * A curated tree's attributes as the OSM tags a mapper would use, so it goes through the same
 * `treeSize` / `variantOf` rules as an OSM tree (a palm is named by its taxonomy in OSM).
 */
function tagsFor(kind: TreeKind | undefined, crown_m?: number, height_m?: number): Tags {
  return {
    ...(kind === 'palm' ? { taxon: 'Arecaceae' } : kind ? { leaf_type: kind } : {}),
    ...(crown_m !== undefined && { diameter_crown: String(crown_m) }),
    ...(height_m !== undefined && { height: String(height_m) }),
  };
}

function feature(
  id: string,
  cls: AtlasClass,
  kind: GeometryKind,
  geometry: Geometry,
  tags: Tags,
): AtlasFeature {
  const variant = variantOf(tags, cls);
  return {
    type: 'Feature',
    geometry,
    properties: {
      id,
      class: cls,
      ...(cls === 'tree' && treeSize(tags)),
      ...(variant !== undefined && { variant }),
    },
    tippecanoe: { layer: layerFor(cls, kind), ...tileZoomRange(featureZoomBand(cls), TILE_ZOOMS) },
  };
}

const metersBetween = ([lng1, lat1]: Position, [lng2, lat2]: Position) => {
  const mx = METERS_PER_DEGREE * Math.cos((lat1! * Math.PI) / 180);
  return Math.hypot((lng2! - lng1!) * mx, (lat2! - lat1!) * METERS_PER_DEGREE);
};

const inRing = (ring: readonly Position[], [x, y]: Position) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi! > y! !== yj! > y! && x! < ((xj! - xi!) * (y! - yi!)) / (yj! - yi!) + xi!) {
      inside = !inside;
    }
  }
  return inside;
};

/**
 * The city pack's curated trees, tree rows, and areas as features of their atlas class
 * (`tree`, or the area's `coverClass`), with ids `cover:<slug>/<tree|row|area>-<n>` (1-based).
 * A curated tree with an OSM tree within `SAME_TREE_M` is dropped, since OSM has caught up;
 * warnings name what to remove from the pack, and flag OSM features of an area's class inside
 * it.
 */
export function landcoverFeatures(
  features: readonly Placed[],
  packs: readonly Landcover[],
): { features: AtlasFeature[]; warnings: string[] } {
  const osmTrees: Position[] = [];
  const osmAreas = new Map<string, Position[]>();
  for (const f of features) {
    const cls = f.properties.class;
    if (cls === 'tree' && f.geometry.type === 'Point') osmTrees.push(f.geometry.coordinates);
    else if (cls && Object.values(coverClass).includes(cls as AtlasClass)) {
      const centers = osmAreas.get(cls) ?? [];
      centers.push(turfCentroid(f.geometry).geometry.coordinates);
      osmAreas.set(cls, centers);
    }
  }

  const out: AtlasFeature[] = [];
  const warnings: string[] = [];
  for (const pack of packs) {
    const slug = pack.id.replace('landcover/', '');
    pack.trees.forEach((tree, i) => {
      if (osmTrees.some((p) => metersBetween(tree.at, p) <= SAME_TREE_M)) {
        warnings.push(`${pack.id} tree ${i + 1} is now in OSM; remove it from the pack`);
        return;
      }
      const tags = tagsFor(tree.kind, tree.crown_m, tree.height_m);
      const geometry: Geometry = { type: 'Point', coordinates: tree.at };
      out.push(feature(`cover:${slug}/tree-${i + 1}`, 'tree', 'point', geometry, tags));
    });
    pack.rows.forEach((row, i) => {
      const tags = tagsFor(row.kind, row.crown_m, row.height_m);
      const geometry: Geometry = { type: 'LineString', coordinates: row.line };
      out.push(feature(`cover:${slug}/row-${i + 1}`, 'tree', 'line', geometry, tags));
    });
    pack.areas.forEach((area, i) => {
      const cls = coverClass[area.cover];
      const inside = (osmAreas.get(cls) ?? []).filter((p) => inRing(area.ring, p)).length;
      if (inside > 0) {
        warnings.push(
          `${pack.id} area ${i + 1} (${area.cover}) has ${inside} OSM ${cls} areas inside; check it`,
        );
      }
      const geometry: Geometry = { type: 'Polygon', coordinates: [area.ring] };
      const placed = feature(
        `cover:${slug}/area-${i + 1}`,
        cls,
        'area',
        geometry,
        tagsFor(area.kind),
      );
      if (area.raised || area.cover === 'shrubs') placed.properties.detail_blocked = true;
      out.push(placed);
    });
  }
  return { features: out, warnings };
}

/** The credits of the city's curated land cover, once each, for the map attribution. */
export const landcoverCredits = (packs: readonly Landcover[]): string[] => [
  ...new Set(packs.map((p) => p.credit)),
];
