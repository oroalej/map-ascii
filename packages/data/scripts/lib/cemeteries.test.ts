import { describe, expect, it } from 'vitest';
import { DetailSelectionSchema, type Cemetery, type LngLat } from '@atlas/shared';
import type { Polygon } from 'geojson';
import type { AtlasFeature } from '../03-normalize';
import { burialRow, cemeteryCredits, mergeCemeteries } from './cemeteries';

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
    expect(parts(merged.features).some((f) => f.properties.id.endsWith('north-5'))).toBe(false);
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
