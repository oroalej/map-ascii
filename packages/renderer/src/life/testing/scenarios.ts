/** Shared synthetic geography for CPU benchmarks and combined simulation tests. */
import { viewportFor } from '../../camera';
import { tileToLngLat } from '../../raster/geometry';
import { LifeBuilder, LifeLine } from '../geometry';
import { activityLevels } from '../config';
import { LifeWorld, type TileLife, type LifeTile } from '../simulate';
import type { FrameProfiler } from '../../profile';

export const SCENARIOS = ['sparse', 'junction', 'transit', 'rain'] as const;
export type Scenario = (typeof SCENARIOS)[number];
const base = { z: 16, x: 55192, y: 30266 };
const ring = (x: number, y: number, w: number, h: number) => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
  { x, y },
];
export function scenarioTiles(kind: Scenario, count: number, seed = 1): LifeTile[] {
  const b = new LifeBuilder();
  b.line(
    [
      { x: 0, y: 2048 },
      { x: 4095, y: 2048 },
    ],
    LifeLine.roadMajor,
    14,
  );
  if (kind !== 'sparse') {
    b.line(
      [
        { x: 2048, y: 0 },
        { x: 2048, y: 4095 },
      ],
      LifeLine.roadMajor,
      14,
    );
    for (const y of [800, 1800, 2090, 3000])
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
    const blocked = ring(2400, 2300, 350, 300);
    b.area('blocked', [blocked]);
    b.obstacle(blocked, true);
    b.area('blocked', [ring(3200, 3300, 300, 300)], true);
    b.area('parking', [ring(500, 450, 300, 180), ring(620, 500, 30, 30)]);
    for (const x of [540, 590, 680, 740]) b.spot({ x, y: 530 }, 0, 1);
    if (kind === 'transit' || kind === 'rain') {
      b.site({ x: 1900, y: 2090 }, 0, 7, true);
      b.site({ x: 2300, y: 2090 }, 1, 7, true);
      b.site({ x: 1800, y: 800 }, 2, 0, true);
      b.market({ x: 1300, y: 1800 });
    }
  }
  const life = b.finish();
  const side = Math.ceil(Math.sqrt(count));
  return Array.from({ length: count }, (_, i) => {
    const tile = { ...base, x: base.x + (i % side), y: base.y + Math.floor(i / side) };
    return { key: `${tile.z}/${tile.x}/${tile.y}/seed${seed}`, tile, life };
  });
}
export function worldTiles(world: LifeWorld): ReadonlyMap<string, TileLife> {
  // Test/benchmark inspection only; no production API or mutable global state.
  return (world as unknown as { tiles: Map<string, TileLife> }).tiles;
}
export function makeScenario(
  kind: Scenario,
  count: number,
  mobile = false,
  seed = 1,
  Simulation: typeof LifeWorld = LifeWorld,
  profiler?: FrameProfiler,
) {
  const tiles = scenarioTiles(kind, count, seed);
  const traffic =
    kind === 'transit' || kind === 'rain' ? { road_major: { jeepney: 1 } } : undefined;
  const world = new Simulation(traffic, profiler);
  world.sync(tiles);
  const center = tileToLngLat(tiles[0]!.tile, { x: 2048, y: 2048 });
  const size = mobile ? { width: 390, height: 844 } : { width: 1920, height: 1080 };
  const camera = { lng: center[0], lat: center[1], zoom: 18 };
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
  world.visible(18, levels, center, undefined, bounds);
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
      world.step(dt, undefined, 18, bounds, undefined, env, minimum);
      return world.visible(18, levels, center, { rain: env.rain, sunAltitude: 40 }, bounds);
    },
  };
}
export function scenarioState(world: LifeWorld) {
  return [...worldTiles(world)].map(([key, tile]) => ({
    key,
    elapsed: tile.elapsed,
    flocks: tile.flocks,
    movers: tile.movers,
    gatherers: tile.gatherers,
    parked: tile.parked,
    stalls: tile.stalls,
    visits: [...tile.scenes.visits].map(([m, v]) => ({ owner: tile.movers.indexOf(m), ...v })),
    services: [...tile.scenes.services].map(([m, s]) => ({ owner: tile.movers.indexOf(m), ...s })),
    queues: tile.scenes.sites.map((s) => s.queue.map((m) => tile.movers.indexOf(m))),
  }));
}

/** Includes global clocks for equivalence checks; respawn checks intentionally compare tiles only. */
export function completeScenarioState(world: LifeWorld) {
  const internal = world as unknown as {
    clock: number;
    arrivals: Map<string, { left: number; occupied: boolean }>;
  };
  return {
    clock: internal.clock,
    arrivals: [...internal.arrivals].map(([id, { left, occupied }]) => ({ id, left, occupied })),
    tiles: scenarioState(world),
  };
}
