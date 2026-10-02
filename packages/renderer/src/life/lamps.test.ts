import { describe, expect, it } from 'vitest';
import { BRAKE, brakeHold, visibleLamps } from './lamps';
import { visibleTurnSignal } from './turn-signals';

describe('vehicle lamps', () => {
  it('lights on accepted deceleration, holds, and stays lit in a queue', () => {
    expect(brakeHold(0, 5, 4.9, 0.1, false)).toBe(BRAKE.hold);
    let hold = BRAKE.hold as number;
    for (let i = 0; i < 2; i++) hold = brakeHold(hold, 5, 5, 0.1, false);
    expect(hold).toBeCloseTo(0.1);
    expect(brakeHold(hold, 5, 5, 0.1, false)).toBeCloseTo(0);
    expect(brakeHold(0, 0, 0, 0.1, false)).toBe(BRAKE.hold);
    expect(brakeHold(0, 5, 5, 0.1, false)).toBe(0);
    expect(brakeHold(BRAKE.hold, 5, 0, 0.1, true)).toBe(0);
  });
  it('keeps hazard state in the off phase, with no brakes or non-motor lamps', () => {
    const routing = { seed: 0, turns: 0 };
    expect(visibleLamps('bus', 0.3, true, routing, 0.25)).toEqual({ kind: 'hazard', on: true });
    expect(visibleLamps('bus', 0.3, true, routing, 0.75)).toEqual({ kind: 'hazard', on: false });
    expect(visibleLamps('bus', 0.3, false, routing, 0.75)).toEqual({ kind: 'brake' });
    for (const vehicle of ['bicycle', 'motorboat', 'cart'] as const)
      expect(visibleLamps(vehicle, 0.3, true, routing, 0)).toBeUndefined();
  });
  it('has a seeded 50% duty cycle independent of update rate', () => {
    for (const hz of [30, 60, 120]) {
      let on = 0;
      for (let frame = 0; frame < hz * 2; frame++) {
        const lamps = visibleLamps('jeepney', 0, true, { seed: 123456789, turns: 0 }, frame / hz);
        if (lamps?.kind === 'hazard' && lamps.on) on++;
      }
      expect(on).toBe(hz);
    }
  });
  it('shares blink phase with indicators for signed clocks and every supported cadence', () => {
    for (const seed of [0, 123456789, 0xffffffff])
      for (const hz of [30, 60, 120])
        for (let frame = -hz * 2; frame < hz * 2; frame++) {
          const routing = { seed, turns: 0, signal: { side: 'left' as const, remaining: 1 } };
          const hazard = visibleLamps('bus', 0, true, routing, frame / hz);
          expect(hazard?.kind === 'hazard' && hazard.on).toBe(
            visibleTurnSignal(routing, frame / hz)?.on,
          );
        }
    expect(visibleLamps('bus', 0.3, false, undefined, 0)).toBe(
      visibleLamps('car', 0.3, false, undefined, 1),
    );
  });
});
