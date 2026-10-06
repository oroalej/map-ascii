/** Ownership and capacity invariants shared by the combined living-city scenario tests. */
import assert from 'node:assert/strict';
import { worldTiles, retiredTiles, SCENE_CURB_Y, makeScenario } from './scenarios';
import type { LifeWorld, Mover } from '../simulate';

export function valid(world: LifeWorld) {
  const owners = new Set<object>();
  for (const tile of [
    ...worldTiles(world).values(),
    ...[...retiredTiles(world).values()].map((entry) => entry.life),
  ]) {
    for (const m of [...tile.movers, ...tile.gatherers]) {
      assert.equal(owners.has(m), false, 'duplicate owner');
      owners.add(m);
      assert.ok([m.x, m.y, m.hx, m.hy].every(Number.isFinite), 'non-finite position');
    }
    const queued = new Set<Mover>();
    for (const site of tile.scenes.sites) {
      const seats = new Set<number>();
      for (const m of site.queue) {
        assert.equal(queued.has(m), false, 'duplicate reservation');
        queued.add(m);
        const v = tile.scenes.visits.get(m)!;
        assert.equal(v.site, site);
        for (let i = 0; i < (m.group?.length ?? 1); i++) {
          const slot = v.seat + i;
          assert.ok(slot < site.capacity, 'queue over capacity');
          assert.equal(seats.has(slot), false, 'duplicate seat');
          seats.add(slot);
        }
      }
      assert.ok(
        [...tile.scenes.services.values()].filter((s) => s.site === site).length <=
          (site.kind === 'terminal' ? 3 : 1),
        'service over capacity',
      );
      assert.ok(
        [...tile.scenes.visits.values()].filter((v) => v.site === site && v.state === 'board')
          .length <= 1,
        'multiple boarding groups',
      );
    }
    for (const [m, visit] of tile.scenes.visits) {
      assert.ok(tile.movers.includes(m), 'orphan visit');
      if (['return', 'board', 'aboard'].includes(visit.state))
        assert.equal(queued.has(m), false, 'released visit still reserves a queue slot');
      assert.equal(tile.scenes.hidden(m), visit.state === 'aboard');
    }
    for (const m of tile.scenes.services.keys())
      assert.ok(tile.movers.includes(m), 'orphan service');
    const retained = tile.scenes as unknown as {
      cooldown: Map<Mover, number>;
      stopCooldown: Map<Mover, unknown>;
    };
    assert.ok(retained.cooldown.size <= tile.movers.length);
    assert.ok(retained.stopCooldown.size <= tile.movers.length);
  }
}
export function bounded(world: LifeWorld) {
  // CI checks long lifecycles with a bounded population; CPU benchmarks retain full density.
  for (const tile of worldTiles(world).values()) {
    if (tile.movers.length <= 48) continue;
    const near = (m: Mover) => Math.hypot(m.x - 1900, m.y - SCENE_CURB_Y);
    const targets = [
      { x: 1900, y: SCENE_CURB_Y },
      tile.scenes.sites.find((s) => s.kind === 'vendor') ?? { x: 1300, y: 1800 },
      tile.scenes.sites.find((s) => s.kind === 'shelter') ?? { x: 1800, y: 800 },
    ];
    const people = targets.flatMap((p) =>
      tile.movers
        .filter((m) => m.kind === 'person')
        .sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y))
        .slice(0, 4),
    );
    const keep = [
      ...new Set(people),
      ...['vehicle', 'dog', 'cat'].flatMap((kind) =>
        tile.movers
          .filter((m) => m.kind === kind)
          .sort((a, b) => near(a) - near(b))
          .slice(0, 12),
      ),
    ];
    tile.movers.splice(0, tile.movers.length, ...keep);
    tile.gatherers.splice(12);
  }
}

/** Run a 4-tile scenario for 180 simulated seconds, checking invariants every two seconds. */
export function soak(kind: 'junction' | 'transit' | 'rain', seed: number) {
  const s = makeScenario(kind, 4, false, seed);
  bounded(s.world);
  let visits = 0,
    services = 0;
  const states = new Set<string>();
  for (let frame = 0; frame < 180 * 30; frame++) {
    const agents = s.step(frame);
    assert.ok(agents.length <= 1200, 'visible cap exceeded');
    for (const tile of worldTiles(s.world).values()) {
      visits = Math.max(visits, tile.scenes.visits.size);
      services = Math.max(services, tile.scenes.services.size);
      for (const visit of tile.scenes.visits.values()) states.add(visit.state);
    }
    if (frame % 60 === 0) valid(s.world);
  }
  valid(s.world);
  return { visits, services, states };
}
