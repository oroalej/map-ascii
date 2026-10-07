import { describe, expect, it } from 'vitest';
import assert from 'node:assert/strict';
import type { TrafficMix } from '@atlas/shared';
import { LifeInspection } from './inspection';
import { LifeWorld, type VisibleAgent } from './simulate';
import { makeScenario, worldTiles } from './testing/scenarios';
import { bounded } from './testing/scenario-checks';
import { createInlineHost } from './host';
import { createLifeWorkerApi, type FrameInput } from './worker-api';
import { UMBRELLA_MOTION } from './config';

class ItemWorld extends LifeWorld {
  constructor(traffic?: TrafficMix) {
    super(traffic, undefined, undefined, true);
  }
}
const pose = (a: VisibleAgent) => [a.lng, a.lat, a.ahead, a.flap, a.people, a.turnSignal];
const person = (lng = 0): VisibleAgent => ({ kind: 'person', lng, lat: 0, flap: 0 });

describe('per-item inspection', () => {
  it('admits reordered capped identities with collisions and releases an evicted selection', () => {
    const inspection = new LifeInspection(),
      owners = Array.from({ length: 8 }, () => ({}));
    const frame = () => owners.map((owner) => inspection.present(owner, person()));
    inspection.begin(0);
    let views = frame();
    inspection.finish(views);
    const id = views[0]!.inspectionId!;
    inspection.select({ id, revision: 1, time: 0 }, 0);
    inspection.begin(1);
    views = frame();
    // IDs 1 and 5 collide in the four-slot admission table; copies retain numeric identity.
    inspection.finish([{ ...views[4]! }, { ...views[0]! }], true);
    expect(inspection.ack.id).toBe(id);
    inspection.begin(2);
    views = frame();
    inspection.finish([views[4]!], true);
    expect(inspection.ack.id).toBeNull();
    inspection.select({ id, revision: 2, time: 2 }, 2);
    expect(inspection.ack.id).toBeNull();
  });
  it('fences owner-local records between registries and clears without changing simulation clones', () => {
    const owner = { x: 1 },
      a = new LifeInspection(),
      b = new LifeInspection();
    a.begin(0);
    const first = a.present(owner, person());
    a.finish([first]);
    a.select({ id: first.inspectionId!, revision: 1, time: 0 }, 0);
    b.begin(1);
    const other = b.present(owner, person());
    b.finish([other]);
    expect(a.clock(owner, 10)).toBe(0);
    expect(b.clock(owner, 10)).toBe(10);
    a.begin(10);
    expect(a.present(owner, person()).inspectionId).toBe(first.inspectionId);
    expect(structuredClone(owner)).toEqual({ x: 1 });
    a.clear();
    a.begin(11);
    expect(a.present(owner, person()).inspectionId).not.toBe(first.inspectionId);
    expect(b.present(owner, person()).inspectionId).toBe(other.inspectionId);
  });
  it('keeps an actor identity across output copies and rejects deleted identities', () => {
    const inspection = new LifeInspection(),
      owner = {};
    inspection.begin(0);
    const first = inspection.present(owner, person());
    inspection.finish([first]);
    inspection.begin(1);
    const next = inspection.present(owner, person(1));
    expect(next.inspectionId).toBe(first.inspectionId);
    inspection.finish([next]);
    inspection.select({ id: first.inspectionId!, revision: 1, time: 1 }, 1);
    expect(inspection.held(owner)).toBe(true);
    inspection.begin(2);
    inspection.finish([]);
    expect(inspection.ack.id).toBeNull();
    inspection.clear();
    inspection.begin(3);
    expect(inspection.present(owner, person()).inspectionId).not.toBe(first.inspectionId);
  });

  it('freezes local clocks, renews revisions, switches actors and resumes without lost time', () => {
    const inspection = new LifeInspection(),
      a = {},
      b = {};
    inspection.begin(0);
    const aa = inspection.present(a, { ...person(), candle: true });
    const bb = inspection.present(b, person(1));
    inspection.finish([aa, bb]);
    inspection.select({ id: aa.inspectionId!, revision: 1, time: 10 }, 2);
    inspection.select({ id: aa.inspectionId!, revision: 2, time: 15 }, 7);
    expect(inspection.clock(a, 7)).toBe(2);
    expect(inspection.clock(b, 7)).toBe(7);
    expect(inspection.present(a, { ...person(), candle: true }).effectClock).toBe(-12);
    inspection.select({ id: bb.inspectionId!, revision: 3, time: 15 }, 7);
    expect(inspection.clock(a, 7)).toBe(2);
    expect(inspection.held(b)).toBe(true);
    inspection.select({ id: aa.inspectionId!, revision: 1, time: 3 }, 1);
    expect(inspection.ack).toEqual({ id: bb.inspectionId, revision: 3 });
    expect(inspection.present(a, { ...person(), candle: true }).effectClock).toBe(5);
    inspection.select({ id: null, revision: 4, time: 16 }, 8);
    expect(inspection.clock(a, 8)).toBe(3);
  });

  it('presents current bird poses through selection and release with stable identity', () => {
    const inspection = new LifeInspection(),
      owner = {};
    inspection.begin(0);
    const first = inspection.present(owner, { kind: 'bird', lng: 0, lat: 0, flap: 0 });
    inspection.finish([first]);
    inspection.select({ id: first.inspectionId!, revision: 1, time: 0 }, 0);
    expect(inspection.ack.id).toBeNull();
    expect(inspection.held(owner)).toBe(false);
    for (let frame = 1; frame <= 3; frame++) {
      inspection.begin(frame);
      const current: VisibleAgent = {
        kind: 'bird',
        lng: frame,
        lat: frame,
        flap: frame & 1,
        ahead: [frame + 1, frame],
      };
      const view = inspection.present(owner, { ...current });
      expect(pose(view)).toEqual(pose(current));
      expect(view.inspectionId).toBe(first.inspectionId);
      expect(inspection.clock(owner, frame)).toBe(frame);
      inspection.finish([view]);
      inspection.select({ id: null, revision: frame + 1, time: frame }, frame);
    }
  });

  it('holds the actual mover state while other actors and traffic clocks continue', () => {
    const s = makeScenario('crossroads', 1, false, 1, ItemWorld);
    const before = s.step(0);
    const selected = before.find((a) => a.kind === 'vehicle' && !a.parked)!;
    expect(selected).toBeDefined();
    s.world.inspection!.select(
      { id: selected.inspectionId!, revision: 1, time: 0 },
      s.world.signalClock,
    );
    const heldMover = [...worldTiles(s.world).values()]
      .flatMap((t) => t.movers)
      .find((m) => s.world.inspection!.held(m))!;
    const state = structuredClone(heldMover);
    const clock = s.world.signalClock;
    let after = before;
    for (let frame = 1; frame <= 60; frame++) after = s.step(frame);
    expect(heldMover).toEqual(state);
    expect(pose(after.find((a) => a.inspectionId === selected.inspectionId)!)).toEqual(
      pose(selected),
    );
    expect(s.world.signalClock).toBeGreaterThan(clock + 1);
    const old = new Map(before.map((a) => [a.inspectionId, a]));
    expect(
      after.some(
        (a) =>
          a.inspectionId !== selected.inspectionId &&
          old.has(a.inspectionId) &&
          (a.lng !== old.get(a.inspectionId)!.lng || a.lat !== old.get(a.inspectionId)!.lat),
      ),
    ).toBe(true);
    s.world.inspection!.select({ id: null, revision: 2, time: 2 }, s.world.signalClock);
    s.step(61);
    expect(Math.hypot(heldMover.x - state.x, heldMover.y - state.y)).toBeLessThan(
      heldMover.speed / 15,
    );
  });

  it('keeps ordinary simulation state and packed poses equivalent when inspection is unused', () => {
    const ordinary = makeScenario('rain', 1),
      item = makeScenario('rain', 1, false, 1, ItemWorld);
    bounded(ordinary.world);
    bounded(item.world);
    for (let frame = 0; frame < 90; frame++) {
      const strip = (agents: VisibleAgent[]) =>
        structuredClone(agents).map(({ inspectionId: _id, candleSeed: _seed, ...agent }) => agent);
      const baseline = ordinary.step(frame);
      expect(baseline.some((agent) => Object.hasOwn(agent, 'inspectionId'))).toBe(false);
      assert.deepEqual(strip(item.step(frame)), strip(baseline));
    }
  });

  it('holds a changing canopy beyond lost and resumes from its attained openness', () => {
    const s = makeScenario('rain', 1, false, 1, ItemWorld);
    const world = s.world;
    const look = (rain: number) => world.visible(19, s.levels, s.center, { rain, sunAltitude: 20 });
    look(0);
    look(1);
    let selected: VisibleAgent | undefined;
    for (let frame = 0; frame < 45 && !selected; frame++) {
      world.step(0.05);
      selected = look(1).find((a) =>
        a.people?.some((p) => p.canopy && p.canopy.open > 0.2 && p.canopy.open < 0.8),
      );
    }
    expect(selected).toBeDefined();
    const id = selected!.inspectionId!;
    const member = selected!.people!.findIndex((p) => !!p.canopy);
    const attained = selected!.people![member]!.canopy!.open;
    world.inspection!.select({ id, revision: 1, time: world.signalClock }, world.signalClock);
    for (let frame = 0; frame < Math.ceil(UMBRELLA_MOTION.lost / 0.05) + 10; frame++) {
      world.step(0.05);
      expect(look(1).find((a) => a.inspectionId === id)!.people).toEqual(selected!.people);
    }
    world.inspection!.select({ id: null, revision: 2, time: world.signalClock }, world.signalClock);
    expect(look(1).find((a) => a.inspectionId === id)!.people![member]!.canopy!.open).toBeCloseTo(
      attained,
    );
    world.step(0.05);
    const resumed = look(1).find((a) => a.inspectionId === id)!.people![member]!.canopy!.open;
    expect(resumed).toBeGreaterThan(attained);
    expect(resumed).toBeLessThan(1);
  });

  it('snaps close-view reentry after inspection has offset the owner clock', () => {
    for (const initialRain of [0, 1]) {
      const s = makeScenario('rain', 1, false, 1, ItemWorld);
      const world = s.world;
      const life = [...worldTiles(world).values()][0]!;
      const m = life.movers.find((m) => m.group)!;
      life.movers.splice(0, life.movers.length, m);
      life.stalls.length = 0;
      life.flocks.length = 0;
      m.rank = 0;
      m.pause = 100;
      m.group = [{ ...m.group![0]!, figure: 'adult', umbrella: 0.23, lateral: 0, back: 0 }];
      const look = (zoom: number, rain: number) =>
        world.visible(zoom, s.levels, s.center, { rain, sunAltitude: 20 })[0]!;
      const original = look(19, initialRain);
      const id = original.inspectionId!;
      world.inspection!.select({ id, revision: 1, time: world.signalClock }, world.signalClock);
      for (let frame = 0; frame < 20; frame++) {
        world.step(0.05);
        expect(look(19, initialRain).people).toEqual(original.people);
      }
      world.inspection!.select(
        { id: null, revision: 2, time: world.signalClock },
        world.signalClock,
      );
      const ownerClock = world.inspection!.clock(m, world.signalClock);
      expect(world.signalClock - ownerClock).toBeGreaterThan(UMBRELLA_MOTION.lost);
      const distant = look(18, 1 - initialRain);
      world.step(0.1);
      expect(look(19, 1 - initialRain).people).toEqual(distant.people);
      expect(look(19, initialRain).people).toEqual(distant.people);
      let animated = false;
      const frames = Math.ceil((UMBRELLA_MOTION.stagger + UMBRELLA_MOTION.close) / 0.05) + 1;
      for (let frame = 0; frame < frames; frame++) {
        world.step(0.05);
        const agent = look(19, initialRain);
        animated ||= !!agent.people![0]!.canopy;
        if (frame === frames - 1) expect(agent.people).toEqual(original.people);
      }
      expect(animated).toBe(true);
    }
  });

  it('applies the same commands and poses in the inline and worker APIs', async () => {
    const s = makeScenario('crossroads', 1);
    const world = new ItemWorld();
    const inline = createInlineHost(world, undefined, () => 0);
    const context = { bounds: s.bounds, spawnMarginM: 12 };
    inline.sync(s.tiles, s.center, context);
    const worker = createLifeWorkerApi(() => 0);
    worker.init({ processions: [], itemInspection: true });
    worker.sync(s.tiles, s.center, context);
    const input: FrameInput = {
      gust: {
        camera: { lng: s.center[0], lat: s.center[1], zoom: 18 },
        size: { width: 390, height: 844 },
        cssCell: { w: 10, h: 18 },
        time: 0,
        wind: { dir: [1, 0], strength: 0 },
      },
      step: {
        dt: 1 / 30,
        zoom: 18,
        bounds: s.bounds,
        wind: undefined,
        weather: undefined,
        cellMeters: 0.9,
      },
      visible: [18, s.levels, s.center],
      inspection: { id: null, revision: 0, time: 0 },
    };
    inline.request(input);
    let reply = worker.frame(input);
    for (let frame = 0; !reply.agents.length && frame < 300; frame++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      inline.request(input);
      reply = worker.frame(input);
    }
    const id = reply.agents[0]!.inspectionId!;
    for (let frame = 1; frame <= 10; frame++) {
      input.inspection = { id: frame < 8 ? id : null, revision: frame, time: frame / 30 };
      inline.request(input);
      reply = worker.frame(input);
      // Model the real worker boundary: owner-local symbol records are not serialized.
      expect(structuredClone(reply.agents)).toEqual(structuredClone(inline.latest()!.agents));
      expect(reply).not.toHaveProperty('inspection');
    }
    inline.dispose();
  });
});
