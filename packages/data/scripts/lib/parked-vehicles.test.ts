import { SiteDetail, type LngLat } from '@atlas/shared';
import { describe, expect, it } from 'vitest';
import type { AtlasFeature } from '../03-normalize';
import { mergeSiteDetails } from './site-detail';
import { parkedVehicleParts } from './parked-vehicles';
import { detailLayoutKey } from './detail-layout';

const m = 111_320;
const p = (x: number, y: number): LngLat => [x / m, y / m];
const ring = [p(0, 0), p(50, 0), p(50, 50), p(0, 50), p(0, 0)];
const parent: AtlasFeature = {
  type: 'Feature',
  geometry: { type: 'Polygon', coordinates: [ring] },
  properties: { id: 'osm:way/1', class: 'building_school', landmark_id: 'landmark/test' },
  tippecanoe: { layer: 'buildings', minzoom: 12, maxzoom: 16 },
};
const base = {
  id: 'detail/test',
  osm_id: parent.properties.id,
  title: 'Test school',
  surface: 'keep',
  status: 'draft',
  credit: 'Test reference',
  sources: [{ title: 'Reference' }],
};
const car = { id: 'one', at: p(15, 15), bearing: 0, kind: 'car' as const };
const bus = { id: 'bus', at: p(30, 30), bearing: 90, kind: 'bus' as const };

describe('fixed plan-view parking', () => {
  it('rejects a road corridor whose centreline is outside the site', () => {
    const road: AtlasFeature = {
      ...parent,
      properties: { id: 'osm:way/outside-road', class: 'road_minor', width: 6 },
      geometry: { type: 'LineString', coordinates: [p(0, 51), p(0, 51), p(50, 51)] },
    };
    const pack = SiteDetail.parse({
      ...base,
      parked_vehicles: [{ ...car, at: p(25, 47.4), bearing: 90 }],
    });
    expect(() => mergeSiteDetails([parent, road], [pack])).toThrow('crosses osm:way/outside-road');
    expect(() =>
      mergeSiteDetails([parent, road], [{ ...pack, parked_vehicles: [{ ...car, at: p(25, 40) }] }]),
    ).not.toThrow();
  });
  it('retains bend and endpoint clearance when distant road segments are skipped', () => {
    const road: AtlasFeature = {
      ...parent,
      properties: { id: 'osm:way/road', class: 'road_minor', width: 6 },
      geometry: { type: 'LineString', coordinates: [p(-1000, 20), p(20, 20), p(20, 30)] },
    };
    const pack = (at: LngLat) => SiteDetail.parse({ ...base, parked_vehicles: [{ ...car, at }] });
    expect(() => mergeSiteDetails([parent, road], [pack(p(35, 40))])).not.toThrow();
    expect(() => mergeSiteDetails([parent, road], [pack(p(22, 22))])).toThrow('crosses');
    expect(() => mergeSiteDetails([parent, road], [pack(p(20, 34))])).toThrow('crosses');
    expect(road.geometry).toEqual({
      type: 'LineString',
      coordinates: [p(-1000, 20), p(20, 20), p(20, 30)],
    });
  });
  it('validates unique bounded inventory and keeps legacy fingerprints when omitted', () => {
    const input = { ...base, parked_vehicles: [car, bus] };
    expect(SiteDetail.safeParse(input).success).toBe(true);
    for (const parked_vehicles of [
      [car, car],
      [{ ...car, kind: 'train' }],
      [{ ...car, bearing: 360 }],
      Array.from({ length: 201 }, (_, i) => ({ ...car, id: `car-${i}` })),
    ])
      expect(SiteDetail.safeParse({ ...base, parked_vehicles }).success).toBe(false);
    expect(detailLayoutKey(base)).toBe(detailLayoutKey({ ...base, parked_vehicles: [] }));
    expect(detailLayoutKey(base)).not.toBe(detailLayoutKey(input));
    expect(detailLayoutKey(input)).not.toBe(
      detailLayoutKey({ ...input, parked_vehicles: [{ ...car, bearing: 90 }, bus] }),
    );
  });
  it('uses metric car/bus dimensions and rotates the complete silhouettes', () => {
    for (const vehicle of [car, bus]) {
      const parts = parkedVehicleParts(vehicle);
      expect(parts).toHaveLength(7);
      const body = parts[0]!;
      const xs = body.ring.map(([x]) => x * m),
        ys = body.ring.map(([, y]) => y * m);
      expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(vehicle.kind === 'bus' ? 10 : 1.8, 5);
      expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(vehicle.kind === 'bus' ? 2.5 : 4.4, 5);
      expect(parts.filter((p) => p.id.includes('wheel-'))).toHaveLength(4);
    }
  });
  it('emits static selectable obstacles without a new building or Life activity identity', () => {
    const input = structuredClone([parent]);
    const out = mergeSiteDetails(input, [
      SiteDetail.parse({ ...base, parked_vehicles: [car, bus] }),
    ]).features;
    expect(input).toEqual([parent]);
    const vehicles = out.filter((f) => f.properties.kind?.startsWith('parked_vehicle='));
    expect(vehicles).toHaveLength(14);
    for (const f of vehicles) {
      expect(f.properties).toMatchObject({
        detail_parent: parent.properties.id,
        detail_blocked: true,
        detail_overhead: false,
      });
      expect(f.properties.landmark_id).toBeUndefined();
      expect(f.properties.life_site).toBeUndefined();
      expect(f.properties.class).not.toBe('building');
    }
    expect(out.find((f) => f.properties.id === parent.properties.id)?.geometry).toEqual(
      parent.geometry,
    );
  });
  it('rejects roofs, exterior wheels, overlaps and walks through parked bodies', () => {
    const pack = SiteDetail.parse({ ...base, parked_vehicles: [car] });
    const obstacle: AtlasFeature = {
      ...parent,
      properties: { id: 'osm:way/2', class: 'building', height: 6 },
      geometry: { type: 'Polygon', coordinates: [parkedVehicleParts(car)[0]!.ring] },
    };
    expect(() => mergeSiteDetails([parent, obstacle], [pack])).toThrow('crosses');
    expect(() =>
      mergeSiteDetails([parent], [{ ...pack, parked_vehicles: [{ ...car, at: p(0.95, 15) }] }]),
    ).toThrow('outside');
    expect(() =>
      mergeSiteDetails([parent], [{ ...pack, parked_vehicles: [car, { ...car, id: 'two' }] }]),
    ).toThrow('overlapping');
    expect(() =>
      mergeSiteDetails(
        [parent],
        [{ ...pack, walks: [{ id: 'walk', line: [p(5, 15), p(25, 15)], width_m: 2 }] }],
      ),
    ).toThrow('crosses');
    const road: AtlasFeature = {
      ...parent,
      properties: { id: 'osm:way/3', class: 'road_minor', width: 6 },
      geometry: { type: 'LineString', coordinates: [p(0, 15), p(50, 15)] },
    };
    expect(() => mergeSiteDetails([parent, road], [pack])).toThrow('crosses');
    const water: AtlasFeature = {
      ...obstacle,
      properties: { id: 'osm:way/4', class: 'water_area' },
    };
    expect(() => mergeSiteDetails([parent, water], [pack])).toThrow('crosses');
    // Bodies clear one another, but projecting wheels cannot occupy the same bay.
    expect(() =>
      mergeSiteDetails(
        [parent],
        [{ ...pack, parked_vehicles: [car, { ...car, id: 'two', at: p(16.95, 15) }] }],
      ),
    ).toThrow('overlapping');
  });
  it('confines a campus detail extent without changing the complete source boundary', () => {
    const extent = [p(5, 5), p(25, 5), p(25, 25), p(5, 25), p(5, 5)];
    const pack = SiteDetail.parse({ ...base, extent, parked_vehicles: [car] });
    const output = mergeSiteDetails([parent], [pack]).features;
    expect(output.find((f) => f.properties.id === parent.properties.id)?.geometry).toEqual(
      parent.geometry,
    );
    const paved = mergeSiteDetails([parent], [{ ...pack, surface: 'paving' }]).features;
    expect(paved.find((f) => f.properties.id === parent.properties.id)?.properties.class).toBe(
      parent.properties.class,
    );
    expect(
      JSON.parse(
        paved.find((f) => f.properties.id.endsWith('/grounds'))!.properties.detail_selection!,
      ),
    ).toMatchObject({
      id: parent.properties.id,
      class: parent.properties.class,
      landmarkId: 'landmark/test',
    });
    expect(() =>
      mergeSiteDetails([parent], [{ ...pack, extent: ring.map(([x, y]) => [x - 0.001, y]) }]),
    ).toThrow('extent must fit');
    expect(SiteDetail.safeParse({ ...pack, grounds: ring }).success).toBe(false);
    expect(detailLayoutKey({ ...base, extent })).not.toBe(detailLayoutKey(base));
    expect(() => mergeSiteDetails([parent], [{ ...pack, parked_vehicles: [bus] }])).toThrow(
      'outside',
    );
  });
});
