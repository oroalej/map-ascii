import { describe, expect, it } from 'vitest';
import { type Cemetery, type LngLat } from '@atlas/shared';
import { DetailSelectionSchema, SiteDetail } from '@atlas/shared/schemas';
import type { Polygon, MultiPolygon } from 'geojson';
import type { AtlasFeature } from '../03-normalize';
import { burialRow, cemeteryCredits, mergeCemeteries } from './cemeteries';
import { polygonComponents } from './geometry-audit';
import { mergeSiteDetails } from './site-detail';

const at = (x: number, y: number): LngLat => [x / 111_320, y / 111_320];
const rectangle = (x: number, y: number, w: number, h: number): Polygon => ({
  type: 'Polygon',
  coordinates: [[at(x, y), at(x + w, y), at(x + w, y + h), at(x, y + h), at(x, y)]],
});
const parent: AtlasFeature = {
  type: 'Feature',
  geometry: rectangle(0, 0, 100, 100),
  properties: {
    id: 'osm:way/1',
    class: 'grass',
    name: 'Memorial Park',
    kind: 'landuse=cemetery',
    landmark_id: 'landmark/fixture',
    subdivision: 'Ward',
  },
  tippecanoe: { layer: 'landuse', minzoom: 13, maxzoom: 21 },
};
const row: Cemetery['rows'][number] = {
  id: 'north',
  line: [at(10, 50), at(90, 50)],
  count: 9,
  kind: 'slab',
  width_m: 1,
  length_m: 2,
  height_m: 0.3,
};
const pack: Cemetery = {
  id: 'cemetery/fixture',
  osm_id: 'osm:way/1',
  title: 'Fixture cemetery',
  rows: [row],
  status: 'draft',
  credit: 'Fixture credit',
  sources: [{ title: 'Undated reference' }],
};
const parts = (features: AtlasFeature[]) =>
  features.filter((f) => f.properties.id.startsWith('cemetery:'));

describe('burial geometry', () => {
  it('preserves an original OSM name when a curated landmark receives a cemetery title', () => {
    const renamed = {
      ...parent,
      properties: { ...parent.properties, name: 'Curated landmark', osm_name: 'Original OSM name' },
    };
    const result = mergeCemeteries([renamed], [pack]);
    expect(result.features[0]!.properties).toMatchObject({
      name: pack.title,
      osm_name: 'Original OSM name',
    });
  });
  it.each(['paving', 'seating'] as const)(
    'reserves authored %s even with aliased selection',
    (kind) => {
      const target: AtlasFeature = {
        ...parent,
        geometry: { type: 'Point', coordinates: at(50, 50) },
        properties: { id: 'osm:node/2', class: 'monument', landmark_id: 'landmark/alias' },
      };
      const detail = SiteDetail.parse({
        id: 'detail/aisle',
        osm_id: pack.osm_id,
        selection_osm_id: target.properties.id,
        title: 'Aisle',
        surface: 'keep',
        status: 'draft',
        credit: 'Reference',
        sources: [{ title: 'Reference' }],
        structures:
          kind === 'paving'
            ? [
                {
                  id: 'aisle',
                  ring: rectangle(48, 40, 4, 20).coordinates[0],
                  material: 'paving',
                  height_m: 0.03,
                  overhead: false,
                },
              ]
            : [],
        seating:
          kind === 'seating'
            ? [
                {
                  id: 'rim',
                  line: [at(50, 40), at(50, 60)],
                  width_m: 3,
                  height_m: 1,
                  facing: 'left',
                },
              ]
            : [],
      });
      const authored = mergeSiteDetails([parent, target], [detail]);
      const result = mergeCemeteries(authored.features, [pack]);
      expect(result.stats[0]).toMatchObject({ added: 8, blocked: 1 });
    },
  );
  it('places exact dimensions at endpoints, including single-marker midpoint and rotated rows', () => {
    expect(burialRow(row)).toHaveLength(9);
    const single = burialRow({ ...row, count: 1 })[0]!;
    expect(single.coordinates[0]![0]![0]! * 111320).toBeCloseTo(49.5, 4);
    expect(single.coordinates[0]![0]![1]! * 111320).toBeCloseTo(49, 4);
    const vertical = burialRow({ ...row, line: [at(50, 10), at(50, 90)] })[0]!.coordinates[0]!;
    expect(Math.abs(vertical[0]![0]! - vertical[3]![0]!) * 111320).toBeCloseTo(2, 4);
    expect(Math.abs(vertical[0]![1]! - vertical[1]![1]!) * 111320).toBeCloseTo(1, 4);
  });
  it('rejects overlapping markers and overlapping authored rows', () => {
    expect(() => burialRow({ ...row, count: 100 })).toThrow('overlap along');
    expect(() =>
      mergeCemeteries([parent], [{ ...pack, rows: [row, { ...row, id: 'duplicate' }] }]),
    ).toThrow('rows overlap');
  });
  it('preserves mapped geometry and resolves stone parts to cemetery selection', () => {
    const input = structuredClone([parent]);
    const merged = mergeCemeteries(input, [pack]);
    expect(input).toEqual([parent]);
    expect(merged.features[0]!.geometry).toEqual(parent.geometry);
    expect(merged.features[0]!.properties).toMatchObject({
      landmark: true,
      name: 'Fixture cemetery',
      osm_name: 'Memorial Park',
      kind: 'landuse=cemetery',
    });
    expect(parts(merged.features)).toHaveLength(1);
    expect(parts(merged.features)[0]!.properties.id).toBe('cemetery:fixture/north');
    expect(parts(merged.features)[0]!.geometry).toEqual({
      type: 'MultiPolygon',
      coordinates: burialRow(row).map((shape) => shape.coordinates),
    });
    expect(merged.stats[0]).toMatchObject({ added: 9, outside: 0, blocked: 0 });
    for (const f of parts(merged.features)) {
      expect(f.properties).toMatchObject({
        class: 'building_part',
        variant: 'flat',
        kind: 'burial=slab',
        height: 0.3,
        detail_parent: 'osm:way/1',
        detail_blocked: true,
      });
      expect(DetailSelectionSchema.parse(JSON.parse(f.properties.detail_selection!))).toMatchObject(
        {
          id: 'osm:way/1',
          name: 'Fixture cemetery',
          kind: 'landuse=cemetery',
          subdivision: 'Ward',
          landmarkId: 'landmark/fixture',
        },
      );
      expect(f.tippecanoe).toMatchObject({ layer: 'buildings', minzoom: 16 });
    }
    expect(cemeteryCredits([pack, pack])).toEqual(['Fixture credit']);
  });
  it('uses the updated cemetery title and positive source height with absent optional metadata', () => {
    const input: AtlasFeature = {
      ...parent,
      properties: {
        id: parent.properties.id,
        class: 'grass',
        name: 'Old title',
        kind: 'landuse=cemetery',
        height: 4,
      },
    };
    const result = mergeCemeteries([input], [pack]);
    const selection = JSON.parse(
      parts(result.features)[0]!.properties.detail_selection!,
    ) as unknown;
    expect(selection).toEqual({
      id: pack.osm_id,
      class: 'grass',
      name: pack.title,
      kind: 'landuse=cemetery',
      height: 4,
    });
  });
  it('omits whole markers crossing boundaries and holes', () => {
    const holed = structuredClone(parent);
    (holed.geometry as Polygon).coordinates.push(rectangle(48, 40, 4, 20).coordinates[0]!);
    const merged = mergeCemeteries(
      [holed],
      [{ ...pack, rows: [{ ...row, line: [at(0, 50), at(100, 50)], count: 11 }] }],
    );
    expect(merged.stats).toEqual([{ id: pack.id, added: 8, outside: 3, blocked: 0 }]);
  });
  it('detects enclosed holes and concave boundary cuts even when all marker corners are inside', () => {
    const holed = structuredClone(parent);
    (holed.geometry as Polygon).coordinates.push(rectangle(49.9, 49.9, 0.2, 0.2).coordinates[0]!);
    expect(mergeCemeteries([holed], [pack]).stats[0]).toMatchObject({ added: 8, outside: 1 });
    const concave = structuredClone(parent);
    concave.geometry = {
      type: 'Polygon',
      coordinates: [
        [
          at(0, 0),
          at(100, 0),
          at(100, 100),
          at(50.1, 100),
          at(50.1, 49.9),
          at(49.9, 49.9),
          at(49.9, 100),
          at(0, 100),
          at(0, 0),
        ],
      ],
    };
    expect(mergeCemeteries([concave], [pack]).stats[0]).toMatchObject({ added: 8, outside: 1 });
  });
  it.each(['building', 'water_area'] as const)('excludes mapped %s footprints', (cls) => {
    const obstacle: AtlasFeature = {
      ...parent,
      geometry: rectangle(48, 40, 4, 20),
      properties: { id: 'osm:way/2', class: cls, height: 6 },
    };
    const merged = mergeCemeteries([parent, obstacle], [pack]);
    expect(merged.stats[0]).toMatchObject({ added: 8, blocked: 1 });
    expect(merged.features[1]).toEqual(obstacle);
  });
  it.each(['paving', 'pitch'] as const)(
    'clears owned %s aisles while retaining marker statistics',
    (cls) => {
      const aisle: AtlasFeature = {
        ...parent,
        geometry: rectangle(48, 40, 4, 20),
        properties: { id: 'detail:fixture/north-aisle', class: cls, detail_parent: pack.osm_id },
      };
      const merged = mergeCemeteries([parent, aisle], [pack]);
      expect(merged.stats[0]).toMatchObject({ added: 8, blocked: 1 });
      expect(parts(merged.features)).toHaveLength(1);
      expect(polygonComponents(parts(merged.features)[0]!.geometry as MultiPolygon)).toEqual(
        burialRow(row).filter((_, i) => i !== 4),
      );
      expect(merged.features[1]).toEqual(aisle);
      expect(
        mergeCemeteries(
          [parent, { ...aisle, properties: { ...aisle.properties, detail_overhead: true } }],
          [pack],
        ).stats[0],
      ).toMatchObject({
        added: 9,
        blocked: 0,
      });
      expect(
        mergeCemeteries(
          [
            parent,
            {
              ...aisle,
              properties: { ...aisle.properties, detail_parent: 'osm:way/another-cemetery' },
            },
          ],
          [pack],
        ).stats[0],
      ).toMatchObject({ added: 8, blocked: 1 });
    },
  );
  it('clears full road width, curved joints, end caps and tree trunks', () => {
    const road: AtlasFeature = {
      ...parent,
      geometry: { type: 'LineString', coordinates: [at(46, 0), at(46, 50), at(70, 80)] },
      properties: { id: 'osm:way/2', class: 'road_minor', width: 10 },
    };
    const tree: AtlasFeature = {
      ...parent,
      geometry: { type: 'Point', coordinates: at(10, 50) },
      properties: { id: 'osm:node/3', class: 'tree', height: 10 },
    };
    const merged = mergeCemeteries([parent, road, tree], [pack]);
    expect(merged.stats[0]).toMatchObject({ added: 7, blocked: 2 });
    expect(
      polygonComponents(parts(merged.features)[0]!.geometry as MultiPolygon),
    ).not.toContainEqual(burialRow(row)[4]);
  });
  it('retains zero-height flush plaques and supports graveyard/multipolygon parents', () => {
    const g = parent.geometry as Polygon;
    const graveyard: AtlasFeature = {
      ...parent,
      geometry: { type: 'MultiPolygon', coordinates: [g.coordinates] },
      properties: { ...parent.properties, kind: 'amenity=grave_yard' },
    };
    expect(
      parts(
        mergeCemeteries([graveyard], [{ ...pack, rows: [{ ...row, kind: 'flush', height_m: 0 }] }])
          .features,
      ).every((f) => f.properties.height === 0),
    ).toBe(true);
  });
  it('fails loudly for missing/wrong parents, empty rows and duplicate targets', () => {
    expect(() => mergeCemeteries([], [pack])).toThrow('missing cemetery');
    expect(() =>
      mergeCemeteries(
        [{ ...parent, properties: { ...parent.properties, kind: 'leisure=garden' } }],
        [pack],
      ),
    ).toThrow('not a mapped cemetery');
    expect(() =>
      mergeCemeteries(
        [parent],
        [{ ...pack, rows: [{ ...row, line: [at(110, 50), at(190, 50)] }] }],
      ),
    ).toThrow('no burial markers');
    expect(() => mergeCemeteries([parent], [pack, pack])).toThrow('same mapped area');
  });
});
