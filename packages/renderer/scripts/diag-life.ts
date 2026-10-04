/** Manual real-tile CPU diagnostic. No browser, shader sampling or simulation decisions. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCityPacks } from '@atlas/content';
import { CityMeta, dialogueChoices, runtimeDialogueCatalog } from '@atlas/shared';
import { project, unproject, viewportFor } from '../src/camera';
import { DEFAULT_CELLS, cellStep, stepCell } from '../src/density';
import { metersPerCssPx, placeGrid } from '../src/grid';
import { spawnMargin } from '../src/life/births';
import { atCityMinutes, cityTime } from '../src/life/clock';
import { activityLevels, MAX_VISIBLE_AGENTS } from '../src/life/config';
import { LifeDiagnostics } from '../src/life/diagnostics';
import { buildLifeGlyphs, packLife } from '../src/life/draw';
import { LifeWorld, type LifeTile } from '../src/life/simulate';
import { daylight, solarPosition } from '../src/life/sun';
import { FrameProfiler } from '../src/profile';
import { themes } from '../src/theme';
import { tileKey, viewTiles } from '../src/tiles';
import { decodeLifeTiles, openArchive } from './archive';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const output = process.argv.find((arg) => arg.startsWith('--output='))?.slice(9);
const prefix = process.argv.find((arg) => arg.startsWith('--case='))?.slice(7) ?? '';
const { packs, errors } = await loadCityPacks(resolve(root, 'packages/content'), { only: 'naga' });
if (errors.length || !packs[0]) throw new Error(JSON.stringify(errors));
const pack = packs[0],
  config = pack.city;
const metadata = await readFile(resolve(root, 'apps/web/public/tiles/naga.meta.json'));
const meta = CityMeta.parse(JSON.parse(metadata.toString()));
const archive = await openArchive(config.slug);
const hash = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const size = { width: 1920, height: 1080 };
const dt = 1 / 30,
  warmup = 30,
  seconds = 300;
const runtime = runtimeDialogueCatalog(pack.dialogue);
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const dirty = !!execFileSync('git', ['status', '--porcelain'], {
  cwd: root,
  encoding: 'utf8',
}).trim();
const cache = new Map<string, LifeTile | null>();
const inputs = {
  archive: archive.hash,
  metadata: hash(metadata),
  config: hash(JSON.stringify(config)),
  dialogue: hash(JSON.stringify(runtime ?? null)),
  date: '2026-10-04',
  size,
  dt,
  warmup,
  seconds,
  agentCap: MAX_VISIBLE_AGENTS,
  cells: DEFAULT_CELLS,
  camera: meta.defaultCamera,
  regionBounds: meta.regionBounds,
  path: 'east-west at one horizontal cell/second; reflect at region longitude bounds',
};
const started = performance.now();
const cases: {
  key: string;
  zoom: number;
  minutes: number;
  crowd: number;
  mode: string;
  cell: { width: number; height: number };
  cellMeters: number;
  tileZoom: number;
  clock: ReturnType<typeof cityTime>;
  sun: ReturnType<typeof solarPosition>;
  runtimeSeconds: number;
  report: ReturnType<LifeDiagnostics['report']>;
}[] = [];
async function save(complete: boolean) {
  const report = {
    revision,
    dirty,
    complete,
    inputHash: hash(JSON.stringify(inputs)),
    inputs,
    runtimeSeconds: (performance.now() - started) / 1000,
    cases,
  };
  if (output) await writeFile(resolve(output), `${JSON.stringify(report, null, 2)}\n`);
  else if (complete) console.log(JSON.stringify(report, null, 2));
}
try {
  if (archive.hash !== pack.tilesLock?.files[`${config.slug}.pmtiles`])
    throw new Error('Archive hash does not match city tiles lock');
  const header = {
    minZoom: archive.header.minZoom,
    maxZoom: archive.header.maxZoom,
    bounds: [
      archive.header.minLon,
      archive.header.minLat,
      archive.header.maxLon,
      archive.header.maxLat,
    ] as [number, number, number, number],
  };
  for (const zoom of [17, 16, 18, 15, 19])
    for (const minutes of [720, 1080])
      for (const crowd of [1, 0.4])
        for (const mode of ['fixed', 'pan']) {
          const key = `z${zoom}/${minutes}/crowd${crowd}/${mode}`;
          if (!key.startsWith(prefix)) continue;
          console.log(`${key}: preparing`);
          const caseStart = performance.now();
          const diagnostics = new LifeDiagnostics();
          const profiler = new FrameProfiler(() => 0, diagnostics);
          const world = new LifeWorld(config.traffic, profiler, {
            dialogue: runtime && dialogueChoices(runtime),
            periods: runtime?.periods,
          });
          let camera = { ...meta.defaultCamera, zoom };
          const cell = stepCell(DEFAULT_CELLS, cellStep(DEFAULT_CELLS, zoom));
          const cellMeters = metersPerCssPx(camera) * cell.width;
          const cellDev = { w: cell.width, h: cell.height };
          const cols = Math.ceil(size.width / cell.width) + 3,
            rows = Math.ceil(size.height / cell.height) + 3;
          const texels = new Uint8Array(cols * rows * 4);
          const glyphs = new Map<string, number>();
          const glyphIndex = (glyph: string) => {
            if (!glyph) return 0;
            let index = glyphs.get(glyph);
            if (index === undefined) {
              index = glyphs.size + 1;
              glyphs.set(glyph, index);
            }
            return index;
          };
          const lifeGlyphs = buildLifeGlyphs(glyphIndex);
          const zone = { timezone: config.timezone, lng: camera.lng };
          const date = atCityMinutes(new Date('2026-10-04T12:00:00Z'), zone, minutes);
          const clock = cityTime(date, zone);
          const sun = solarPosition(date, camera.lng, camera.lat);
          const levels = activityLevels(daylight(sun.altitude), {
            minutes,
            weekday: clock.weekday,
            life: config.life,
          });
          const weather = { rain: 0, sunAltitude: sun.altitude };
          const [west] = project(meta.regionBounds[0], camera.lat, zoom);
          const [east] = project(meta.regionBounds[2], camera.lat, zoom);
          let [x, y] = project(camera.lng, camera.lat, zoom),
            direction = 1,
            previousTiles = '';
          for (let frame = 0; frame < (warmup + seconds) / dt; frame++) {
            if (mode === 'pan' && frame) {
              x += direction * cell.width * dt;
              if (x > east) {
                x = east - (x - east);
                direction = -1;
              }
              if (x < west) {
                x = west + (west - x);
                direction = 1;
              }
              const [lng, lat] = unproject(x, y, zoom);
              camera = { lng, lat, zoom };
            }
            const [[w, s], [e, n]] = viewportFor(camera, size).getBounds() as [
              [number, number],
              [number, number],
            ];
            const bounds: [number, number, number, number] = [w, s, e, n];
            const center: [number, number] = [camera.lng, camera.lat];
            const ids = viewTiles(camera, size, header);
            const missing = ids.filter((id) => !cache.has(tileKey(id)));
            if (missing.length) {
              for (const id of missing) cache.set(tileKey(id), null);
              for (const tile of await decodeLifeTiles(archive.archive, missing))
                cache.set(tile.key, tile);
              if (frame === 0)
                console.log(
                  `${key}: decoded ${ids.length} tiles in ${((performance.now() - caseStart) / 1000).toFixed(1)}s`,
                );
            }
            const keys = ids.map(tileKey).join('|');
            if (keys !== previousTiles) {
              world.sync(
                ids.flatMap((id) => cache.get(tileKey(id)) ?? []),
                center,
                { bounds, spawnMarginM: spawnMargin(cellMeters, cell.height / cell.width) },
              );
              previousTiles = keys;
              if (frame === 0)
                console.log(
                  `${key}: synchronized in ${((performance.now() - caseStart) / 1000).toFixed(1)}s`,
                );
            }
            if (frame === 0) world.visible(zoom, levels, center, weather, bounds, crowd);
            diagnostics.beginFrame(dt, bounds, zoom, crowd, frame >= warmup / dt);
            world.step(
              dt,
              undefined,
              zoom,
              bounds,
              undefined,
              { rain: 0, minutes, cityLife: config.life },
              cellMeters,
              cell.height / cell.width,
            );
            const agents = world.visible(zoom, levels, center, weather, bounds, crowd);
            const placement = placeGrid({ camera, ...size, dpr: 1 }, cellDev, cols, rows);
            const outcomes = new Uint8Array(agents.length);
            const denials = new Uint8Array(agents.length);
            packLife(
              texels,
              {
                cols,
                rows,
                cellWidth: cell.width,
                cellHeight: cell.height,
                toCell: placement.toCell,
                allowsGroundCell: world.groundCellGuard(placement.toCell),
                outcomes,
                denials,
              },
              agents,
              themes.dark,
              glyphIndex,
              sun,
              lifeGlyphs,
            );
            diagnostics.finishFrame(agents, outcomes, denials);
            if ((frame + 1) % 900 === 0)
              console.log(
                `${key}: ${(frame + 1) / 30}s simulated, ${((performance.now() - caseStart) / 1000).toFixed(1)}s elapsed`,
              );
          }
          cases.push({
            key,
            zoom,
            minutes,
            crowd,
            mode,
            cell,
            cellMeters,
            tileZoom: Math.min(zoom, header.maxZoom),
            clock,
            sun,
            runtimeSeconds: (performance.now() - caseStart) / 1000,
            report: diagnostics.report(),
          });
          world.clearTiles();
          await save(false);
          console.log(`${key}: ${JSON.stringify(cases.at(-1)!.report.motion)}`);
        }
  await save(true);
} finally {
  await archive.close();
}
