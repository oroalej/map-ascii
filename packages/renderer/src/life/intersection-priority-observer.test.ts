import { expect, it } from 'vitest';
import { LifeWorld, type WorldGroundGuard } from './simulate';
import { LifeBuilder } from './geometry';
import type { Movement } from './junctions';
import { EMPTY_PEDESTRIANS } from './pedestrians';
import { JUNCTION } from './config';
import { VEHICLES } from './vehicles';
import { metersPerUnit } from '../raster/geometry';
import { observePriority, priorityFixture } from './testing/intersection-priority';

it.each([
  [1800, 0],
  [1801, 1],
  [3600, 1],
  [3601, 2],
])('keeps entry, walking and clearing in the same window at frame %i', (frame, window) => {
  const fixture = priorityFixture(LifeWorld, LifeBuilder, metersPerUnit);
  const { life, world } = fixture;
  const internal = world as unknown as { groundGuard: () => WorldGroundGuard };
  const original = internal.groundGuard;
  // Only admission is stubbed: the observer's independent projection and samples stay real.
  const guard: WorldGroundGuard = Object.assign(() => true, {
    remove() {},
    reserveSeam() {},
    pedestrians: () => EMPTY_PEDESTRIANS,
  });
  internal.groundGuard = () => guard;
  const observer = observePriority(fixture);
  try {
    const wrapped = internal.groundGuard();
    for (let step = 1; step < frame; step++) observer.afterStep(1 / 30);
    const before = structuredClone(observer.result());
    const car = life.movers.find((m) => m.kind === 'vehicle')!;
    const walker = life.movers.find((m) => m.kind === 'person')!;
    const pm = life.perMeter;
    const movement: Movement = {
      key: 'boundary',
      junction: { key: 'boundary', x: 2048, y: 2048, radius: 7 * pm, arms: [] },
      inHx: -1,
      inHy: 0,
      outHx: -1,
      outHy: 0,
      stop: 0,
      line: car.line,
      dir: car.dir,
      exit: { line: car.line, along: 0, out: 1, hx: -1, hy: 0 },
      ahead: 0,
    };
    observer.table.request({
      m: car,
      life,
      tileKey: 'boundary',
      index: life.movers.indexOf(car),
      movement,
      ready: true,
      inside: false,
    });
    observer.table.resolve(before.seconds);
    car.x = 2048 + (7 + JUNCTION.gap + VEHICLES[car.vehicle!].length / 2 + 0.1) * pm;
    const previous = { ...car };
    car.x -= 0.2 * pm;
    expect(wrapped(life, car, previous)).toBe(true);
    walker.x += pm;
    observer.afterStep(1 / 30);
    const after = observer.result();
    expect(after.entriesPer60).toEqual([0, 1, 2].map((i) => Number(i === window)));
    expect(after.crossingsPerArmPer60[window]![0]).toBe(1);
    for (let i = 0; i < 3; i++) {
      expect(after.walkerDistancePer60[i]![0]! - before.walkerDistancePer60[i]![0]!).toBeCloseTo(
        Number(i === window),
      );
      expect(
        after.crossingClearSecondsPer60[i]![0]! - before.crossingClearSecondsPer60[i]![0]!,
      ).toBeCloseTo(i === window ? 1 / 30 : 0);
    }
  } finally {
    observer.restore();
    internal.groundGuard = original;
  }
});
