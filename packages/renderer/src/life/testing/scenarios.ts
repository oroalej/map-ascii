import { metersPerCssPx } from '../../grid';
/** Shared synthetic geography for CPU benchmarks and combined simulation tests. */
import { viewportFor } from '../../camera';
import { metersPerUnit, tileToLngLat } from '../../raster/geometry';
import { LifeBuilder, LifeLine } from '../geometry';
import { activityLevels } from '../config';
import { LifeWorld, type TileLife, type LifeTile } from '../simulate';
import type { FrameProfiler } from '../../profile';
import type { PolygonIndex, Polygon } from '../occupancy';
import { stripRing } from '../terrain';
import type { MomentOptions } from '../moments-host';
import type { DialogueChoice } from '@atlas/shared';
import { vehicleEffectSnapshot } from '../vehicle-effects';

/** Text-free fixtures explicitly enable speech in CPU runs; ordinary scenarios stay unchanged. */
export const SCENARIO_DIALOGUE: readonly DialogueChoice[] = [
  { id: 'hello', kind: 'greet', period: 'afternoon', turns: 2, speakers: [0, 1] },
  { id: 'talk', kind: 'talk', turns: 2, speakers: [0, 1] },
  { id: 'look', kind: 'look', turns: 1, speakers: [0] },
  { id: 'play', kind: 'ball', turns: 2, speakers: [0, 1] },
  {
    id: 'ambient',
    kind: 'talk',
    profile: 'daily-plans',
    delivery: 'utterance',
    turns: 1,
    speakers: [0],
  },
  { id: 'order', kind: 'talk', profile: 'vendor-order', turns: 2, speakers: [0, 1] },
  { id: 'wait', kind: 'talk', profile: 'transit', turns: 2, speakers: [0, 1] },
  {
    id: 'rain',
    kind: 'talk',
    profile: 'weather',
    delivery: 'utterance',
    turns: 1,
    speakers: [0],
    conditions: { weather: 'rain' },
  },
  { id: 'companion', kind: 'talk', profile: 'companion', turns: 2, speakers: [0, 1] },
];

export const SCENARIOS = [
  'sparse',
  'junction',
  'crossroads',
  'transit',
  'rain',
  'moments',
] as const;
export type Scenario = (typeof SCENARIOS)[number];
const base = { z: 16, x: 55192, y: 30266 };
// Explicit mapped sidewalk outside the 14 m carriageway, wide enough for waiting groups.
export const SCENE_CURB_Y = 2048 + 10 / metersPerUnit(base);
const ring = (x: number, y: number, w: number, h: number) => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
  { x, y },
];
export function scenarioLife(kind: Scenario) {
  const b = new LifeBuilder();
  if (kind === 'crossroads') {
    const center = { x: 2048, y: 2048 };
    for (const end of [
      { x: 0, y: 2048 },
      { x: 4095, y: 2048 },
      { x: 2048, y: 0 },
      { x: 2048, y: 4095 },
    ])
      b.line([center, end], LifeLine.roadMajor, 14);
    b.line(
      [
        { x: 0, y: 1000 },
        { x: 1000, y: 1000 },
        { x: 1800, y: 1000 },
      ],
      LifeLine.roadMinor,
      8,
    );
    b.line(
      [
        { x: 1000, y: 0 },
        { x: 1000, y: 1000 },
      ],
      LifeLine.roadMinor,
      8,
    );
  } else
    b.line(
      [
        { x: 0, y: 2048 },
        { x: 4095, y: 2048 },
      ],
      LifeLine.roadMajor,
      14,
    );
  if (kind !== 'sparse') {
    if (kind !== 'crossroads')
      b.line(
        [
          { x: 2048, y: 0 },
          { x: 2048, y: 4095 },
        ],
        LifeLine.roadMajor,
        14,
      );
    for (const y of [800, 1800, SCENE_CURB_Y, 3000])
      b.line(
        [
          { x: 0, y },
          { x: 4095, y },
        ],
        LifeLine.path,
      );
    for (const x of [800, 1800, 3000])
      b.line(
        [
          { x, y: 0 },
          { x, y: 4095 },
        ],
        LifeLine.path,
      );
    const pm = 1 / metersPerUnit(base);
    for (const y of [800, 1800, SCENE_CURB_Y, 3000])
      b.area('crossing', [
        stripRing({ x: 2048, y: y - 1.5 * pm }, { x: 2048, y: y + 1.5 * pm }, 7 * pm),
      ]);
    for (const x of [800, 1800, 3000])
      b.area('crossing', [
        stripRing({ x: x - 1.5 * pm, y: 2048 }, { x: x + 1.5 * pm, y: 2048 }, 7 * pm),
      ]);
    const blocked = ring(2400, 2300, 350, 300);
    b.area('blocked', [blocked]);
    b.obstacle(blocked, true);
    b.area('blocked', [ring(3200, 3300, 300, 300)], true);
    b.area('parking', [ring(500, 450, 300, 180), ring(620, 500, 30, 30)]);
    for (const x of [540, 590, 680, 740]) b.spot({ x, y: 530 }, 0, 1);
    if (kind === 'transit' || kind === 'rain') {
      b.site({ x: 1900, y: SCENE_CURB_Y }, 0, 7, true);
      b.site({ x: 2300, y: SCENE_CURB_Y }, 1, 7, true);
      b.site({ x: 1800, y: 800 }, 2, 0, true);
      b.market({ x: 1300, y: 1800 });
    }
  }
  if (kind === 'moments') {
    // Bounded legal gathering rings, away from roads and buildings. Benchmark real holds,
    // not an empty controller running over a geography with no places.
    const pm = 1 / metersPerUnit(base);
    b.place({ x: 1500, y: 1500 }, 'monument', 2 * pm);
    b.place({ x: 2500, y: 1500 }, 'school', 8 * pm);
    b.place({ x: 1500, y: 2600 }, 'pitch', 14 * pm);
    b.place({ x: 3000, y: 2700 }, 'worship', 6 * pm);
  }
  return b.finish();
}
export function scenarioTilesAt(
  kind: Scenario,
  cells: readonly { dx: number; dy: number }[],
  seed = 1,
): LifeTile[] {
  const life = scenarioLife(kind);
  return cells.map(({ dx, dy }) => {
    const tile = { ...base, x: base.x + dx, y: base.y + dy };
    return { key: `${tile.z}/${tile.x}/${tile.y}/seed${seed}`, tile, life };
  });
}
export function scenarioTiles(kind: Scenario, count: number, seed = 1): LifeTile[] {
  const side = Math.ceil(Math.sqrt(count));
  return scenarioTilesAt(
    kind,
    Array.from({ length: count }, (_, i) => ({
      dx: i % side,
      dy: Math.floor(i / side),
    })),
    seed,
  );
}
export function worldTiles(world: LifeWorld): ReadonlyMap<string, TileLife> {
  // Test/benchmark inspection only; no production API or mutable global state.
  return (world as unknown as { tiles: Map<string, TileLife> }).tiles;
}
export function retiredTiles(
  world: LifeWorld,
): ReadonlyMap<string, { life: TileLife; at: number }> {
  return (world as unknown as { retired: Map<string, { life: TileLife; at: number }> }).retired;
}
/** Baseline revisions can predate stats(); inspect their bins only in tests/benchmarks. */
export function polygonStats(index: PolygonIndex): ReturnType<PolygonIndex['stats']> {
  if (typeof index.stats === 'function') return index.stats();
  const { bins } = index as unknown as { bins: Map<number, Set<Polygon>> };
  const counts = new Map<Polygon, number>();
  let items = 0;
  let maxBinsPerPolygon = 0;
  for (const bin of bins.values())
    for (const polygon of bin) {
      const count = (counts.get(polygon) ?? 0) + 1;
      counts.set(polygon, count);
      maxBinsPerPolygon = Math.max(maxBinsPerPolygon, count);
      items++;
    }
  return {
    polygons: index.polygons.length,
    bins: bins.size,
    items,
    maxBinsPerPolygon,
    meanBinsPerPolygon: index.polygons.length ? items / index.polygons.length : 0,
  };
}

export function worldTerrainStats(world: LifeWorld) {
  const terrain = world.cellTerrain();
  const ground = (
    world as unknown as {
      groundTerrain?: { blocked: PolygonIndex; water: PolygonIndex };
    }
  ).groundTerrain;
  if (!terrain || !ground) throw new Error('World terrain has not been initialized');
  return Object.fromEntries(
    Object.entries({
      roads: terrain.roads,
      forbidden: terrain.forbidden,
      trees: terrain.trees,
      blocked: ground.blocked,
      water: ground.water,
    }).map(([name, index]) => [name, polygonStats(index)]),
  );
}
export function makeScenario(
  kind: Scenario,
  count: number,
  mobile = false,
  seed = 1,
  Simulation: typeof LifeWorld = LifeWorld,
  profiler?: FrameProfiler,
  moments?: MomentOptions,
  zoom = 18,
) {
  const tiles = scenarioTiles(kind, count, seed);
  const traffic =
    kind === 'transit' || kind === 'rain' ? { road_major: { jeepney: 1 } } : undefined;
  const world = new Simulation(traffic, profiler, moments);
  world.sync(tiles);
  const center = tileToLngLat(tiles[0]!.tile, { x: 2048, y: 2048 });
  const size = mobile ? { width: 390, height: 844 } : { width: 1920, height: 1080 };
  const camera = { lng: center[0], lat: center[1], zoom };
  const [[west, south], [east, north]] = viewportFor(camera, size).getBounds() as [
    number[],
    number[],
  ];
  const bounds: [number, number, number, number] = [west!, south!, east!, north!];
  const levels = activityLevels(1);
  const toCell = (lng: number, lat: number): [number, number] => [
    ((lng - west!) / (east! - west!)) * Math.ceil(size.width / 10),
    ((north! - lat) / (north! - south!)) * Math.ceil(size.height / 18),
  ];
  const grid = {
    cols: Math.ceil(size.width / 10),
    rows: Math.ceil(size.height / 18),
    cellWidth: 10,
    cellHeight: 18,
    toCell,
  };
  world.visible(zoom, levels, center, undefined, bounds);
  return {
    world,
    tiles,
    center,
    bounds,
    levels,
    grid,
    environment(frame: number) {
      return {
        rain: kind === 'rain' && Math.floor(frame / 90) % 2 === 0 ? 1 : 0,
        minutes: Math.floor(frame / 360) % 2 === 0 ? 720 : 180,
      };
    },
    step(frame: number, dt = 1 / 30, minimum = 0.9) {
      const env = this.environment(frame);
      world.step(
        dt,
        undefined,
        zoom,
        bounds,
        undefined,
        env,
        minimum,
        1.8,
        metersPerCssPx(camera) * 10,
      );
      return world.visible(zoom, levels, center, { rain: env.rain, sunAltitude: 40 }, bounds);
    },
  };
}
export function scenarioState(world: LifeWorld) {
  return [...worldTiles(world)].map(([key, tile]) => tileState(key, tile, world.signalClock));
}
function tileState(key: string, tile: TileLife, clock = tile.elapsed) {
  return {
    key,
    elapsed: tile.elapsed,
    // Benchmark fixtures also inspect frozen pre-exhaust revisions.
    decorations: {
      puffs: tile.puffs?.snapshot(clock) ?? [],
      effects: tile.movers.map((m) => vehicleEffectSnapshot(m, clock)),
    },
    flocks: tile.flocks,
    movers: tile.movers,
    gatherers: tile.gatherers,
    parked: tile.parked,
    stalls: tile.stalls,
    visits: [...tile.scenes.visits].map(([m, v]) => ({ owner: tile.movers.indexOf(m), ...v })),
    services: [...tile.scenes.services].map(([m, s]) => ({ owner: tile.movers.indexOf(m), ...s })),
    queues: tile.scenes.sites.map((s) => s.queue.map((m) => tile.movers.indexOf(m))),
  };
}

/** Includes global clocks for equivalence checks; respawn checks intentionally compare tiles only. */
export function completeScenarioState(world: LifeWorld) {
  const internal = world as unknown as {
    clock: number;
    junctions?: { snapshot(): unknown };
    arrivals: Map<string, { left: number; occupied: boolean }>;
    history: WeakMap<TileLife, { ceded: unknown }>;
    viewContext?: unknown;
    bootstrapped: boolean;
    birthCursor: number;
    birthCredit: number;
  };
  const scenes = (tile: TileLife) => {
    const scene = tile.scenes as unknown as {
      cooldown: Map<object, number>;
      stopCooldown: Map<object, object>;
      wet: boolean;
      scan: number;
      cursor: number;
      minutes: number;
      hoursDirty: boolean;
      cityLife: unknown;
    };
    return {
      cooldown: [...scene.cooldown].map(([m, time]) => [
        tile.movers.indexOf(m as (typeof tile.movers)[number]),
        time,
      ]),
      stopCooldown: [...scene.stopCooldown].map(([m, site]) => [
        tile.movers.indexOf(m as (typeof tile.movers)[number]),
        tile.scenes.sites.indexOf(site as (typeof tile.scenes.sites)[number]),
      ]),
      sites: tile.scenes.sites,
      wet: scene.wet,
      scan: scene.scan,
      cursor: scene.cursor,
      minutes: scene.minutes,
      hoursDirty: scene.hoursDirty,
      cityLife: scene.cityLife,
    };
  };
  return structuredClone({
    clock: internal.clock,
    junctions: internal.junctions?.snapshot(),
    arrivals: [...internal.arrivals].map(([id, { left, occupied }]) => ({ id, left, occupied })),
    tiles: scenarioState(world),
    moments: [...worldTiles(world)].map(([key, tile]) => ({
      key,
      state: tile.momentHost.moments.snapshot(),
    })),
    retired: [...retiredTiles(world)].map(([key, { life, at }]) => ({
      at,
      ...tileState(key, life, at),
      scene: scenes(life),
      ceded: internal.history.get(life)?.ceded,
      pending: life.pending.map((p) => ({
        mover: p.mover,
        age: life.elapsed - p.at,
        failures: p.failures,
        retryIn: p.retryAt === undefined ? undefined : p.retryAt - life.elapsed,
      })),
      birthCredit: life.birthCredit,
    })),
    ownership: [...worldTiles(world)].map(([key, life]) => ({
      key,
      ceded: internal.history.get(life)?.ceded,
    })),
    scenes: [...worldTiles(world)].map(([key, life]) => ({ key, ...scenes(life) })),
    pending: [...worldTiles(world)].map(([key, life]) => ({
      key,
      seeds: life.pending.map((p) => ({
        mover: p.mover,
        age: life.elapsed - p.at,
        failures: p.failures,
        retryIn: p.retryAt === undefined ? undefined : p.retryAt - life.elapsed,
      })),
      birthCredit: life.birthCredit,
    })),
    viewContext: internal.viewContext,
    bootstrapped: internal.bootstrapped,
    birthCursor: internal.birthCursor,
    birthCredit: internal.birthCredit,
  });
}
