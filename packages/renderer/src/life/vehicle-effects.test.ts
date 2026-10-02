import { describe, expect, it, vi } from 'vitest';
import { TileLife, LifeWorld, type VisibleAgent } from './simulate';
import { continuityMover, continuityTile, left, right, parent } from './testing/continuity';
import { worldTiles } from './testing/scenarios';
import { BRAKE, BRAKE_LAMP } from './lamps';
import {
  emitter,
  PUFF,
  stepEmitter,
  PUFF_STRIDE,
  PUFF_AGE_MASK,
  PUFF_KIND_BIT,
  puffGlyph,
} from './exhaust';
import { classId } from '../classes';
import { unpackGlyph } from '../glyphs/select';
import { PersonPart, personByte } from './people';
import { ensureVehicleEffects, vehicleEffects } from './vehicle-effects';
import { packLife, type LifeGrid } from './draw';
import { Paint, VehiclePart } from './vehicles';
import { TURN_SIGNAL_BIT } from './turn-signals';
import { themes } from '../theme';
import { tileToLngLat } from '../raster/geometry';
import type { Visit } from './interactions';

const siteAt = (m: { x: number; y: number }): Visit['site'] => ({
  x: m.x,
  y: m.y,
  kind: 'terminal',
  modes: 3,
  covered: false,
  queue: [],
  capacity: 3,
  hx: 1,
  hy: 0,
  road: 0,
  roadWidth: 12,
  direction: 1,
});

function fixture() {
  const world = new LifeWorld();
  world.sync([continuityTile(left), continuityTile(right)]);
  const lives = [...worldTiles(world).values()];
  for (const life of lives) {
    life.movers.length =
      life.flocks.length =
      life.gatherers.length =
      life.parked.length =
      life.stalls.length =
        0;
  }
  return { world, lives };
}
const grid: LifeGrid = {
  cols: 80,
  rows: 80,
  cellWidth: 6,
  cellHeight: 11,
  toCell: (x, y) => [x, y],
};
const car: VisibleAgent = {
  kind: 'vehicle',
  vehicle: 'car',
  paint: Paint.red,
  lng: 40,
  lat: 40,
  ahead: [43, 40],
  side: [40, 43],
  flap: 0,
  sourceId: 1,
};
const puff = (age = 0.2, kind = 0, x = 40, y = 40) =>
  new Float64Array([1, x, y, x + 3, y, age, kind, 3]);
const glyphIndex = (g: string) => (g.codePointAt(0)! % 1023) + 1;
const packed = (agents: VisibleAgent[], customGrid = grid, puffs = new Float64Array(0)) => {
  const out = new Uint8Array(customGrid.cols * customGrid.rows * 4);
  const count = packLife(
    out,
    customGrid,
    agents,
    themes.dark,
    glyphIndex,
    undefined,
    undefined,
    puffs,
  );
  return { out, count };
};
const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);

describe('accepted vehicle effects', () => {
  it('matches accepted-speed scheduling through stationary fast paths and pull-away', () => {
    const entry = continuityTile(left),
      life = new TileLife(left, entry.life, 1);
    life.movers.length = 0;
    const m = continuityMover(life, 1000);
    m.vehicle = 'bus';
    life.movers.push(m);
    life.step(0.1, undefined, undefined, undefined, undefined, () => false);
    const reference = { ...vehicleEffects(m)!.exhaust! };
    for (let frame = 0; frame < 240; frame++) {
      const before = m.v! / life.perMeter;
      const dt = 1 / 30;
      life.step(
        dt,
        undefined,
        undefined,
        undefined,
        undefined,
        frame < 180 ? () => false : undefined,
      );
      stepEmitter(reference, 'diesel', before, m.v! / life.perMeter, life.elapsed, dt, () => {});
      expect(vehicleEffects(m)!.exhaust).toEqual(reference);
    }
    expect(reference.emitted).toBeGreaterThan(0);
  });
  it('uses accepted guarded velocity in metres per second, including complete rejection', () => {
    const entry = continuityTile(left),
      life = new TileLife(left, entry.life, 1);
    life.movers.length = 0;
    const m = continuityMover(life, 1000);
    m.vehicle = 'bus';
    life.movers.push(m);
    life.step(0.1, undefined, undefined, undefined, undefined, () => false);
    expect(m.v).toBe(0);
    expect(vehicleEffects(m)?.brake).toBe(BRAKE.hold);
    expect(m.x).toBe(1000);
  });
  it('commits after world seam rejection, with no ghost pull-away puff', () => {
    const {
      world,
      lives: [source, target],
    } = fixture();
    const m = continuityMover(source!, 4095.9);
    m.vehicle = 'bus';
    m.v = 0.49 * source!.perMeter;
    const state = ensureVehicleEffects(m);
    state.exhaust = emitter(123, 0);
    state.exhaust.stopped = 2;
    source!.movers.push(m);
    const adopt = vi.spyOn(target!, 'adoptFrom').mockReturnValue(false);
    world.step(0.1);
    expect(adopt).toHaveBeenCalled();
    expect(m.v).toBe(0);
    expect(vehicleEffects(m)?.brake).toBe(BRAKE.hold);
    expect(source!.puffs.snapshot(0.1)).toEqual([]);
    expect(target!.puffs.snapshot(0.1)).toEqual([]);
  });
  it('preserves emitter identity and lamp metadata through projection and adoption', () => {
    const source = new TileLife(left, continuityTile(left).life, 1);
    const target = new TileLife(parent, continuityTile(parent).life, 1);
    source.movers.length = target.movers.length = 0;
    const m = continuityMover(source, 1000);
    m.vehicle = 'bus';
    const state = ensureVehicleEffects(m);
    state.brake = 0.2;
    state.exhaust = emitter(123, 1);
    state.exhaust.stopped = 2;
    source.movers.push(m);
    const preview = target.projectFrom(m, source)!;
    expect(vehicleEffects(preview)?.brake).toBe(state.brake);
    expect(vehicleEffects(preview)?.exhaust).toEqual(state.exhaust);
    expect(vehicleEffects(preview)?.exhaust).not.toBe(state.exhaust);
    vehicleEffects(preview)!.exhaust!.burstNext++;
    expect(state.exhaust.burstNext).toBe(0);
    expect(target.adoptFrom(m, source)).toBe(true);
    expect(vehicleEffects(m)?.exhaust).toBe(state.exhaust);
    expect(vehicleEffects(m)?.brake).toBe(0.2);
  });
  it('keeps hazard state through the off phase and suppresses turns for the whole dwell', () => {
    const {
      world,
      lives: [life],
    } = fixture();
    const m = continuityMover(life!, 1000);
    m.vehicle = 'bus';
    m.routing = { seed: 0, turns: 0, signal: { side: 'left', remaining: 1 } };
    life!.movers.push(m);
    life!.scenes.services.set(m, { site: siteAt(m), time: 20, boarded: 0, arriving: false });
    for (let i = 0; i < 8; i++) {
      world.step(0.1);
      const a = world.visible(20, 1, tileToLngLat(left, m)).find((a) => a.vehicle === 'bus')!;
      expect(a.lamps?.kind).toBe('hazard');
      expect(a.turnSignal).toBeUndefined();
      expect(vehicleEffects(m)?.brake).toBe(0);
    }
  });
  it('admits nearest puffs only from sources surviving crowd, bounds and actor limits', () => {
    const { world, lives } = fixture();
    lives.forEach((life, index) => {
      const m = continuityMover(life, 1000);
      m.vehicle = 'bus';
      m.rank = 0.5;
      ensureVehicleEffects(m).sourceId = index + 1;
      life.movers.push(m);
      for (let i = 0; i < PUFF.cap; i++)
        life.puffs.add({
          sourceId: index + 1,
          x: 1000 + i,
          y: 2000,
          hx: 1,
          hy: 0,
          vx: 0,
          vy: 0,
          t0: 0,
          life: 2,
          vehicle: 'bus',
          kind: 'diesel',
        });
    });
    const center = tileToLngLat(left, { x: 1000, y: 2000 });
    const agents = world.visible(20, 1, center);
    expect(agents).toHaveLength(2);
    expect(world.visiblePuffs.length).toBe(PUFF.visible * PUFF_STRIDE);
    world.visible(20, 1, center, undefined, undefined, 1, 1);
    expect(world.visiblePuffs.length).toBe(PUFF.cap * PUFF_STRIDE);
    expect(Array.from(world.visiblePuffs).filter((_, i) => i % PUFF_STRIDE === 0)).toEqual(
      Array(PUFF.cap).fill(1),
    );
    for (const crowd of [0, 0.3, 0.4]) {
      expect(world.visible(20, 1, center, undefined, undefined, crowd)).toEqual([]);
      expect(world.visiblePuffs.length).toBe(0);
    }
    world.visible(20, 1, center, undefined, undefined, 0.6);
    expect(world.visiblePuffs.length).toBeGreaterThan(0);
    expect(world.visible(20, 1, center, undefined, undefined, 1, 0)).toEqual([]);
    expect(world.visiblePuffs.length).toBe(0);
    world.visible(20, 1, center, undefined, [0, 0, 1, 1]);
    expect(world.visiblePuffs.length).toBe(0);
    expect(world.visible(14, 1, center)).toEqual([]);
    expect(world.visiblePuffs.length).toBe(0);
    world.clearTiles();
    expect(world.visiblePuffs.length).toBe(0);
  });
  it('skips hidden render scales and rebases on return without altering movement', () => {
    const entry = continuityTile(left),
      life = new TileLife(left, entry.life, 1);
    life.movers.length = 0;
    const m = continuityMover(life, 1000);
    m.vehicle = 'bus';
    life.movers.push(m);
    for (let i = 0; i < 60; i++)
      life.step(
        0.1,
        undefined,
        undefined,
        undefined,
        { rain: 0, effectCellMeters: 10 },
        () => false,
      );
    expect(vehicleEffects(m)).toBeUndefined();
    life.step(
      0.1,
      undefined,
      undefined,
      undefined,
      { rain: 0, effectCellMeters: 0.1 },
      () => false,
    );
    expect(vehicleEffects(m)?.exhaust?.emitted).toBe(0);
    expect(vehicleEffects(m)?.brake).toBe(BRAKE.hold);
    for (let i = 0; i < 60; i++)
      life.step(
        0.1,
        undefined,
        undefined,
        undefined,
        { rain: 0, effectCellMeters: 10 },
        () => false,
      );
    life.step(
      0.1,
      undefined,
      undefined,
      undefined,
      { rain: 0, effectCellMeters: 0.1 },
      () => false,
    );
    expect(vehicleEffects(m)?.exhaust?.emitted).toBe(0);
  });
  it('replaces cached state when an index changes and checks post-scene visits', () => {
    const entry = continuityTile(left),
      life = new TileLife(left, entry.life, 1);
    life.movers.length = 0;
    const old = continuityMover(life, 1000);
    old.vehicle = 'bus';
    life.movers.push(old);
    life.step(0.1, undefined, undefined, undefined, undefined, () => false);
    const state = { ...vehicleEffects(old)!, exhaust: { ...vehicleEffects(old)!.exhaust! } };
    const next = continuityMover(life, 1000);
    next.vehicle = 'truck';
    life.movers[0] = next;
    const visits = vi.spyOn(life.scenes, 'step').mockImplementationOnce(() => {
      life.scenes.visits.set(next, {
        site: siteAt(next),
        state: 'wait',
        path: [],
        trail: [],
        next: 0,
        time: 1,
        seat: 0,
        sheltering: false,
        blocked: 0,
      });
    });
    life.step(0.1, undefined, undefined, undefined, undefined, () => false);
    expect(vehicleEffects(next)).toBeUndefined();
    visits.mockRestore();
    life.scenes.visits.delete(next);
    life.step(0.1, undefined, undefined, undefined, undefined, () => false);
    expect(vehicleEffects(next)?.sourceId).not.toBe(state.sourceId);
    expect(vehicleEffects(old)).toEqual(state);
    expect(vehicleEffects(next)?.brake).toBe(BRAKE.hold);
    const canonical = vehicleEffects(next)!,
      lastClock = canonical.exhaust!.clock;
    next.vehicle = 'bus'; // The same identity changes from an 8 m to an 11 m craft.
    life.step(0.1, undefined, undefined, undefined, { rain: 0, effectCellMeters: 5 }, () => false);
    expect(vehicleEffects(next)).toBe(canonical);
    expect(canonical.exhaust!.clock).toBeGreaterThan(lastClock);
    const bike = continuityMover(life, 1000);
    bike.vehicle = 'bicycle';
    life.movers[0] = bike;
    life.step(0.1, undefined, undefined, undefined, undefined, () => false);
    expect(vehicleEffects(bike)).toBeUndefined();
    bike.vehicle = 'bus';
    life.step(0.1, undefined, undefined, undefined, undefined, () => false);
    expect(vehicleEffects(bike)?.sourceId).not.toBe(canonical.sourceId);
    expect(vehicleEffects(bike)?.brake).toBe(BRAKE.hold);
  });
});

describe('lamp and puff packing', () => {
  it('uses a brake flag only on active motor taillights, independent of odd paint', () => {
    const normal = packed([car]),
      braking = packed([{ ...car, lamps: { kind: 'brake' } }]);
    let tails = 0;
    for (let at = 0; at < normal.out.length; at += 4) {
      if (!normal.out[at + 2]) continue;
      const part = (normal.out[at + 3]! >> 4) & 7;
      if (part === VehiclePart.taillight) {
        tails++;
        expect(normal.out[at + 3]! & BRAKE_LAMP).toBe(0);
        expect(braking.out[at + 3]! & BRAKE_LAMP).toBe(1);
      } else expect(braking.out.slice(at, at + 4)).toEqual(normal.out.slice(at, at + 4));
    }
    expect(tails).toBeGreaterThan(0);
    sameBytes(
      packed([{ ...car, parked: true, lamps: { kind: 'brake' } }]).out,
      packed([{ ...car, parked: true }]).out,
    );
  });
  it('packs four hazards without enlarging the footprint and restores normal cells when off', () => {
    const normal = packed([car]);
    const hazard = packed([{ ...car, lamps: { kind: 'hazard', on: true } }]);
    const cells: number[] = [];
    for (let at = 0; at < hazard.out.length; at += 4) {
      if (hazard.out[at + 2]! & TURN_SIGNAL_BIT) cells.push(at);
      expect(hazard.out[at + 2]! & 127).toBe(normal.out[at + 2]);
    }
    expect(cells).toHaveLength(4);
    sameBytes(packed([{ ...car, lamps: { kind: 'hazard', on: false } }]).out, normal.out);
    sameBytes(
      packed([{ ...car, parked: true, lamps: { kind: 'hazard', on: true } }]).out,
      packed([{ ...car, parked: true }]).out,
    );
    const denied = packed([{ ...car, lamps: { kind: 'hazard', on: true } }], {
      ...grid,
      allowsGroundCell: () => false,
    });
    expect(denied.count).toBe(0);
    expect(denied.out.every((b) => b === 0)).toBe(true);
  });
  it('packs a visible puff with the correct glyph, permission and age/kind bytes', () => {
    for (const age of [0, 0.5, 1])
      for (const kind of [0, 1]) {
        const source = { ...car, vehicle: 'bus' as const };
        const result = packed([source], grid, puff(age, kind, 5, 5));
        const at = (5 * grid.cols + 5) * 4;
        const decoded = unpackGlyph(result.out[at]!, result.out[at + 1]!);
        expect(decoded.glyph).toBe(glyphIndex(puffGlyph(age)));
        expect(decoded.cls).toBe(classId('life_person'));
        expect(result.out[at + 2]).toBe(3);
        expect(result.out[at + 3]).toBe(
          personByte(
            Math.min(PUFF_AGE_MASK, Math.floor(age * 8)) | (kind ? PUFF_KIND_BIT : 0),
            PersonPart.puff,
          ),
        );
        expect(result.count).toBe(packed([source]).count);
      }
  });
  it('never reserves, displaces or counts puff cells and requires a detailed accepted source', () => {
    const alone = packed([car]);
    const overlay = packed([car], grid, puff());
    sameBytes(overlay.out, alone.out);
    expect(overlay.count).toBe(alone.count);
    const guards = vi.fn(() => false);
    expect(
      packed([car], { ...grid, allowsGroundCell: guards }, puff(0, 0, 5, 5)).out.every(
        (b) => b === 0,
      ),
    ).toBe(true);
    expect(guards).toHaveBeenCalled();
    expect(packed([], grid, puff()).out.every((b) => b === 0)).toBe(true);
    const mini = { ...car, ahead: [40.01, 40] as [number, number] };
    sameBytes(packed([mini], grid, puff(0, 0, 5, 5)).out, packed([mini]).out);
    const rotated = {
      ...car,
      ahead: [42, 42] as [number, number],
      side: [38, 42] as [number, number],
    };
    expect(packed([rotated], grid, puff(0, 0, 5, 5)).out[(5 * grid.cols + 5) * 4 + 2]).toBe(3);
    const offscreen = {
      ...car,
      lng: -100,
      lat: -100,
      ahead: [-97, -100] as [number, number],
      side: [-100, -97] as [number, number],
    };
    expect(packed([offscreen], grid, puff()).out.every((b) => b === 0)).toBe(true);
    const vendorOnly: VisibleAgent = {
      ...car,
      lng: -3,
      lat: 40,
      ahead: [-3, 43],
      side: [0, 40],
      people: [{ figure: 'adult', paint: 0, lateral: 1, back: 0, flap: 0 }],
    };
    const vendor = packed([vendorOnly]);
    expect(vendor.count).toBeGreaterThan(0);
    expect(vendor.out.some((_, at) => at % 4 === 2 && vendor.out[at] === 2)).toBe(true);
    sameBytes(packed([vendorOnly], grid, puff(0, 0, 5, 5)).out, vendor.out);
    const overlap = { ...car, sourceId: 2 };
    sameBytes(packed([overlap, car], grid, puff(0, 0, 5, 5)).out, packed([overlap, car]).out);
  });
});
