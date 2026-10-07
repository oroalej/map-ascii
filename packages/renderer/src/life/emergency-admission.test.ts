import { expect, it } from 'vitest';
import { decodeEmergency, encodeEmergency } from '@atlas/shared';
import { dispatchFixture, emergencyMovers } from './testing/emergency-replay';
import { emergencyConfig } from './testing/emergency';
import { tileToLngLat } from '../raster/geometry';
import { outsideView } from './births';
import { LifeBuilder, LifeLine } from './geometry';
import { LifeWorld } from './simulate';
import { left, right, continuityMover } from './testing/continuity';
import { hashString } from './random';
import { worldTiles } from './testing/scenarios';
it('rejects junction-centre fire-truck placement and accepts the clear road beyond its footprint', () => {
  const b = new LifeBuilder();
  b.line(
    [
      { x: 0, y: 2000 },
      { x: 1000, y: 2000 },
      { x: 4000, y: 2000 },
    ],
    LifeLine.roadMajor,
    12,
  );
  b.line(
    [
      { x: 1000, y: 0 },
      { x: 1000, y: 2000 },
      { x: 1000, y: 4000 },
    ],
    LifeLine.roadMajor,
    12,
  );
  const world = new LifeWorld();
  world.sync([{ key: 'junction', tile: left, life: b.finish() }]);
  const life = worldTiles(world).get('junction')!,
    m = continuityMover(life, 1000);
  m.y = 2000;
  m.d = 1000;
  m.vehicle = 'firetruck';
  expect(life.junctionIndex.canSpawnVehicle(m)).toBe(false);
  const beyond = life.placeSeed(m, 1000 + 30 * life.perMeter)!;
  expect(life.junctionIndex.canSpawnVehicle(beyond)).toBe(true);
});

it('uses CSS margins and a partial contracted edge when its fire station is unloaded', () => {
  const f = dispatchFixture({ source: 'fixture', fire: emergencyConfig.fire }),
    network = decodeEmergency(f.data);
  network.nodes[0] = tileToLngLat(f.life.tile, { x: -1000, y: 2000 });
  network.edges[0]!.shape[0] = network.nodes[0]!;
  const station = network.targets.find((t) => t.kind === 'fire')!;
  station.at = network.nodes[0]!;
  station.t = 0;
  f.world.setEmergency(encodeEmergency(network));
  f.view.spawnMarginM = 40;
  f.world.updateView(f.view);
  for (let i = 0; i < 35; i++) f.step();
  const m = emergencyMovers(f.life)[0]!;
  expect(m).toBeDefined();
  expect(outsideView(f.life, f.life.birthBodies(m), f.view, 40)).toBe(true);
  expect(f.world.emergencyRouter!.nodeAt(tileToLngLat(f.life.tile, m))).toBeUndefined();
});
it('advances a loaded offscreen station beyond the ordinary 100 m halo', () => {
  const f = dispatchFixture({ source: 'fixture', fire: emergencyConfig.fire }),
    network = decodeEmergency(f.data);
  const station = network.targets.find((t) => t.kind === 'fire')!;
  station.at = tileToLngLat(f.life.tile, { x: 300, y: 2000 });
  station.t = 100 / 3700;
  f.world.setEmergency(encodeEmergency(network));
  for (let i = 0; i < 35; i++) f.step();
  const m = emergencyMovers(f.life)[0]!,
    x = m.x;
  expect(x).toBeLessThan(350);
  for (let i = 0; i < 150; i++) f.step();
  expect(m.x).toBeGreaterThan(x + 5 * f.life.perMeter);
});
it('admits from the viewport edges even when a two-tile view is wider than 800 m', () => {
  const world = new LifeWorld(),
    entries = [left, right].map((tile) => {
      const b = new LifeBuilder();
      b.line(
        [
          { x: -100, y: 2000 },
          { x: 4196, y: 2000 },
        ],
        LifeLine.roadMajor,
        12,
        hashString('road'),
      );
      return { key: `${tile.z}/${tile.x}/${tile.y}`, tile, life: b.finish() };
    });
  const shape = [
    tileToLngLat(left, { x: -100, y: 2000 }),
    tileToLngLat(right, { x: 4196, y: 2000 }),
  ];
  world.configureEmergency(
    { source: 'fixture', ambulance: emergencyConfig.ambulance },
    encodeEmergency({
      nodes: shape,
      edges: [{ from: 0, to: 1, length: 1200, bearing: [0, 0], oneway: 0, shape }],
      targets: [
        {
          id: 'hospital',
          kind: 'hospital',
          edge: 0,
          t: 0.5,
          at: tileToLngLat(left, { x: 4096, y: 2000 }),
          road: 'road',
          tangent: [1, 0],
          side: 1,
        },
      ],
      source: 'fixture',
    }),
  );
  world.sync(entries);
  for (const life of worldTiles(world).values())
    life.movers.length = life.pending.length = life.parked.length = 0;
  const nw = tileToLngLat(left, { x: 650, y: 1800 }),
    se = tileToLngLat(right, { x: 3446, y: 2200 });
  const view = {
    bounds: [nw[0], se[1], se[0], nw[1]] as [number, number, number, number],
    spawnMarginM: 12,
  };
  world.updateView(view);
  for (let i = 0; i < 35; i++) world.step(1 / 30, undefined, 18, view.bounds);
  const owners = [...worldTiles(world).values()].flatMap((life) =>
    emergencyMovers(life).map((m) => ({ life, m })),
  );
  expect(owners).toHaveLength(1);
  expect(outsideView(owners[0]!.life, owners[0]!.life.birthBodies(owners[0]!.m), view, 12)).toBe(
    true,
  );
});
