import { beforeAll, describe, expect, it } from 'vitest';
import { metersPerUnit } from '../raster/geometry';
import { LifeBuilder, LifeLine } from './geometry';
import { LifeWorld } from './simulate';
import { worldTiles } from './testing/scenarios';

const tile = { z: 16, x: 55192, y: 30266 };
const pm = 1 / metersPerUnit(tile);

function crossingRun(split: boolean, oneway = false, seconds = 120) {
  const b = new LifeBuilder();
  const center = { x: 2048, y: 2048 };
  b.line(
    [{ x: center.x - 300 * pm, y: center.y }, center, { x: center.x + 300 * pm, y: center.y }],
    LifeLine.roadMid,
    8,
    77,
    oneway ? 1 : 0,
  );
  b.line(
    [{ x: center.x, y: center.y - 300 * pm }, center, { x: center.x, y: center.y + 300 * pm }],
    LifeLine.roadMid,
    8,
    88,
    oneway ? 1 : 0,
  );
  if (split) b.splitRoadJunctions(pm, 40);
  const world = new LifeWorld({ road_mid: { car: 1 } });
  world.sync([{ key: 'intersection', tile, life: b.finish() }]);
  const life = worldTiles(world).get('intersection')!;
  life.parked.length = life.stalls.length = life.gatherers.length = 0;
  life.scenes.sites.length = 0;
  const arrivals = new Map(life.movers.map((m) => [m, { line: m.line, indicating: false }]));
  let straight = 0,
    perpendicular = 0,
    straightIndicated = false,
    perpendicularIndicated = false,
    legal = true;
  for (let frame = 0; frame < seconds * 30; frame++) {
    world.step(1 / 30, undefined, 18);
    for (const m of life.movers) {
      if (m.kind !== 'vehicle') continue;
      if (oneway && m.dir !== life.geo.oneway![m.line]) legal = false;
      const arrival = arrivals.get(m);
      if (!arrival) continue;
      arrival.indicating ||= m.routing?.signal !== undefined;
      if (m.line === arrival.line) continue;
      if (life.geo.lineIds![m.line] === life.geo.lineIds![arrival.line]) {
        straight++;
        straightIndicated ||= arrival.indicating;
      } else {
        perpendicular++;
        perpendicularIndicated ||= arrival.indicating;
      }
      arrivals.delete(m);
    }
  }
  return {
    straight,
    perpendicular,
    straightIndicated,
    perpendicularIndicated,
    legal,
    hardCaps: life.motionStats.hardCaps,
  };
}

describe('shared interior intersections', () => {
  describe('hard-cap comparison', () => {
    let before: ReturnType<typeof crossingRun>;
    beforeAll(() => {
      before = crossingRun(false);
    });
    it('chooses straight and perpendicular exits without extra hard caps over 120 seconds', () => {
      const after = crossingRun(true);
      expect(after.straight).toBeGreaterThan(0);
      expect(after.perpendicular).toBeGreaterThan(0);
      expect(after.straightIndicated).toBe(false);
      expect(after.perpendicularIndicated).toBe(true);
      expect(after.hardCaps).toBeLessThanOrEqual(2 * before.hardCaps);
    });
  });
  it('takes only legal exits at split one-way intersections for 60 seconds', () => {
    const result = crossingRun(true, true, 60);
    expect(result.legal).toBe(true);
    expect(result.straight).toBeGreaterThan(0);
    expect(result.perpendicular).toBeGreaterThan(0);
    expect(result.straightIndicated).toBe(false);
    expect(result.perpendicularIndicated).toBe(true);
  });
});
