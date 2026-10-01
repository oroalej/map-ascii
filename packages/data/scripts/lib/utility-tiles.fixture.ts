import { PbfWriter } from 'pbf';
import { PMTiles, zxyToTileId } from 'pmtiles';
import type { TileAddress } from '@atlas/shared';

export type TestFeature = {
  id: number;
  type: number;
  properties: Record<string, string | number | boolean>;
  points: [number, number][];
};
export type TestLayer = { extent?: number; features: TestFeature[] };
export type TestTile = { tile: TileAddress; layers: Record<string, TestLayer> };
export const tile = { z: 16, x: 32768, y: 32768 };
export const parent = { z: 15, x: 16384, y: 16384 };
export const other = { ...tile, x: tile.x + 1 };
export const road = (id: number, cls = 'road_major', extra = {}): TestFeature => ({
  id,
  type: 2,
  properties: { id: `osm:way/${id}`, class: cls, width: 8, ...extra },
  points: [
    [100, 1000],
    [3500, 1000],
  ],
});
export const roads: Record<string, TestLayer> = {
  roads: {
    features: [
      road(1),
      {
        ...road(2, 'road_mid'),
        points: [
          [100, 3000],
          [3500, 3000],
        ],
      },
    ],
  },
};
export const baseTiles: TestTile[] = [
  { tile: parent, layers: roads },
  { tile, layers: roads },
  { tile: other, layers: roads },
];

/** Tiny uncompressed MVT fixtures: exercise the real decoders, without installing CLI tools. */
export function encodeTile(layers: Record<string, TestLayer>): Uint8Array {
  const out = new PbfWriter();
  for (const [name, layer] of Object.entries(layers))
    out.writeMessage(
      3,
      (_, pbf) => {
        pbf.writeStringField(1, name);
        const keys = [...new Set(layer.features.flatMap((f) => Object.keys(f.properties)))];
        const values = layer.features.flatMap((f) => Object.values(f.properties));
        let valueIndex = 0;
        for (const feature of layer.features)
          pbf.writeMessage(
            2,
            (_, f) => {
              f.writeVarintField(1, feature.id);
              f.writePackedVarint(
                2,
                Object.keys(feature.properties).flatMap((key) => [keys.indexOf(key), valueIndex++]),
              );
              f.writeVarintField(3, feature.type);
              const geometry: number[] = [];
              let x = 0,
                y = 0;
              for (const [i, point] of feature.points.entries()) {
                if (i === 0) geometry.push(9);
                else if (i === 1) geometry.push(((feature.points.length - 1) << 3) | 2);
                geometry.push(
                  ((point[0] - x) << 1) ^ ((point[0] - x) >> 31),
                  ((point[1] - y) << 1) ^ ((point[1] - y) >> 31),
                );
                [x, y] = point;
              }
              f.writePackedVarint(4, geometry);
            },
            undefined,
          );
        for (const key of keys) pbf.writeStringField(3, key);
        for (const value of values)
          pbf.writeMessage(
            4,
            (_, v) => {
              if (typeof value === 'string') v.writeStringField(1, value);
              else if (typeof value === 'boolean') v.writeBooleanField(7, value);
              else v.writeDoubleField(3, value);
            },
            undefined,
          );
        pbf.writeVarintField(5, layer.extent ?? 4096);
        pbf.writeVarintField(15, 2);
      },
      undefined,
    );
  return out.finish();
}

/** A real PMTiles v3 header and root directory with isolated, uncompressed test tiles. */
export function archiveBytes(tiles: TestTile[]): Uint8Array {
  const entries = tiles
    .map((t) => ({ id: zxyToTileId(t.tile.z, t.tile.x, t.tile.y), data: encodeTile(t.layers) }))
    .sort((a, b) => a.id - b.id);
  const directory = new PbfWriter();
  directory.writeVarint(entries.length);
  let previous = 0,
    offset = 0;
  for (const e of entries) {
    directory.writeVarint(e.id - previous);
    previous = e.id;
  }
  for (const _ of entries) {
    void _;
    directory.writeVarint(1);
  }
  for (const e of entries) directory.writeVarint(e.data.length);
  for (const e of entries) {
    directory.writeVarint(offset + 1);
    offset += e.data.length;
  }
  const root = directory.finish();
  const dataOffset = 127 + root.length + 2;
  const bytes = new Uint8Array(dataOffset + offset);
  bytes.set(new TextEncoder().encode('PMTiles'), 0);
  bytes[7] = 3;
  const h = new DataView(bytes.buffer);
  for (const [at, value] of [
    [8, 127],
    [16, root.length],
    [24, 127 + root.length],
    [32, 2],
    [56, dataOffset],
    [64, offset],
    [72, entries.length],
    [80, entries.length],
    [88, entries.length],
  ])
    h.setBigUint64(at!, BigInt(value!), true);
  bytes.set([1, 1, 1, 1, 15, 16], 96); // clustered, compression, MVT, zoom bounds
  h.setInt32(106, -50000, true);
  h.setInt32(110, 100000, true);
  bytes[118] = 16;
  bytes.set(root, 127);
  bytes.set(new TextEncoder().encode('{}'), 127 + root.length);
  offset = dataOffset;
  for (const e of entries) {
    bytes.set(e.data, offset);
    offset += e.data.length;
  }
  return bytes;
}
let sourceId = 0;
export function archive(tiles: TestTile[]): PMTiles {
  const bytes = archiveBytes(tiles),
    key = `fixture-${sourceId++}`;
  return new PMTiles({
    getKey: () => key,
    getBytes: (offset, length) =>
      Promise.resolve({ data: bytes.slice(offset, offset + length).buffer }),
  });
}
