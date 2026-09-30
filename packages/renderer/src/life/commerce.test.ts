import { describe, expect, it } from 'vitest';
import { LifeBuilder, LifeLine, MAX_TILE_SHOPS, lifeTransferables } from './geometry';
import { MAX_TILE_AGENTS, VENDORS } from './config';
import { LifeWorld } from './simulate';
import { worldTiles } from './testing/scenarios';
const tile = { z: 16, x: 55192, y: 30266 };
function setup(shops: boolean, seed: number) {
  const b = new LifeBuilder();
  for (const y of [800, 1600, 2400, 3200]) {
    b.line(
      [
        { x: 0, y },
        { x: 4095, y },
      ],
      LifeLine.path,
    );
    if (shops) for (let x = 100; x < 4000; x += 150) b.commerceAt({ x, y: y + 80 });
  }
  const world = new LifeWorld();
  world.sync([{ tile, key: `commerce-${seed}`, life: b.finish() }]);
  return { world, life: worldTiles(world).values().next().value! };
}
describe('commerce admission', () => {
  for (const seed of [1, 42])
    it(`preserves settled legacy prefixes and admits bounded additions, seed ${seed}`, () => {
      const base = setup(false, seed),
        extra = setup(true, seed),
        empty = setup(false, seed);
      expect(empty.life.movers).toEqual(base.life.movers);
      expect(empty.life.stalls).toEqual(base.life.stalls);
      expect(extra.life.movers.slice(0, base.life.movers.length)).toEqual(base.life.movers);
      expect(extra.life.stalls.slice(0, base.life.stalls.length)).toEqual(base.life.stalls);
      expect(extra.life.movers.length).toBeGreaterThan(base.life.movers.length);
      expect(extra.life.stalls.length).toBeGreaterThan(base.life.stalls.length);
      expect(extra.life.movers.length).toBeLessThanOrEqual(MAX_TILE_AGENTS);
      expect(extra.life.stalls.length).toBeLessThanOrEqual(VENDORS.maxPerTile);
      const count = extra.life.movers.length;
      extra.world.sync([{ tile, key: `commerce-${seed}`, life: extra.life.geo }]);
      expect(extra.life.movers.length).toBe(count);
    });
  it('caps buffered commerce and owned light centers and transfers their storage', () => {
    const b = new LifeBuilder();
    for (let i = 0; i < 200; i++) {
      b.commerceAt({ x: -i, y: 1 });
      b.shop({ x: i, y: 1 }, 2);
    }
    const geo = b.finish();
    expect(geo.commerce!.length).toBe(MAX_TILE_SHOPS * 2);
    expect(geo.shops.length).toBe(MAX_TILE_SHOPS * 3);
    expect(lifeTransferables(geo)).toContain(geo.commerce!.buffer);
  });
});
