import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { LifeWorld, TileLife } from './simulate';
import { completeScenarioState, makeScenario, retiredTiles, worldTiles } from './testing/scenarios';
import { emergencyConfig, emergencyFixture } from './testing/emergency';
import { continuityMover, continuityTile, left, parent, right } from './testing/continuity';
import { tileToLngLat } from '../raster/geometry';

const zero = {
  ...emergencyConfig,
  ambulance: { ...emergencyConfig.ambulance!, max: 0 },
  police: { ...emergencyConfig.police!, max: 0 },
  fire: { ...emergencyConfig.fire!, max: 0 },
};
function legacy(world: LifeWorld) {
  for (const life of [
    ...worldTiles(world).values(),
    ...[...retiredTiles(world).values()].map((r) => r.life),
  ])
    for (const m of [...life.residentMovers(), ...life.pending.map((p) => p.mover)])
      expect(Object.hasOwn(m, 'emergency')).toBe(false);
  for (const a of world.visible(18, 1, [0, 0])) expect(Object.hasOwn(a, 'beacon')).toBe(false);
}
it('pins PRE state and preserves absent/all-zero complete property sets through retire and revive', () => {
  const a = makeScenario('junction', 1),
    b = makeScenario('junction', 1);
  expect(
    createHash('sha256')
      .update(JSON.stringify(completeScenarioState(a.world)))
      .digest('hex'),
  ).toBe('43fb4a79224f475fa2ece4b2c17abf7145749499aaa648d7aa4018d70f0b652f');
  b.world.configureEmergency(zero, emergencyFixture().data);
  for (let i = 0; i < 20; i++) {
    if (i === 5 || i === 10) {
      a.world.sync(i === 5 ? [] : a.tiles);
      b.world.sync(i === 5 ? [] : b.tiles);
    }
    a.world.step(0.1, undefined, 18);
    b.world.step(0.1, undefined, 18);
    expect(completeScenarioState(b.world)).toStrictEqual(completeScenarioState(a.world));
    legacy(a.world);
    legacy(b.world);
  }
});
it.each([false, true])(
  'keeps ordinary seam and both zoom adoptions free of emergency fields (zero=%s)',
  (zeroConfig) => {
    const world = new LifeWorld();
    if (zeroConfig) world.configureEmergency(zero, emergencyFixture().data);
    const p = continuityTile(parent),
      child = continuityTile(left);
    world.sync([p]);
    const source = worldTiles(world).get(p.key)!,
      m = continuityMover(source, 500);
    source.movers.splice(0, source.movers.length, m);
    const direct = new TileLife(left, child.life, 123);
    expect(Object.hasOwn(direct.projectFrom(m, source)!, 'emergency')).toBe(false);
    world.sync([child]);
    const owner = worldTiles(world).get(child.key)!;
    expect(owner.movers).toContain(m);
    expect(source.movers).not.toContain(m);
    legacy(world);
    world.sync([p]);
    const back = worldTiles(world).get(p.key)!;
    expect(back.movers).toContain(m);
    expect(owner.movers).not.toContain(m);
    legacy(world);
    const neighbor = new TileLife(right, continuityTile(right).life, 124);
    const seam = continuityMover(owner, 4097);
    owner.movers.push(seam);
    expect(neighbor.adoptFrom(seam, owner)).toBe(true);
    expect(neighbor.movers).toContain(seam);
    expect(owner.movers).not.toContain(seam);
    expect(Object.hasOwn(seam, 'emergency')).toBe(false);
    const center = tileToLngLat(parent, back.pose(m));
    for (const a of world.visible(18, 1, center)) expect(Object.hasOwn(a, 'beacon')).toBe(false);
  },
);
