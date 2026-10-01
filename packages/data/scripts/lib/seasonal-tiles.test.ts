import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { SeasonConfig, SeasonalRecord } from '@atlas/shared';
import { archive, archiveBytes, baseTiles, road, type TestTile } from './utility-tiles.fixture';
import { auditSeasonalArchive, buildSeasonalTiles } from './seasonal-tiles';
import { tippecanoe } from './tippecanoe';
vi.mock('./tippecanoe', () => ({ tippecanoe: vi.fn() }));
const row: SeasonalRecord = {
  version: 1,
  kind: 'bunting',
  id: 'r',
  season: 'feast',
  corridor: 'route',
  road: 'osm:way/1',
  from: [0.001, -0.001],
  to: [0.001, -0.0011],
  segment: [
    [0.001, -0.001],
    [0.009, -0.001],
  ],
  seed: 7,
};
const withRows = (records: SeasonalRecord[] = [row]): TestTile[] =>
  baseTiles.map((t) => ({
    ...t,
    layers: {
      ...t.layers,
      utilities: {
        features: [{ id: 99, type: 1, points: [[100, 100]], properties: { utility: 'unchanged' } }],
      },
      ...(t.tile.z === 16
        ? {
            seasons: {
              features: records.map((r, i) => ({
                id: i + 1,
                type: 2,
                properties: { seasonal: JSON.stringify(r) },
                points: [
                  [100, 100],
                  [100, 200],
                ] as [number, number][],
              })),
            },
          }
        : {}),
    },
  }));
const base = () =>
  withRows([]).map((t) => ({
    ...t,
    layers: Object.fromEntries(Object.entries(t.layers).filter(([k]) => k !== 'seasons')),
  }));
const dirs: string[] = [];
afterEach(async () => {
  vi.mocked(tippecanoe).mockReset();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
it('audits identical buffered copies while preserving every ordinary layer and utility', async () => {
  expect(await auditSeasonalArchive(archive(base()), archive(withRows()), [row])).toEqual({
    tiles: 2,
    records: 1,
  });
  for (const changed of [
    withRows().map((t) => ({
      ...t,
      layers: { ...t.layers, roads: { features: [road(1, 'road_minor')] } },
    })),
    withRows().map((t) => ({ ...t, layers: { ...t.layers, utilities: { features: [] } } })),
    withRows().slice(1),
  ])
    await expect(auditSeasonalArchive(archive(base()), archive(changed), [row])).rejects.toThrow(
      /changed base geometry|lost tile/,
    );
});
it('rejects missing or changed rows, duplicate identities, malformed records and changed bounds', async () => {
  await expect(auditSeasonalArchive(archive(base()), archive(withRows([])), [row])).rejects.toThrow(
    'Tiling lost',
  );
  await expect(
    auditSeasonalArchive(archive(base()), archive(withRows([{ ...row, seed: 8 }])), [row]),
  ).rejects.toThrow('Unexpected or changed');
  await expect(
    auditSeasonalArchive(archive(base()), archive(withRows()), [row, row]),
  ).rejects.toThrow('Duplicate');
  await expect(
    auditSeasonalArchive(archive(base()), archive(withRows([{ ...row, seed: -1 }])), [row]),
  ).rejects.toThrow();
  const output = archive(withRows()),
    header = await output.getHeader();
  vi.spyOn(output, 'getHeader').mockResolvedValue({ ...header, maxLon: header.maxLon + 1 });
  await expect(auditSeasonalArchive(archive(base()), output, [row])).rejects.toThrow('maxLon');
});
it('copies no-corridor archives byte-for-byte without external tools', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atlas-seasons-'));
  dirs.push(dir);
  const input = join(dir, 'base.pmtiles'),
    output = join(dir, 'out.pmtiles'),
    merged = join(dir, 'merged.geojsonl');
  const bytes = archiveBytes(base());
  await writeFile(input, bytes);
  await writeFile(merged, '\n');
  await buildSeasonalTiles(input, output, merged, undefined, dir);
  expect(new Uint8Array(await readFile(output))).toEqual(bytes);
  expect(tippecanoe).not.toHaveBeenCalled();
});
it('merges the optional layer without dropping rows and restores the original archive header', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atlas-seasons-'));
  dirs.push(dir);
  const input = join(dir, 'base.pmtiles'),
    output = join(dir, 'out.pmtiles'),
    merged = join(dir, 'merged.geojsonl');
  await writeFile(input, archiveBytes(base()));
  await writeFile(
    merged,
    JSON.stringify({
      type: 'Feature',
      properties: { id: 'osm:way/1', class: 'road_mid', width: 8 },
      geometry: {
        type: 'LineString',
        coordinates: [
          [0.001, -0.001],
          [0.009, -0.001],
        ],
      },
    }) + '\n',
  );
  const season: SeasonConfig = {
    id: 'feast',
    title: { en: 'Feast' },
    status: 'draft',
    sources: [],
    window: { from: { month: 9, day: 1 }, to: { month: 9, day: 20 } },
    bunting: {
      label: 'Banderitas',
      near: ['worship'],
      radius_m: 400,
      spacing_m: 30,
      corridors: [
        { id: 'route', ways: ['osm:way/1'], spacing_m: 6, style: 'red-yellow-rectangles' },
      ],
    },
  };
  vi.mocked(tippecanoe).mockImplementation((_in, target, _args, second) => {
    const records = readFileSync(join(dir, 'seasons.geojsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => {
        const feature = JSON.parse(line) as { properties: { seasonal: string } };
        return JSON.parse(feature.properties.seasonal) as SeasonalRecord;
      });
    const bytes = archiveBytes(withRows(records));
    if (second) new DataView(bytes.buffer).setInt32(102, -1000000, true);
    writeFileSync(target, bytes);
  });
  await buildSeasonalTiles(input, output, merged, [season], dir);
  expect(tippecanoe).toHaveBeenCalledTimes(2);
  expect(vi.mocked(tippecanoe).mock.calls[0]![2]).toEqual(
    expect.arrayContaining(['--no-feature-limit', '--no-tile-size-limit', '--minimum-zoom=16']),
  );
  const report = JSON.parse(await readFile(join(dir, 'seasons-report.json'), 'utf8')) as {
    audit: { records: number };
  };
  expect(report.audit.records).toBeGreaterThan(100);
});
