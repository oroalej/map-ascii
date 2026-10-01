import { describe, expect, it, vi } from 'vitest';
import { TileLife, LifeWorld, type VisibleAgent } from './simulate';
import { continuityMover, continuityTile, left, right, parent } from './testing/continuity';
import { worldTiles } from './testing/scenarios';
import { BRAKE, BRAKE_LAMP } from './lamps';
import { emitter, PUFF, stepEmitter } from './exhaust';
import { ensureVehicleEffects, vehicleEffects } from './vehicle-effects';
import { packLife, type LifeGrid } from './draw';
import { Paint, VehiclePart } from './vehicles';
import { TURN_SIGNAL_BIT } from './turn-signals';
import { themes } from '../theme';
import { tileToLngLat } from '../raster/geometry';

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
};
const puff: VisibleAgent = {
  kind: 'vehicle',
  prop: 'puff',
  lng: 40,
  lat: 40,
  ahead: [43, 40],
  flap: 0,
  puff: { kind: 'diesel', vehicle: 'bus', age: 0.2 },
};
const packed = (agents: VisibleAgent[], customGrid = grid) => {
  const out = new Uint8Array(customGrid.cols * customGrid.rows * 4);
  const count = packLife(
    out,
    customGrid,
    agents,
    themes.dark,
    (g) => (g.codePointAt(0)! % 1023) + 1,
  );
  return { out, count };
};

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
    expect(vehicleEffects(preview)?.exhaust).toBe(state.exhaust);
    expect(target.adoptFrom(m, source)).toBe(true);
    expect(vehicleEffects(m)?.exhaust).toBe(vehicleEffects(preview)?.exhaust);
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
    vi.spyOn(life!.scenes, 'held').mockReturnValue(true);
    for (let i = 0; i < 8; i++) {
      world.step(0.1);
      const a = world
        .visible(20, 1, tileToLngLat(left, m))
        .find((a) => !a.prop && a.vehicle === 'bus')!;
      expect(a.lamps?.kind).toBe('hazard');
      expect(a.turnSignal).toBeUndefined();
      expect(vehicleEffects(m)?.brake).toBe(0);
    }
  });
  it('admits nearest puffs separately from a zero ordinary-agent cap', () => {
    const { world, lives } = fixture();
    for (const life of lives)
      for (let i = 0; i < PUFF.cap; i++)
        life.puffs.add({
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
    const center = tileToLngLat(left, { x: 1000, y: 2000 });
    const agents = world.visible(20, 1, center, undefined, undefined, 1, 0);
    expect(agents).toHaveLength(PUFF.visible);
    expect(agents.every((a) => a.prop === 'puff' && !a.vehicle)).toBe(true);
    expect(world.visible(14, 1, center)).toEqual([]);
    world.clearTiles();
    expect(world.visible(20, 1, center)).toEqual([]);
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
    expect(packed([{ ...car, parked: true, lamps: { kind: 'brake' } }]).out).toEqual(
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
    expect(packed([{ ...car, lamps: { kind: 'hazard', on: false } }]).out).toEqual(normal.out);
    expect(packed([{ ...car, parked: true, lamps: { kind: 'hazard', on: true } }]).out).toEqual(
      packed([{ ...car, parked: true }]).out,
    );
    const denied = packed([{ ...car, lamps: { kind: 'hazard', on: true } }], {
      ...grid,
      allowsGroundCell: () => false,
    });
    expect(denied.count).toBe(0);
    expect(denied.out.every((b) => b === 0)).toBe(true);
  });
  it('never reserves, displaces or counts a puff as an actor, regardless of input order', () => {
    const alone = packed([car]);
    for (const agents of [
      [puff, car],
      [car, puff],
    ]) {
      const withPuff = packed(agents);
      expect(withPuff.out).toEqual(alone.out);
      expect(withPuff.count).toBe(alone.count);
    }
    expect(packed([puff]).count).toBe(0);
    expect(packed([puff, car], { ...grid, allowsGroundCell: () => false }).out).toEqual(
      packed([puff]).out,
    );
    const mini = { ...puff, ahead: [40.01, 40] as [number, number] };
    expect(packed([mini]).out.every((b) => b === 0)).toBe(true);
    const guards = vi.fn(() => true);
    packed([puff], { ...grid, allowsGroundCell: guards });
    expect(guards).not.toHaveBeenCalled();
  });
});
