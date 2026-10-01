import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { UtilityRecordSchema, type UtilityRecord, type UtilityPole } from '@atlas/shared';
import { auditUtilityArchive, buildUtilityTiles, openUtilityArchive } from './utility-tiles';
import { tippecanoe } from './tippecanoe';
import { step } from '../05-tiles';
import type { StepContext } from '../step';
import { readJson } from './io';

import {
  archive,
  archiveBytes,
  baseTiles,
  road,
  roads,
  type TestLayer,
  type TestFeature,
  type TestTile,
} from './utility-tiles.fixture';

vi.mock('./tippecanoe', () => ({ tippecanoe: vi.fn() }));

const generatedRecords = (path: string): UtilityRecord[] =>
  readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => {
      const feature = JSON.parse(line) as { properties: { utility: string } };
      return UtilityRecordSchema.parse(JSON.parse(feature.properties.utility));
    });

const pole: UtilityPole = {
  id: 'a',
  road: 'osm:way/1',
  component: '1/0',
  at: [0.001, -0.001],
  heading: [1, 0],
  normal: [0, 1],
  transformer: false,
};
const second: UtilityPole = { ...pole, id: 'b', at: [0.0013, -0.001] };
const records: UtilityRecord[] = [
  { version: 1, kind: 'pole', pole },
  { version: 1, kind: 'pole', pole: second },
  {
    version: 1,
    kind: 'span',
    span: { id: 's', kind: 'corridor', from: pole, to: second, seed: 7 },
  },
];
const utilityLayer = (records: readonly UtilityRecord[]): TestLayer => ({
  features: records.map((r, i) => ({
    id: i + 1,
    type: 1,
    properties: { utility: JSON.stringify(r) },
    points: [[100, 100]],
  })),
});
const withRecords = (values = records): TestTile[] =>
  baseTiles.map((t) => ({
    ...t,
    layers: t.tile.z === 16 ? { ...t.layers, utilities: utilityLayer(values) } : t.layers,
  }));
const dirs: string[] = [];
afterEach(async () => {
  vi.mocked(tippecanoe).mockReset();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it('audits every zoom and accepts identical buffered record copies', async () => {
  expect(await auditUtilityArchive(archive(baseTiles), archive(withRecords()), records)).toEqual({
    tiles: 2,
    records: 3,
  });
});
it('rejects missing, changed and duplicate expected utility identities', async () => {
  const base = archive(baseTiles);
  await expect(
    auditUtilityArchive(base, archive(withRecords(records.slice(1))), records),
  ).rejects.toThrow('Tiling lost utility a');
  await expect(
    auditUtilityArchive(
      base,
      archive(withRecords([{ version: 1, kind: 'pole', pole: { ...pole, transformer: true } }])),
      records,
    ),
  ).rejects.toThrow('Unexpected or changed utility');
  await expect(
    auditUtilityArchive(base, archive(withRecords()), [...records, records[0]!]),
  ).rejects.toThrow('Duplicate generated');
});
it('rejects geometry, properties, feature order and missing ordinary tiles', async () => {
  const variants: TestFeature[][] = [
    roads.roads!.features.slice().reverse(),
    [
      {
        ...road(1),
        points: [
          [100, 1000],
          [3501, 1000],
        ],
      },
      roads.roads!.features[1]!,
    ],
    [road(1, 'road_major', { name: 'changed' }), roads.roads!.features[1]!],
  ];
  for (const features of variants) {
    const changed = withRecords().map((t) =>
      t.tile.z === 15 ? { ...t, layers: { roads: { features } } } : t,
    );
    await expect(
      auditUtilityArchive(archive(baseTiles), archive(changed), records),
    ).rejects.toThrow('changed base geometry');
  }
  await expect(
    auditUtilityArchive(archive(baseTiles), archive(withRecords().slice(1)), records),
  ).rejects.toThrow('lost tile');
});
it('rejects changed archive extents and dangling or conflicting span endpoints', async () => {
  const base = archive(baseTiles),
    output = archive(withRecords());
  const header = await output.getHeader();
  vi.spyOn(output, 'getHeader').mockResolvedValue({ ...header, maxLon: header.maxLon + 1 });
  await expect(auditUtilityArchive(base, output, records)).rejects.toThrow('maxLon');
  const dangling = records.slice(1);
  await expect(auditUtilityArchive(base, archive(withRecords(dangling)), dangling)).rejects.toThrow(
    'Dangling or conflicting support a',
  );
  const conflicting = [
    { version: 1, kind: 'pole', pole: { ...pole, transformer: true } } satisfies UtilityRecord,
    ...records.slice(1),
  ];
  await expect(
    auditUtilityArchive(base, archive(withRecords(conflicting)), conflicting),
  ).rejects.toThrow('Dangling or conflicting support a');
});

it('copies an empty network byte-for-byte without running the external tools', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atlas-utility-'));
  dirs.push(dir);
  const base = join(dir, 'base.pmtiles'),
    output = join(dir, 'out.pmtiles'),
    merged = join(dir, 'merged.geojsonl');
  const bytes = archiveBytes(baseTiles);
  await writeFile(base, bytes);
  await writeFile(merged, '\n');
  await buildUtilityTiles(base, output, merged, [0, -0.005, 0.01, 0], dir);
  expect(new Uint8Array(await readFile(output))).toEqual(bytes);
  expect(tippecanoe).not.toHaveBeenCalled();
  expect(
    (
      await readJson<{ audit: { tiles: number; records: number } }>(
        join(dir, 'utilities-report.json'),
      )
    ).audit,
  ).toEqual({
    tiles: 0,
    records: 0,
  });
});

it('assembles and audits a generated network and restores the base header after tile-join', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atlas-utility-'));
  dirs.push(dir);
  const base = join(dir, 'base.pmtiles'),
    output = join(dir, 'out.pmtiles'),
    merged = join(dir, 'merged.geojsonl');
  await writeFile(base, archiveBytes(baseTiles));
  await writeFile(
    merged,
    JSON.stringify({
      type: 'Feature',
      properties: { id: 'osm:way/1', class: 'road_major', highway: 'primary', width: 8 },
      geometry: {
        type: 'LineString',
        coordinates: [
          [0.001, -0.001],
          [0.009, -0.001],
        ],
      },
    }) + '\n',
  );
  vi.mocked(tippecanoe).mockImplementation((input, target, _args, second) => {
    if (!second) {
      const generated = generatedRecords(input);
      writeFileSync(
        target,
        archiveBytes(
          withRecords(generated)
            .filter((t) => t.tile.z === 16)
            .map((t) => ({ ...t, layers: { utilities: t.layers.utilities! } })),
        ),
      );
    } else {
      const generated = generatedRecords(join(dir, 'utilities.geojsonl'));
      const bytes = archiveBytes(withRecords(generated));
      const h = new DataView(bytes.buffer);
      h.setInt32(102, -1000000, true);
      h.setInt32(119, 10000, true);
      writeFileSync(target, bytes);
    }
  });
  await buildUtilityTiles(base, output, merged, [0, -0.005, 0.01, 0], dir);
  expect(tippecanoe).toHaveBeenCalledTimes(2);
  expect(vi.mocked(tippecanoe).mock.calls[0]![2]).toEqual(
    expect.arrayContaining([
      '--no-feature-limit',
      '--no-tile-size-limit',
      '--minimum-zoom=16',
      '--maximum-zoom=16',
    ]),
  );
  const report = await readJson<{ audit: { records: number } }>(join(dir, 'utilities-report.json'));
  expect(report.audit.records).toBeGreaterThan(0);
  const reader = await openUtilityArchive(output);
  try {
    expect((await reader.archive.getHeader()).centerLon).toBe(0);
  } finally {
    await reader.close();
  }
});

it('excludes pipeline-only highway from base tiling while retaining it for utility generation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atlas-utility-'));
  dirs.push(dir);
  await writeFile(join(dir, 'merged.geojsonl'), '\n');
  await writeFile(
    join(dir, 'geography.json'),
    JSON.stringify({
      bounds: [0, -0.005, 0.01, 0],
      regionBounds: [0, -0.005, 0.01, 0],
      center: { lat: 0, lng: 0 },
      zoom: 16,
    }),
  );
  await writeFile(join(dir, 'subdivisions.json'), '[]');
  vi.mocked(tippecanoe).mockImplementation((_input, output) =>
    writeFileSync(output, archiveBytes(baseTiles)),
  );
  // Only fields used by the step are needed in this integration fixture.
  const context = {
    city: {
      slug: 'test',
      name: { en: 'Test' },
      subdivision: { label: { en: 'District' } },
      languages: ['en'],
    },
    content: { landcover: [], details: [], plans: [] },
    buildDir: dir,
    outDir: join(dir, 'public'),
  } as unknown as StepContext;
  await step.run(context);
  expect(vi.mocked(tippecanoe).mock.calls[0]![2]).toContain('--exclude=highway');
});
