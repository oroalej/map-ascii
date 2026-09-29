import type { Landcover } from '@atlas/shared';
import { describe, expect, it } from 'vitest';
import { landcoverCredits, landcoverFeatures } from './landcover';

const METERS = 111_320;

const pack = (over: Partial<Landcover> = {}): Landcover => ({
  id: 'landcover/test',
  title: 'Test grounds',
  trees: [],
  rows: [],
  areas: [],
  status: 'draft',
  credit: 'Tree positions: Example imagery',
  sources: [{ title: 'Example imagery' }],
  ...over,
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
    ]);
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
