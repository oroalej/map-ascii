import { REGION_TILE_MAX_ZOOM } from '@atlas/shared';
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import { clipToRegion, normalize } from './03-normalize';

const square = (w: number, s: number, e: number, n: number): Polygon => ({
  type: 'Polygon',
  coordinates: [
    [
      [w, s],
      [e, s],
      [e, n],
      [w, n],
      [w, s],
    ],
  ],
});

const boundary: Feature<Polygon | MultiPolygon> = {
  type: 'Feature',
  id: 'relation/1',
  properties: { name: 'Test City', boundary: 'administrative', admin_level: '6' },
  geometry: square(0, 0, 0.01, 0.01),
};

const road = (id: string, highway: string, x: number): Feature => ({
  type: 'Feature',
  id,
  properties: { highway },
  geometry: {
    type: 'LineString',
    coordinates: [
      [x, 0],
      [x, 0.01],
    ],
  },
});

const collection = (...features: Feature[]): FeatureCollection => ({
  type: 'FeatureCollection',
  features,
});
it('keeps event access/bridge metadata and separates path clearance from ordinary widths', () => {
  const street = road('way/road', 'residential', 0.002),
    path = road('way/path', 'footway', 0.004);
  street.properties = {
    ...street.properties,
    width: '8',
    foot: 'yes',
    access: 'private',
    vehicle: 'no',
    motor_vehicle: 'yes',
    motorcar: 'no',
    motorcycle: 'yes',
    hgv: 'no',
    bridge: 'yes',
  };
  path.properties = { ...path.properties, width: '5', foot: 'yes' };
  const records = normalize(collection(street, path), boundary, 10).features;
  expect(records.find((f) => f.properties.id === 'osm:way/road')?.properties).toMatchObject({
    width: 8,
    foot: 'yes',
    access: 'private',
    vehicle: 'no',
    motor_vehicle: 'yes',
    motorcar: 'no',
    motorcycle: 'yes',
    hgv: 'no',
    bridge: 'yes',
  });
  const walking = records.find((f) => f.properties.id === 'osm:way/path')!.properties;
  expect(walking.event_path_width).toBe(5);
  expect(walking.width).toBeUndefined();
});

it('preserves hospital footprints, identity and roof metadata while distinguishing heightless grounds', () => {
  const roof: Feature = {
    type: 'Feature',
    id: 'way/hospital',
    properties: { building: 'hospital', name: 'Hospital', height: '12', 'roof:shape': 'flat' },
    geometry: square(0.003, 0.003, 0.004, 0.004),
  };
  const grounds: Feature = {
    type: 'Feature',
    id: 'way/grounds',
    properties: { amenity: 'hospital' },
    geometry: square(0.002, 0.002, 0.005, 0.005),
  };
  const features = normalize(collection(roof, grounds), boundary, 10).features;
  expect(features.find((f) => f.properties.id === 'osm:way/hospital')).toMatchObject({
    geometry: roof.geometry,
    properties: { class: 'building_hospital', name: 'Hospital', height: 12, variant: 'flat' },
    tippecanoe: { layer: 'buildings', minzoom: 12, maxzoom: 16 },
  });
  const ground = features.find((f) => f.properties.id === 'osm:way/grounds')!;
  expect(ground.geometry).toEqual(grounds.geometry);
  expect(ground.properties.class).toBe('building_hospital');
  expect(ground.properties.height).toBeUndefined();
});

it('retains shop areas as anchored markers and ignores raw frontage annotations', () => {
  const shop: Feature = {
    type: 'Feature',
    id: 'way/shop',
    properties: { amenity: 'bank', name: 'Bank' },
    geometry: square(0.002, 0.002, 0.003, 0.003),
  };
  const building: Feature = {
    type: 'Feature',
    id: 'way/building',
    properties: { building: 'yes', frontage: 'invented' },
    geometry: square(0.005, 0.005, 0.006, 0.006),
  };
  const features = normalize(collection(shop, building), boundary, 10).features;
  expect(features.find((f) => f.properties.id === 'osm:way/shop')).toMatchObject({
    geometry: { type: 'Point', coordinates: [0.0025, 0.0025] },
    properties: {
      name: 'Bank',
      class: 'furniture',
      variant: 'shop_service',
      shop_lng: 0.0025,
      shop_lat: 0.0025,
      shop_radius_m: 5,
    },
  });
  expect(
    features.find((f) => f.properties.id === 'osm:way/building')!.properties.frontage,
  ).toBeUndefined();
});

it('retains road tags and directed stop anchors through normalization', () => {
  const tagged = road('way/10', 'secondary', 0.005);
  tagged.properties = {
    ...tagged.properties,
    sidewalk: 'both',
    'sidewalk:left:width': '1.5',
    oneway: '-1',
  };
  const stop: Feature = {
    type: 'Feature',
    id: 'node/11',
    geometry: { type: 'Point', coordinates: [0.005, 0] },
    properties: { highway: 'stop', direction: 'forward' },
  };
  const { features } = normalize(collection(tagged, stop), boundary, 10);
  expect(features.find((f) => f.properties.id === 'osm:way/10')?.properties).toMatchObject({
    sidewalk: 'both',
    sidewalk_left_width: 1.5,
    sidewalk_right_width: 2,
    sidewalk_src: 'mapped',
    oneway: -1,
  });
  expect(features.find((f) => f.properties.id === 'osm:node/11')?.properties).toMatchObject({
    variant: 'traffic_stop',
    stop_direction: 'forward',
  });
});

describe('normalize: region-only features', () => {
  const { features } = normalize(collection(road('way/1', 'primary', 0.005)), boundary, 10, {
    osm: collection(road('way/1', 'primary', 0.005), road('way/2', 'trunk', 0.5)),
    derived: [
      {
        type: 'Feature',
        properties: { id: 'sea/1', class: 'water_sea' },
        geometry: square(1, 1, 2, 2),
      },
    ],
  });
  const byId = (id: string) => features.find((f) => f.properties.id === id)!;

  it('flags them and tiles them only to the region zoom', () => {
    for (const id of ['osm:way/2', 'sea/1']) {
      expect(byId(id).properties.region).toBe(true);
      expect(byId(id).tippecanoe.maxzoom).toBe(REGION_TILE_MAX_ZOOM);
    }
  });

  it('leaves detail features (even ones the region also has) at full depth', () => {
    const detail = byId('osm:way/1');
    expect(detail.properties.region).toBeUndefined();
    expect(detail.tippecanoe.maxzoom).toBe(16);
    expect(features.filter((f) => f.properties.id === 'osm:way/1')).toHaveLength(1);
  });
});

describe('clipToRegion', () => {
  it('drops features wholly outside the region and keeps those reaching into it', () => {
    const inside = road('way/1', 'primary', 0.005);
    const crossing: Feature = {
      ...road('way/2', 'primary', 0),
      geometry: {
        type: 'LineString',
        coordinates: [
          [-1, 0.005],
          [0.005, 0.005],
        ],
      },
    };
    const outside = road('way/3', 'primary', 5);
    const clipped = clipToRegion(collection(inside, crossing, outside), [0, 0, 0.01, 0.01]);
    expect(clipped.features.map((f) => f.id)).toEqual(['way/1', 'way/2']);
  });
});
