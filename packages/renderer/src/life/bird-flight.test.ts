import { describe, expect, it } from 'vitest';
import { stepBirdFlight, type BirdFlight } from './bird-flight';
import { BIRD_FLIGHT } from './config';

const make = (phase: number): BirdFlight => ({ x: 20, y: 0, hx: -1, hy: 0, speed: 10, phase });

describe('individual airborne steering', () => {
  it.each([30, 60, 120])('arrives at nearby resting slots at %s Hz', (rate) => {
    for (const phase of [0.1, 0.35, 0.65, 0.9]) {
      const bird: BirdFlight = { x: 0, y: 0, hx: 1, hy: 0, speed: 10, phase };
      let joined = false;
      for (let frame = 0; frame < 10 * rate && !joined; frame++) {
        const before = { ...bird };
        joined = stepBirdFlight(
          bird,
          { dt: 1 / rate, targetX: 0, targetY: 1, speed: 10, resting: true },
          BIRD_FLIGHT,
        );
        if (!joined) {
          const turn = Math.abs(
            Math.atan2(
              before.hx * bird.hy - before.hy * bird.hx,
              before.hx * bird.hx + before.hy * bird.hy,
            ),
          );
          expect(turn).toBeLessThanOrEqual((BIRD_FLIGHT.turn * 1.15) / rate + 1e-8);
          expect(Math.abs(bird.speed - before.speed)).toBeLessThanOrEqual(
            (10 * BIRD_FLIGHT.accelerate * 1.25) / rate + 1e-8,
          );
        }
      }
      expect(joined).toBe(true);
      expect([bird.x, bird.y]).toEqual([0, 1]);
    }
  });

  it.each([30, 60, 120])('catches a moving formation slot at %s Hz', (rate) => {
    const bird: BirdFlight = { x: 0, y: 0, hx: 1, hy: 0, speed: 10, phase: 0.1 };
    let joined = false;
    for (let frame = 0; frame < 10 * rate && !joined; frame++)
      joined = stepBirdFlight(
        bird,
        { dt: 1 / rate, targetX: 10 + (10 * frame) / rate, targetY: 1, speed: 10 },
        BIRD_FLIGHT,
      );
    expect(joined).toBe(true);
  });

  it.each([30, 60, 120])('banks around a head-on pointer without stopping at %s Hz', (rate) => {
    for (const phase of [0.1, 0.35, 0.65, 0.9]) {
      const bird = make(phase);
      let joined = false;
      for (let frame = 0; frame < 20 * rate && !joined; frame++) {
        const before = { ...bird };
        joined = stepBirdFlight(
          bird,
          {
            dt: 1 / rate,
            targetX: -100,
            targetY: 0,
            speed: 10,
            pointer: { x: 0, y: 0, reach: 8 },
          },
          BIRD_FLIGHT,
        );
        const move = Math.hypot(bird.x - before.x, bird.y - before.y);
        expect(move).toBeGreaterThan(0);
        expect(move).toBeLessThanOrEqual(23 / rate + 1e-8);
        expect(Math.hypot(bird.x, bird.y)).toBeGreaterThanOrEqual(8);
        expect(Math.hypot(bird.hx, bird.hy)).toBeCloseTo(1);
        if (!joined) {
          const turn = Math.abs(
            Math.atan2(
              before.hx * bird.hy - before.hy * bird.hx,
              before.hx * bird.hx + before.hy * bird.hy,
            ),
          );
          expect(turn).toBeLessThanOrEqual((BIRD_FLIGHT.turn * 1.15) / rate + 1e-8);
          expect(Math.abs(bird.speed - before.speed)).toBeLessThanOrEqual(
            (10 * BIRD_FLIGHT.accelerate * 1.25) / rate + 1e-8,
          );
        }
      }
      expect(joined).toBe(true);
    }
  });

  it('splits aligned birds into different turns and escape speeds', () => {
    const birds = [make(0.1), make(0.9)];
    for (let frame = 0; frame < 30; frame++)
      for (const bird of birds)
        stepBirdFlight(
          bird,
          {
            dt: 1 / 60,
            targetX: -100,
            targetY: 0,
            speed: 10,
            pointer: { x: 0, y: 0, reach: 8 },
          },
          BIRD_FLIGHT,
        );
    expect(birds[0]!.y * birds[1]!.y).toBeLessThan(0);
    expect(birds[0]!.speed).not.toBeCloseTo(birds[1]!.speed);
  });

  it('keeps flying when the pointer appears at the exact bird position, then regroups', () => {
    const bird: BirdFlight = { x: 0, y: 0, hx: 1, hy: 0, speed: 10, phase: 0.1 };
    for (let frame = 0; frame < 120; frame++) {
      const before = { ...bird };
      stepBirdFlight(
        bird,
        { dt: 1 / 60, targetX: 100, targetY: 0, speed: 10, pointer: { x: 0, y: 0, reach: 8 } },
        BIRD_FLIGHT,
      );
      expect(Math.hypot(bird.x - before.x, bird.y - before.y)).toBeGreaterThan(0);
      if (frame >= 90) expect(Math.hypot(bird.x, bird.y)).toBeGreaterThanOrEqual(8);
    }
    let joined = false;
    for (let frame = 0; frame < 1200 && !joined; frame++)
      joined = stepBirdFlight(
        bird,
        { dt: 1 / 60, targetX: 100, targetY: 0, speed: 10 },
        BIRD_FLIGHT,
      );
    expect(joined).toBe(true);
    expect(bird.x).toBe(100);
    expect(bird.y).toBe(0);
  });
});
