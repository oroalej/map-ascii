/** Manual real-tile CPU diagnostic. No browser, shader sampling or simulation decisions. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCityPacks } from '@atlas/content';
import { CityMeta, dialogueChoices, runtimeDialogueCatalog } from '@atlas/shared';
import * as workingCamera from '../src/camera';
import * as workingDensity from '../src/density';
import * as workingGrid from '../src/grid';
import * as workingBirths from '../src/life/births';
import * as workingClock from '../src/life/clock';
import * as workingConfig from '../src/life/config';
import * as workingDiagnostics from '../src/life/diagnostics';
import * as workingDraw from '../src/life/draw';
import * as workingSimulate from '../src/life/simulate';
import type { LifeTile, TileLife, Mover, VisibleAgent } from '../src/life/simulate';
import { PackingOutcome } from '../src/life/diagnostics';
import type { Body, PolygonIndex } from '../src/life/occupancy';
import type { RoadAccess } from '../src/life/terrain';
import type { JunctionTable } from '../src/life/junctions';
import * as workingSun from '../src/life/sun';
import * as workingProfile from '../src/profile';
import * as workingTheme from '../src/theme';
import * as workingTiles from '../src/tiles';
import * as workingGeometry from '../src/raster/geometry';
import { decodeLifeTiles, openArchive } from './archive';
import { snapshotRevision, snapshotWorkingTree, currentSourceHash } from './snapshot';
import { classifyTerminalStops, MEASUREMENT_VERSION } from './observe-life';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const output = process.argv.find((arg) => arg.startsWith('--output='))?.slice(9);
const prefix = process.argv.find((arg) => arg.startsWith('--case='))?.slice(7) ?? '';
const baseline = process.argv.find((arg) => arg.startsWith('--baseline='))?.slice(11);
const probe = process.argv.find((arg) => arg.startsWith('--probe-seconds='))?.slice(16);
const resume = process.argv.includes('--resume');
if (resume && !output) throw new Error('--resume requires an existing --output report');
if (probe && (!prefix || baseline || ![30, 60].includes(Number(probe))))
  throw new Error(
    '--probe-seconds=30|60 requires a case prefix and the current engine; probes do not satisfy acceptance',
  );
if (baseline && !output)
  throw new Error('--baseline requires --output so snapshots stay beside the report');
const snapshotDestination = output && resolve(dirname(output), `diag-source-${Date.now()}`);
const snapshot = baseline
  ? await snapshotRevision(root, baseline, snapshotDestination!)
  : output
    ? await snapshotWorkingTree(root, snapshotDestination!)
    : undefined;
const observerSnapshot =
  baseline && output
    ? await snapshotWorkingTree(root, resolve(dirname(output), `diag-observer-${Date.now()}`))
    : snapshot;
const { LifeDiagnostics } = observerSnapshot
  ? ((await import(observerSnapshot.path('life/diagnostics.ts'))) as typeof workingDiagnostics)
  : workingDiagnostics;
async function moduleAt<T>(path: string, current: T): Promise<T> {
  return snapshot ? ((await import(snapshot.path(path))) as T) : current;
}
const [
  { project, unproject, viewportFor },
  { DEFAULT_CELLS, cellStep, stepCell },
  { metersPerCssPx, placeGrid },
  { spawnMargin },
  { atCityMinutes, cityTime },
  { activityLevels, MAX_VISIBLE_AGENTS },
  { buildLifeGlyphs, packLife },
  { LifeWorld },
  { daylight, solarPosition },
  { FrameProfiler },
  { themes },
  { tileKey, viewTiles },
  { buildTileGeometry },
] = await Promise.all([
  moduleAt('camera.ts', workingCamera),
  moduleAt('density.ts', workingDensity),
  moduleAt('grid.ts', workingGrid),
  moduleAt('life/births.ts', workingBirths),
  moduleAt('life/clock.ts', workingClock),
  moduleAt('life/config.ts', workingConfig),
  moduleAt('life/draw.ts', workingDraw),
  moduleAt('life/simulate.ts', workingSimulate),
  moduleAt('life/sun.ts', workingSun),
  moduleAt('profile.ts', workingProfile),
  moduleAt('theme.ts', workingTheme),
  moduleAt('tiles.ts', workingTiles),
  moduleAt('raster/geometry.ts', workingGeometry),
]);
const sourceHash = snapshot?.hash ?? (await currentSourceHash(root));
const observerHash = createHash('sha256')
  .update(
    (await readFile(resolve(root, 'packages/renderer/src/life/diagnostics.ts'), 'utf8')).replace(
      /\r\n/g,
      '\n',
    ),
  )
  .update(
    (await readFile(resolve(root, 'packages/renderer/scripts/observe-life.ts'), 'utf8')).replace(
      /\r\n/g,
      '\n',
    ),
  )
  .digest('hex');
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
  seconds = probe ? Number(probe) : 300;
const runtime = runtimeDialogueCatalog(pack.dialogue);
const revision = execFileSync('git', ['rev-parse', baseline ?? 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
}).trim();
const dirty =
  !baseline &&
  !!execFileSync('git', ['status', '--porcelain'], {
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
const expectedCases = [17, 16, 18, 15, 19].flatMap((zoom) =>
  [720, 1080].flatMap((minutes) =>
    [1, 0.4].flatMap((crowd) =>
      ['fixed', 'pan'].map((mode) => `z${zoom}/${minutes}/crowd${crowd}/${mode}`),
    ),
  ),
);
const selectedCases = expectedCases.filter((key) => key.startsWith(prefix));
let priorRuntime = 0;
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
  flickerSamples?: unknown[];
  report: ReturnType<workingDiagnostics.LifeDiagnostics['report']>;
  owners?: ReturnType<workingDiagnostics.LifeDiagnostics['longestStuck']>;
  recoveryEvents?: ReturnType<workingDiagnostics.LifeDiagnostics['recentRecoveries']>;
}[] = [];
async function save(complete: boolean) {
  const report = {
    revision,
    sourceHash,
    sourceSnapshot: snapshotDestination,
    dirty,
    complete: complete && cases.length === expectedCases.length,
    selectionComplete: complete && cases.length === selectedCases.length,
    expectedCases,
    selectedCases,
    measurementVersion: MEASUREMENT_VERSION,
    observerHash,
    probe: !!probe,
    inputHash: hash(JSON.stringify(inputs)),
    inputs,
    runtimeSeconds: priorRuntime + (performance.now() - started) / 1000,
    cases,
  };
  if (output) await writeFile(resolve(output), `${JSON.stringify(report, null, 2)}\n`);
  else if (complete) console.log(JSON.stringify(report, null, 2));
}
function describeOwner(world: workingSimulate.LifeWorld, owner: object, minimum: number) {
  // Manual, read-only inspection of the same indexes used by the production guard.
  const state = world as unknown as {
    tiles: Map<string, TileLife>;
    junctions: JunctionTable;
    groundTerrain?: {
      blocked: PolygonIndex;
      water: PolygonIndex;
      roadAccess: RoadAccess;
      origins: Map<TileLife, { x: number; y: number; scale: number }>;
    };
  };
  const life = [...state.tiles.values()].find((l) => l.movers.includes(owner as Mover));
  const terrain = state.groundTerrain;
  const origin = life && terrain?.origins.get(life);
  if (!life || !terrain || !origin) return;
  const m = owner as Mover;
  const legal = (bodies: Body[]) => {
    for (const b of bodies) {
      b.x = origin.x + b.x * origin.scale;
      b.y = origin.y + b.y * origin.scale;
      b.length *= origin.scale;
      b.width *= origin.scale;
    }
    return {
      building: terrain.blocked.hits(bodies),
      water: m.kind === 'person' && terrain.water.hits(bodies),
      road: m.kind === 'person' && !terrain.roadAccess.allows(bodies, true),
    };
  };
  const visit = life.scenes.visits.get(m);
  return {
    momentFacing: m.momentFacing,
    roadShift: m.roadShift,
    curveLengthM: m.curveLengthM,
    junction: {
      movement: state.junctions.movement(m),
      granted: state.junctions.granted(m),
      waited: state.junctions.waited(m),
    },
    physical: legal(life.groundBodies(m)),
    inflated: legal(life.groundBodies(m, minimum)),
    line: {
      kind: life.geo.kinds[m.line],
      width: life.geo.widths[m.line],
      oneway: life.geo.oneway?.[m.line],
      terminalRoom: (
        life as unknown as { oneWayEndRoom: (m: Mover) => number | undefined }
      ).oneWayEndRoom(m),
      segment: Array.from(life.geo.coords.slice(m.from * 2, m.from * 2 + 2)),
      target: Array.from(life.geo.coords.slice((m.from + m.dir) * 2, (m.from + m.dir) * 2 + 2)),
    },
    visit: visit && {
      state: visit.state,
      blocked: visit.blocked,
      next: visit.next,
      target: visit.path[visit.next],
      start: visit.trail[0],
    },
  };
}
try {
  if (resume) {
    const previous = JSON.parse(await readFile(resolve(output!), 'utf8')) as {
      revision?: unknown;
      sourceHash?: unknown;
      observerHash?: unknown;
      measurementVersion?: unknown;
      inputHash?: unknown;
      probe?: unknown;
      runtimeSeconds?: unknown;
      cases?: typeof cases;
    };
    if (
      previous.revision !== revision ||
      previous.sourceHash !== sourceHash ||
      previous.observerHash !== observerHash ||
      previous.measurementVersion !== MEASUREMENT_VERSION ||
      previous.inputHash !== hash(JSON.stringify(inputs)) ||
      !!previous.probe !== !!probe ||
      typeof previous.runtimeSeconds !== 'number' ||
      !Number.isFinite(previous.runtimeSeconds) ||
      previous.runtimeSeconds < 0 ||
      !Array.isArray(previous.cases) ||
      previous.cases.some(
        (c) =>
          !c?.key?.startsWith(prefix) ||
          typeof c.report?.seconds !== 'number' ||
          !Number.isFinite(c.report.seconds) ||
          Math.abs(c.report.seconds - seconds) > 1e-6 ||
          c.key !== `z${c.zoom}/${c.minutes}/crowd${c.crowd}/${c.mode}` ||
          ![15, 16, 17, 18, 19].includes(c.zoom) ||
          ![720, 1080].includes(c.minutes) ||
          ![1, 0.4].includes(c.crowd) ||
          !['fixed', 'pan'].includes(c.mode),
      ) ||
      new Set(previous.cases.map((c) => c.key)).size !== previous.cases.length
    )
      throw new Error(
        'Cannot resume: diagnostic source, revision, inputs or completed cases differ',
      );
    cases.push(...previous.cases);
    priorRuntime = previous.runtimeSeconds;
    console.log(`Resuming ${cases.length} completed cases`);
  }
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
          if (cases.some((c) => c.key === key)) continue;
          console.log(`${key}: preparing`);
          const caseStart = performance.now();
          const diagnostics = new LifeDiagnostics({ rawMotion: true });
          const profiler = new FrameProfiler(() => 0, diagnostics);
          const world = new LifeWorld(config.traffic, profiler, {
            dialogue: runtime && dialogueChoices(runtime),
            periods: runtime?.periods,
          });
          const flickerSamples: unknown[] = [];
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
              for (const tile of await decodeLifeTiles(archive.archive, missing, buildTileGeometry))
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
            classifyTerminalStops(world, diagnostics);
            if (frame >= warmup / dt && flickerSamples.length < 100) {
              // Read-only examples supplement the common observer's counters. They
              // never call movement guards or change the PRE/POST definitions.
              const state = diagnostics as unknown as {
                views: Map<VisibleAgent, object>;
                candidates: Map<object, VisibleAgent>;
                previousDrawn: Set<number>;
                identities: WeakMap<object, number>;
              };
              const drawn = new Set<object>();
              agents.forEach((agent, i) => {
                const owner = state.views.get(agent);
                if (owner && outcomes[i] === PackingOutcome.drawn) drawn.add(owner);
              });
              const seen = new Set<object>();
              for (const [i, agent] of agents.entries()) {
                const owner = state.views.get(agent);
                const id = owner && state.identities.get(owner);
                if (
                  !owner ||
                  id === undefined ||
                  seen.has(owner) ||
                  drawn.has(owner) ||
                  !state.previousDrawn.has(id) ||
                  !state.candidates.has(owner) ||
                  (outcomes[i] !== PackingOutcome.collision &&
                    outcomes[i] !== PackingOutcome.cellGuard)
                )
                  continue;
                seen.add(owner);
                flickerSamples.push({
                  id,
                  at: frame * dt - warmup,
                  outcome: outcomes[i],
                  denials: denials[i],
                  view: {
                    kind: agent.kind,
                    vehicle: agent.vehicle,
                    people: agent.people,
                    cell: placement.toCell(agent.lng, agent.lat),
                  },
                  details: describeOwner(world, owner, cellMeters),
                });
                if (flickerSamples.length >= 100) break;
              }
            }
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
            flickerSamples,
            report: diagnostics.report(),
            owners: diagnostics.longestStuck(50, (owner) =>
              describeOwner(world, owner, cellMeters),
            ),
            recoveryEvents: diagnostics.recentRecoveries(),
          });
          world.clearTiles();
          await save(false);
          console.log(`${key}: ${JSON.stringify(cases.at(-1)!.report.motion)}`);
        }
  await save(true);
} finally {
  await archive.close();
}
