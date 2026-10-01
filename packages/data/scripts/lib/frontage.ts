import bbox from '@turf/bbox';
import pointInPolygon from '@turf/boolean-point-in-polygon';
import { difference } from 'polyclip-ts';
import { ShopAnchor, SHOP_POINT_RADIUS_M, type FrontageKind } from '@atlas/shared';
import type { Feature, FeatureCollection, Polygon, MultiPolygon, Position } from 'geojson';
import { classify, type Tags } from './classify';
export type Frontage = FrontageKind;
export function frontageOf(tags: Tags): Frontage | undefined {
  if (
    ['restaurant', 'fast_food', 'cafe', 'bar', 'pub', 'food_court', 'ice_cream'].includes(
      tags.amenity ?? '',
    )
  )
    return 'food';
  if (
    ['pharmacy', 'bank', 'clinic', 'dentist', 'internet_cafe'].includes(tags.amenity ?? '') ||
    (tags.craft && tags.craft !== 'no') ||
    ['pharmacy', 'hairdresser', 'laundry'].includes(tags.shop ?? '')
  )
    return 'service';
  if (tags.shop && tags.shop !== 'no') return 'retail';
  if (tags.building === 'commercial' || tags.building === 'retail') return 'commercial';
  return undefined;
}
const priority: Record<Frontage, number> = { food: 4, service: 3, retail: 2, commercial: 1 };

type Area = Polygon | MultiPolygon;
const polygons = (g: Area) => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates);
const ringArea = (ring: Position[]) =>
  Math.abs(
    ring.reduce((sum, p, i) => {
      const q = ring[(i + 1) % ring.length]!;
      return sum + p[0]! * q[1]! - q[0]! * p[1]!;
    }, 0),
  ) / 2;
const area = (rings: Position[][]) =>
  ringArea(rings[0]!) - rings.slice(1).reduce((n, r) => n + ringArea(r), 0);
const geometryArea = (g: Area) => polygons(g).reduce((n, p) => n + area(p), 0);
const stableId = (f: Feature) => String(f.id ?? f.properties?.id ?? JSON.stringify(f.geometry));
const compareId = (a: Feature, b: Feature) =>
  stableId(a) < stableId(b) ? -1 : stableId(a) > stableId(b) ? 1 : 0;

/** Outer boundaries belong to a footprint, hole boundaries do not. */
function contains(p: Position, g: Area): boolean {
  return polygons(g).some(
    ([outer, ...holes]) =>
      pointInPolygon(p, { type: 'Polygon', coordinates: [outer!] }) &&
      !holes.some((h) => pointInPolygon(p, { type: 'Polygon', coordinates: [h] })),
  );
}

/** Stable interior anchor, including concave polygons and courtyards. */
export function interiorPoint(g: Area): [number, number] {
  const rings = [...polygons(g)].sort(
    (a, b) => area(b) - area(a) || JSON.stringify(a).localeCompare(JSON.stringify(b)),
  )[0]!;
  const shape: Polygon = { type: 'Polygon', coordinates: rings };
  const outer = rings[0]!.slice(0, -1);
  const center: [number, number] = [
    outer.reduce((n, p) => n + p[0]!, 0) / outer.length,
    outer.reduce((n, p) => n + p[1]!, 0) / outer.length,
  ];
  if (contains(center, shape)) return center;
  const ys = [...new Set(rings.flat().map((p) => p[1]!))].sort((a, b) => a - b);
  let best: [number, number] | undefined,
    width = -1;
  for (let i = 1; i < ys.length; i++) {
    const y = (ys[i - 1]! + ys[i]!) / 2,
      xs: number[] = [];
    for (const ring of rings)
      for (let j = 1; j < ring.length; j++) {
        const a = ring[j - 1]!,
          b = ring[j]!;
        if (a[1]! > y !== b[1]! > y)
          xs.push(a[0]! + ((y - a[1]!) * (b[0]! - a[0]!)) / (b[1]! - a[1]!));
      }
    xs.sort((a, b) => a - b);
    for (let j = 1; j < xs.length; j += 2) {
      const span = xs[j]! - xs[j - 1]!;
      if (span > width) {
        width = span;
        best = [(xs[j]! + xs[j - 1]!) / 2, y];
      }
    }
  }
  if (!best || width <= 0) throw new Error('Cannot anchor a degenerate shop polygon');
  return best;
}

/** Derive once from the uncut geometry, never from a tile fragment. */
export function shopAnchor(feature: Feature): ShopAnchor | undefined {
  const g = feature.geometry;
  if (g.type !== 'Point' && g.type !== 'Polygon' && g.type !== 'MultiPolygon') return;
  const [lng, lat] = g.type === 'Point' ? g.coordinates : interiorPoint(g);
  const mx = 111_320 * Math.cos((lat! * Math.PI) / 180);
  const radius =
    g.type === 'Point'
      ? SHOP_POINT_RADIUS_M
      : Math.max(
          1,
          ...polygons(g)
            .flat(2)
            .map((p) => Math.hypot((p[0]! - lng!) * mx, (p[1]! - lat!) * 111_320)),
        );
  return ShopAnchor.parse({ shop_lng: lng, shop_lat: lat, shop_radius_m: radius });
}

/** Resolve shop nodes while raw tags still exist, before normalization discards them. */
export function assignFrontages(osm: FeatureCollection): FeatureCollection {
  const features = osm.features.map((f) => ({ ...f, properties: { ...f.properties } }));
  // These are generated annotations, never authoritative OSM input tags.
  for (const f of features) {
    delete f.properties.frontage;
    delete f.properties.atlas_in_building;
  }
  const grid = new Map<string, Feature<Polygon | MultiPolygon>[]>(),
    cell = 0.001;
  for (const f of features) {
    if (
      !f.properties.building ||
      f.properties.building === 'no' ||
      !['Polygon', 'MultiPolygon'].includes(f.geometry.type)
    )
      continue;
    const building = f as Feature<Polygon | MultiPolygon>,
      bounds = bbox(building);
    const own = frontageOf(f.properties);
    if (own) f.properties.frontage = own;
    for (let x = Math.floor(bounds[0] / cell); x <= Math.floor(bounds[2] / cell); x++)
      for (let y = Math.floor(bounds[1] / cell); y <= Math.floor(bounds[3] / cell); y++) {
        const key = `${x}/${y}`,
          list = grid.get(key) ?? [];
        list.push(building);
        grid.set(key, list);
      }
  }
  for (const list of grid.values())
    list.sort((a, b) => geometryArea(a.geometry) - geometryArea(b.geometry) || compareId(a, b));
  for (const f of [...features].sort(compareId)) {
    const kind = frontageOf(f.properties);
    if (!kind) continue;
    const shape = f.geometry;
    const shopArea =
      (shape.type === 'Polygon' || shape.type === 'MultiPolygon') &&
      !classify(f.properties, 'area', 10)
        ? shape
        : undefined;
    if (shape.type !== 'Point' && !shopArea) continue;
    const p = shape.type === 'Point' ? shape.coordinates : interiorPoint(shopArea!);
    if (shopArea) f.geometry = { type: 'Point', coordinates: p };
    const [x, y] = p,
      building = grid
        .get(`${Math.floor(x! / cell)}/${Math.floor(y! / cell)}`)
        ?.find(
          (b) =>
            contains(p, b.geometry) &&
            (!shopArea ||
              difference(
                polygons(shopArea) as Parameters<typeof difference>[0],
                polygons(b.geometry) as Parameters<typeof difference>[0],
              ).length === 0),
        );
    if (!building) continue;
    // Keep the established market class when its mapped shop is a node inside the footprint.
    if (f.properties.shop === 'mall' || f.properties.shop === 'supermarket') {
      building.properties!.shop = String(f.properties.shop);
      if (!building.properties!.name && f.properties.name)
        building.properties!.name = String(f.properties.name);
    }
    const previous = building.properties?.frontage as Frontage | undefined;
    if (!previous || priority[kind] > priority[previous]) building.properties!.frontage = kind;
    f.properties.atlas_in_building = 'yes';
  }
  return { ...osm, features };
}
