import type { Landcover } from '@atlas/shared';
import { describe, expect, it } from 'vitest';
import { applyLandcoverTreeOverrides, landcoverCredits, landcoverFeatures } from './landcover';
import type { AtlasFeature } from '../03-normalize';

const METERS = 111_320;

const pack = (over: Partial<Landcover> = {}): Landcover => ({
  id: 'landcover/test',
  title: 'Test grounds',
  trees: [],
  tree_overrides: [],
  rows: [],
  areas: [],
  status: 'draft',
  credit: 'Tree positions: Example imagery',
  sources: [{ title: 'Example imagery' }],
  ...over,
});

describe('mapped tree appearance corrections', () => {
  const mapped: AtlasFeature = {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [1, 1] },
    properties: { id: 'osm:node/1', class: 'tree', crown: 8, height: 10 },
    tippecanoe: { layer: 'poi', minzoom: 16, maxzoom: 16 },
  };
  it('changes only requested attributes without duplicating or moving a mapped tree', () => {
    const corrections = pack({ tree_overrides: [{ osm_id: 'osm:node/1', crown_m: 22 }] });
    const result = applyLandcoverTreeOverrides([mapped], [corrections]);
    expect(result).toHaveLength(1);
    expect(result[0]!.geometry).toEqual(mapped.geometry);
    expect(result[0]!.properties).toEqual({ ...mapped.properties, crown: 22 });
    expect(mapped.properties.crown).toBe(8);
    expect(landcoverFeatures(result, [corrections]).features).toEqual([]);
  });
  it('fails for missing/non-tree targets and duplicate corrections across packs', () => {
    const corrections = pack({ tree_overrides: [{ osm_id: 'osm:node/1', crown_m: 22 }] });
    expect(() => applyLandcoverTreeOverrides([], [corrections])).toThrow('mapped tree point');
    expect(() =>
      applyLandcoverTreeOverrides(
        [{ ...mapped, properties: { ...mapped.properties, class: 'furniture' } }],
        [corrections],
      ),
    ).toThrow('mapped tree point');
    expect(() => applyLandcoverTreeOverrides([mapped], [corrections, corrections])).toThrow(
      'duplicate',
    );
  });
});

const ring: [number, number][] = [
  [0, 0],
  [50 / METERS, 0],
  [50 / METERS, 50 / METERS],
  [0, 50 / METERS],
  [0, 0],
];

const osmTree = (lng: number, lat: number) => ({
  properties: { id: 'osm:node/1', class: 'tree' },
  geometry: { type: 'Point' as const, coordinates: [lng, lat] },
});

describe('landcoverFeatures', () => {
  it('turns trees, rows, and areas into features the way OSM ones are', () => {
    const { features, warnings } = landcoverFeatures(
      [],
      [
        pack({
          trees: [
            { at: [1, 1], crown_m: 12 },
            { at: [1.001, 1], kind: 'palm' },
          ],
          rows: [{ line: ring.slice(0, 2), kind: 'broadleaved' }],
          areas: [
            { ring, cover: 'woods', kind: 'broadleaved' },
            { ring, cover: 'grass' },
            { ring, cover: 'parking' },
            { ring, cover: 'shrubs' },
          ],
        }),
      ],
    );
    expect(warnings).toEqual([]);
    expect(features.map((f) => [f.properties.id, f.properties.class, f.geometry.type])).toEqual([
      ['cover:test/tree-1', 'tree', 'Point'],
      ['cover:test/tree-2', 'tree', 'Point'],
      ['cover:test/row-1', 'tree', 'LineString'],
      ['cover:test/area-1', 'trees', 'Polygon'],
      ['cover:test/area-2', 'grass', 'Polygon'],
      ['cover:test/area-3', 'parking', 'Polygon'],
      ['cover:test/area-4', 'shrubs', 'Polygon'],
    ]);
    const [measured, palm, row, wood, grass] = features.map((f) => f.properties);
    expect(measured).toMatchObject({ crown: 12, height: 10 });
    expect(measured!.variant).toBeUndefined();
    expect(palm).toMatchObject({ variant: 'palm', crown: 6, height: 12 });
    expect(row).toMatchObject({ variant: 'broadleaved', crown: 8 });
    expect(wood).toMatchObject({ variant: 'broadleaved' });
    expect(wood!.crown).toBeUndefined();
    expect(grass!.variant).toBeUndefined();
    expect(features[0]!.tippecanoe.layer).toBe('poi');
    expect(features.slice(3).map((f) => f.tippecanoe.layer)).toEqual([
      'landuse',
      'landuse',
      'landuse',
      'landuse',
    ]);
    expect(features.at(-1)!.properties).toMatchObject({ class: 'shrubs', detail_blocked: true });
    expect(features.at(-1)!.properties.crown).toBeUndefined();
  });

  it('drops a curated tree once OSM has a tree at the same spot', () => {
    const near = osmTree(1 + 2 / METERS, 1);
    const far = osmTree(1.001 + 10 / METERS, 1);
    const { features, warnings } = landcoverFeatures(
      [near, far],
      [pack({ trees: [{ at: [1, 1] }, { at: [1.001, 1] }] })],
    );
    expect(features.map((f) => f.properties.id)).toEqual(['cover:test/tree-2']);
    expect(warnings).toEqual(['landcover/test tree 1 is now in OSM; remove it from the pack']);
  });

  it('keeps raised soil-and-ground-cover beds blocked without inventing tree crowns', () => {
    const { features } = landcoverFeatures(
      [],
      [pack({ areas: [{ ring, cover: 'planting', raised: true }] })],
    );
    expect(features[0]!.properties).toMatchObject({ class: 'planting', detail_blocked: true });
    expect(features[0]!.properties.crown).toBeUndefined();
    expect(features[0]!.geometry.type).toBe('Polygon');
    expect(features[0]!.tippecanoe.layer).toBe('landuse');
  });

  it('warns about OSM areas of the same class inside a curated area, but keeps it', () => {
    const osmParking = {
      properties: { id: 'osm:way/2', class: 'parking' },
      geometry: {
        type: 'Polygon' as const,
        coordinates: [ring.map(([x, y]) => [x / 2 + 10 / METERS, y / 2 + 10 / METERS])],
      },
    };
    const { features, warnings } = landcoverFeatures(
      [osmParking, osmTree(25 / METERS, 25 / METERS)],
      [
        pack({
          areas: [
            { ring, cover: 'parking' },
            { ring, cover: 'grass' },
          ],
        }),
      ],
    );
    expect(features).toHaveLength(2);
    expect(warnings).toEqual([
      'landcover/test area 1 (parking) has 1 OSM parking areas inside; check it',
    ]);
  });
});

describe('landcoverCredits', () => {
  it('lists each credit once', () => {
    const other = pack({ id: 'landcover/other', credit: 'Survey' });
    expect(landcoverCredits([pack(), pack({ id: 'landcover/b' }), other])).toEqual([
      'Tree positions: Example imagery',
      'Survey',
    ]);
  });
});
