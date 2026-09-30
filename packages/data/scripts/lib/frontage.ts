import bbox from '@turf/bbox';
import pointInPolygon from '@turf/boolean-point-in-polygon';
import type { Feature, FeatureCollection, Polygon, MultiPolygon, Point } from 'geojson';
import type { Tags } from './classify';
export type Frontage = 'food' | 'retail' | 'service' | 'commercial';
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
/** Resolve shop nodes while raw tags still exist, before normalization discards them. */
export function assignFrontages(osm: FeatureCollection): FeatureCollection {
  const features = osm.features.map((f) => ({ ...f, properties: { ...f.properties } }));
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
  for (const f of features) {
    if (f.geometry.type !== 'Point') continue;
    const kind = frontageOf(f.properties);
    if (!kind) continue;
    const [x, y] = f.geometry.coordinates,
      building = grid
        .get(`${Math.floor(x! / cell)}/${Math.floor(y! / cell)}`)
        ?.find((b) => pointInPolygon(f as Feature<Point>, b));
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
