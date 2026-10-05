import { expect, it } from 'vitest';
import { LifeBuilder, LifeLine } from './geometry';
import { LifeWorld, type Gatherer, type Mover, type Walker } from './simulate';
import { worldTiles } from './testing/scenarios';
import { tileToLngLat } from '../raster/geometry';

const tile = { z: 16, x: 55192, y: 30266 };
const look: Walker = {
  figure: 'adult',
  shirt: 1,
  umbrella: 0,
  canopy: 2,
  lateral: 0,
  back: 0,
  step: 0,
};

it.each([false, true])(
  'marks actual mapped person sources through holds (inspection %s)',
  (inspection) => {
    const b = new LifeBuilder();
    b.line(
      [
        { x: 1000, y: 2000 },
        { x: 3000, y: 2000 },
      ],
      LifeLine.path,
      6,
    );
    const world = new LifeWorld(undefined, undefined, { enabled: false }, inspection);
    world.sync([{ key: 'sources', tile, life: b.finish() }]);
    const life = worldTiles(world).get('sources')!;
    life.movers.length = life.stalls.length = life.gatherers.length = 0;
    life.scenes.sites.length = 0;
    const implicit: Mover = {
      kind: 'person',
      line: 0,
      from: 0,
      dir: 1,
      d: 0,
      x: 1000,
      y: 2000,
      hx: 1,
      hy: 0,
      speed: 0,
      paint: 1,
      lane: 0,
      pause: 0,
      rank: 0,
    };
    const explicit: Mover = { ...implicit, x: 1300, d: 300, group: [{ ...look }] };
    const animal: Mover = { ...implicit, x: 1600, d: 600, kind: 'dog' };
    life.movers.push(implicit, explicit, animal);
    const gatherer: Gatherer = {
      place: 'monument',
      behavior: 'gather',
      x: 2000,
      y: 2000,
      cx: 2000,
      cy: 2000,
      inner: 0,
      outer: 0,
      hx: 1,
      hy: 0,
      tx: 2000,
      ty: 2000,
      speed: 0,
      pause: 0,
      walked: 0,
      rank: 0,
      walker: { ...look },
      rx: 1,
      ry: 0,
      sign: 1,
    };
    life.gatherers.push(gatherer, { ...gatherer, x: 2300, behavior: 'sit' });
    life.stalls.push({ x: 2600, y: 2000, hx: 1, hy: 0, paint: 1, shirt: 2, side: 1, rank: 0 });
    const center = tileToLngLat(tile, { x: 2000, y: 2000 });
    const at = (x: number) => tileToLngLat(tile, { x, y: 2000 })[0];
    const view = () => world.visible(18, 1, center, { rain: 1, sunAltitude: 0 });
    const verify = () => {
      const agents = view();
      expect(agents.filter((a) => a.mappedPersonMover)).toHaveLength(2);
      for (const x of [1000, 1300])
        expect(agents.find((a) => a.lng === at(x))?.mappedPersonMover).toBe(true);
      for (const x of [1600, 2000, 2300, 2600])
        expect(agents.find((a) => a.lng === at(x))?.mappedPersonMover).toBeUndefined();
      expect(agents.find((a) => a.lng === at(2300))?.people?.[0]?.figure).toBe('umbrella');
      return agents;
    };
    const published = verify(),
      saved = structuredClone(published);
    implicit.pause = explicit.pause = 10;
    explicit.waiting = 20;
    verify();
    const site = {
      x: explicit.x,
      y: explicit.y,
      kind: 'rest' as const,
      modes: 0,
      covered: false,
      queue: [explicit],
      capacity: 4,
      hx: 1,
      hy: 0,
      road: -1,
      roadWidth: 0,
      direction: 1,
    };
    for (const state of ['wait', 'purchase', 'rest', 'shelter'] as const) {
      life.scenes.visits.set(explicit, {
        site,
        state,
        path: [],
        trail: [{ x: explicit.x, y: explicit.y }],
        next: 0,
        time: 10,
        seat: 0,
        sheltering: false,
        blocked: 0,
      });
      verify();
    }
    life.scenes.visits.delete(explicit);
    if (inspection) {
      const selected = published.find((a) => a.lng === at(1300))!;
      world.inspection!.select({ id: selected.inspectionId!, revision: 1, time: 0 }, 0);
      verify();
    }
    expect(published).toEqual(saved);
    expect(structuredClone(view())).toEqual(view());
  },
);
