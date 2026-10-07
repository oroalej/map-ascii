import { describe, expect, it } from 'vitest';
import { metersPerUnit } from '../raster/geometry';
import { LifeBuilder, LifeLine } from './geometry';
import { hashString, LifeWorld, TileLife, type Mover } from './simulate';
import { signalState } from './signals';
import {
  hasTurnSignals,
  SIGNAL_VEHICLES,
  turnSide,
  visibleTurnSignal,
  type TurnSide,
} from './turn-signals';

const tile = { z: 16, x: 55192, y: 30266 };
const pm = 1 / metersPerUnit(tile);
const point = (x: number, y: number) => ({ x: 2048 + x * pm, y: 2048 + y * pm });
function network(
  arms: readonly (readonly [number, number])[] = [
    [100, 0],
    [0, -100],
    [0, 100],
  ],
  signal = false,
) {
  const b = new LifeBuilder();
  b.line([point(-100, 0), point(-40, 0), point(0, 0)], LifeLine.roadMajor, 12);
  for (const [x, y] of arms) b.line([point(0, 0), point(x, y)], LifeLine.roadMajor, 12);
  if (signal) b.signal(point(0, 0), 6, 90, 0, true);
  return b.finish();
}
function position(m: Mover, distance: number) {
  m.from = distance > 40 ? 0 : 1;
  m.d = ((distance > 40 ? 100 : 40) - distance) * pm;
  m.x = 2048 - distance * pm;
  m.y = 2048;
  m.hx = 1;
  m.hy = 0;
}
function fixture(arms?: readonly (readonly [number, number])[], signal = false) {
  const life = new TileLife(tile, network(arms, signal), 1);
  const m: Mover = {
    kind: 'vehicle',
    vehicle: 'car',
    line: 0,
    from: 1,
    dir: 1,
    d: 0,
    speed: 8 * pm,
    paint: 0,
    lane: 0,
    pause: 0,
    rank: 0,
    x: 0,
    y: 0,
    hx: 1,
    hy: 0,
  };
  position(m, 19);
  life.movers.splice(0, life.movers.length, m);
  life.parked.length = 0;
  return { life, m };
}
function turning(side: TurnSide, signal = false) {
  for (let seed = 0; seed < 100; seed++) {
    const result = fixture(undefined, signal);
    result.m.routing = { seed: hashString(`test/${seed}`), turns: 0 };
    result.life.step(0.1, undefined, undefined, undefined, undefined, () => false);
    if (result.m.routing.plan?.side === side) return result;
  }
  throw new Error(`No seeded ${side} turn`);
}

describe('turn indicators', () => {
  it('classifies heading-relative left and right in north-up world coordinates', () => {
    for (const heading of [0, Math.PI / 2, Math.PI, -Math.PI / 2, Math.PI / 4]) {
      const vector = (angle: number) => [Math.cos(angle), Math.sin(angle)];
      expect(turnSide(vector(heading), vector(heading + Math.PI / 2))).toBe('right');
      expect(turnSide(vector(heading), vector(heading - Math.PI / 2))).toBe('left');
    }
    expect(turnSide([1, 0], [1, 0])).toBeUndefined();
    expect(turnSide([1, 0], [-1, 0])).toBeUndefined();
    expect(turnSide([0, 0], [1, 0])).toBeUndefined();
    const out = (degrees: number) => [
      Math.cos((degrees * Math.PI) / 180),
      Math.sin((degrees * Math.PI) / 180),
    ];
    expect(turnSide([1, 0], out(29))).toBeUndefined();
    expect(turnSide([1, 0], out(30))).toBe('right');
    expect(turnSide([1, 0], out(149))).toBe('right');
    expect(turnSide([1, 0], out(150))).toBeUndefined();
  });

  it('covers all six motors and excludes other craft', () => {
    for (const vehicle of SIGNAL_VEHICLES) {
      expect(hasTurnSignals(vehicle)).toBe(true);
      const { life, m } = fixture();
      m.vehicle = vehicle;
      life.step(0.1, undefined, undefined, undefined, undefined, () => false);
      expect(m.routing?.plan).toBeDefined();
    }
    for (const vehicle of ['bicycle', 'motorboat', 'locomotive', 'cart', undefined] as const)
      expect(hasTurnSignals(vehicle)).toBe(false);
  });

  it('plans once before braking and retains the exit through rejected steps', () => {
    const { life, m } = turning('right');
    const routing = m.routing;
    for (let i = 0; i < 20; i++)
      life.step(0.1, undefined, undefined, undefined, undefined, () => false);
    expect(m.routing).toBe(routing);
    expect(m.routing?.turns).toBe(0);
    expect(m.x).toBe(2048 - 19 * pm);
  });

  it('measures lead across intermediate vertices using normal speed', () => {
    const { life, m } = fixture();
    m.speed = 30 * pm;
    position(m, 61);
    life.step(0.1, undefined, undefined, undefined, undefined, () => false);
    expect(m.routing?.plan).toBeDefined();
    expect(m.routing?.indicating).not.toBe(true);
    position(m, 59);
    life.step(0.1, undefined, undefined, undefined, undefined, () => false);
    expect(m.routing?.plan?.vertex).toBe(2);
    expect(m.routing?.indicating).toBe(true);
  });

  it('keeps signaling at a red light and follows the planned exit after green', () => {
    const { life, m } = turning('left', true);
    const planned = m.routing!.plan!;
    const seed = life.signals.signals[0]!.seed;
    const red = Array.from({ length: 150 }, (_, t) => t).find(
      (t) => signalState(seed, t).a === 'red',
    )!;
    const green = Array.from({ length: 150 }, (_, t) => t).find(
      (t) => signalState(seed, t).a === 'green',
    )!;
    for (let i = 0; i < 150; i++)
      life.step(0.1, undefined, undefined, undefined, { rain: 0, clock: red });
    expect(m.line).toBe(0);
    expect(m.routing?.plan).toBe(planned);
    expect(visibleTurnSignal(m.routing, red)?.side).toBe('left');
    for (let i = 0; i < 40 && m.line === 0; i++)
      life.step(0.1, undefined, undefined, undefined, { rain: 0, clock: green });
    expect(m.line).toBe(planned.exit >> 1);
    expect(m.routing?.signal?.side).toBe('left');
  });

  it('rolls back crossings and counts only accepted junction transitions', () => {
    const { life, m } = turning('right');
    position(m, 0.1);
    const before = m.routing;
    life.step(0.1, undefined, undefined, undefined, undefined, () => false);
    expect(m.routing).toBe(before);
    expect(m.line).toBe(0);
    // Reject full and half steps, accepting the quarter step after the same endpoint.
    m.v = m.speed;
    life.step(
      0.1,
      undefined,
      undefined,
      undefined,
      undefined,
      (owner) => 'd' in owner && owner.line !== 0 && owner.d <= 0.1 * pm + 1e-8,
    );
    expect(m.line).toBe(before!.plan!.exit >> 1);
    expect(m.routing?.turns).toBe(1);
    expect(m.routing?.plan).toBeUndefined();
    expect(m.routing?.signal?.remaining).toBeCloseTo(6 + 2.2 + 1 - m.d / pm);
    const after = m.routing;
    life.step(0.1, undefined, undefined, undefined, undefined, () => false);
    expect(m.routing).toBe(after);
    for (let i = 0; i < 50; i++) life.step(0.1);
    expect(m.routing?.signal).toBeUndefined();
  });

  it('omits ordinary bends, straight exits, dead ends and U-turn exits', () => {
    for (const arms of [
      [[0, 100]],
      [],
      [[-100, 0]],
      [
        [100, 0],
        [0, 100],
      ],
    ] as const) {
      const { life, m } = fixture(arms);
      // Pick a straight exit when this fixture has a branch.
      if (arms.length === 2) {
        for (let seed = 0; seed < 100; seed++) {
          m.routing = { seed, turns: 0 };
          life.step(0.1, undefined, undefined, undefined, undefined, () => false);
          if (m.routing.plan?.exit === 2) break;
        }
        expect(m.routing?.plan?.exit).toBe(2);
      } else life.step(0.1, undefined, undefined, undefined, undefined, () => false);
      expect(visibleTurnSignal(m.routing, 0)).toBeUndefined();
    }
  });

  it('invalidates an intention when its incoming direction changes', () => {
    const { life, m } = turning('right');
    m.dir = -1;
    m.d = 0;
    life.step(0.1, undefined, undefined, undefined, undefined, () => false);
    expect(m.routing?.plan).toBeUndefined();
  });

  it('uses identical seeded exits at 30, 60 and 120 Hz', () => {
    const outputs = [30, 60, 120].map((fps) => {
      const { life, m } = fixture();
      for (let i = 0; i < fps * 4; i++) life.step(1 / fps);
      return { line: m.line, turns: m.routing?.turns, signal: visibleTurnSignal(m.routing, 4) };
    });
    expect(outputs[1]).toEqual(outputs[0]);
    expect(outputs[2]).toEqual(outputs[0]);
  });

  it('blinks on the simulation clock with a seeded half-second duty cycle', () => {
    const routing = { seed: 0, turns: 1, signal: { side: 'right' as const, remaining: 10 } };
    expect(visibleTurnSignal(routing, 0)).toEqual({ side: 'right', on: true });
    expect(visibleTurnSignal(routing, 0.49)?.on).toBe(true);
    expect(visibleTurnSignal(routing, 0.5)?.on).toBe(false);
    expect(visibleTurnSignal(routing, 1)?.on).toBe(true);
    expect(visibleTurnSignal({ ...routing, seed: 0x8000_0000 }, 0)?.on).toBe(false);
  });

  it('exposes turn phases through visible agents and releases tile-owned state', () => {
    const world = new LifeWorld();
    world.sync([{ key: 'test', tile, life: network() }]);
    for (let i = 0; i < 100; i++) world.step(0.1, undefined, 21);
    const agents = world.visible(21, 1, [123.19, 13.62]);
    expect(agents.some((agent) => agent.turnSignal)).toBe(true);
    world.sync([]);
    expect(world.visible(21, 1, [123.19, 13.62])).toEqual([]);
  });
});
