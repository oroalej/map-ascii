import { expect, it } from 'vitest';
import { dispatchFixture, emergencyMovers } from './testing/emergency-replay';
import { emergencyConfig } from './testing/emergency';
import { outsideView } from './births';

it('admits safe offscreen bodies, honors logical caps, and clears only emergencies', () => {
  const f = dispatchFixture();
  for (let i = 0; i < 40; i++) f.step();
  const movers = emergencyMovers(f.life);
  expect(movers.length).toBeGreaterThan(0);
  for (const m of movers) expect(outsideView(f.life, f.life.birthBodies(m), f.view, 12)).toBe(true);
  for (let i = 0; i < 600; i++) f.step();
  for (const kind of ['ambulance', 'police', 'fire'] as const)
    expect(
      emergencyMovers(f.life).filter((m) => m.emergency!.kind === kind).length,
    ).toBeLessThanOrEqual(emergencyConfig[kind]!.max);
  f.world.setEmergency(undefined);
  expect(emergencyMovers(f.life)).toEqual([]);
  expect(f.world.emergencyDispatch).toBeUndefined();
});
it('freezes inspected police episodes and retains physical base speed across owner scale changes', () => {
  const f = dispatchFixture({ source: 'Synthetic', police: emergencyConfig.police });
  for (let i = 0; i < 40; i++) f.step();
  const m = emergencyMovers(f.life)[0]!;
  expect(m).toBeDefined();
  const old = m.emergency!;
  f.world.emergencyDispatch!.step(
    10,
    [{ life: f.life, mover: m }],
    () => false,
    () => true,
    () => false,
    () => undefined,
    () => {},
  );
  expect(m.emergency).toBe(old);
  f.world.emergencyDispatch!.step(
    3,
    [{ life: f.life, mover: m }],
    () => true,
    () => false,
    () => false,
    () => undefined,
    () => {},
  );
  expect(m.emergency!.phase).toBe('call');
  expect(m.speed / f.life.perMeter).toBeCloseTo(old.baseSpeedMps * 1.3);
  f.world.emergencyDispatch!.step(
    2,
    [{ life: f.life, mover: m }],
    () => true,
    () => false,
    () => false,
    () => undefined,
    () => {},
  );
  expect(m.emergency!.phase).toBe('patrol');
  expect(m.speed / f.life.perMeter).toBeCloseTo(old.baseSpeedMps);
});
it.each(['ambulance', 'fire'] as const)(
  'completes %s curb dwell and retains its lifecycle',
  (kind) => {
    const f = dispatchFixture({ source: 'Synthetic', [kind]: emergencyConfig[kind] });
    const phases = new Set<string>(),
      fireIds = new Set<string>();
    for (let i = 0; i < 200 * 10; i++) {
      f.step(0.1);
      for (const m of emergencyMovers(f.life)) {
        phases.add(m.emergency!.phase);
        if (m.emergency!.kind === 'fire') fireIds.add(m.emergency!.id);
        if (m.emergency!.phase === 'parked' || m.emergency!.phase === 'onscene') {
          const stop = f.life.emergencyArrival(m)!;
          expect(Math.abs(f.life.offsetOf(m) - stop.curb)).toBeLessThanOrEqual(0.2);
        }
      }
    }
    expect(phases).toContain(kind === 'ambulance' ? 'parked' : 'onscene');
    expect(phases).toContain(kind === 'ambulance' ? 'cleared' : 'returning');
    if (kind === 'fire') {
      expect(fireIds.size).toBe(1);
      expect(emergencyMovers(f.life)[0]!.emergency!.run).toBeGreaterThan(1);
    }
  },
);
