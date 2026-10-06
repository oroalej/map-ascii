import { expect, it } from 'vitest';
import {
  canonicalSignalSeed,
  ControllerSeed,
  crossingControllerProperties,
  decodeCrossingController,
  SignalStops,
} from './traffic-control';
import { SignalArm } from './signal-layout';

it('round-trips scalar coordinates and exact uint32 seeds, rejecting partial or malformed tags', () => {
  for (const seed of [0, 0xffffffff]) {
    const c = {
      id: 'controller',
      at: [123.123456789, 13.987654321] as [number, number],
      seed,
      midBlock: false,
      walk: 'b' as const,
    };
    const props = crossingControllerProperties(c);
    expect(typeof props.crossing_signal_at).toBe('string');
    expect(decodeCrossingController(props)).toEqual(c);
    for (const key of [
      'crossing_signal',
      'crossing_signal_at',
      'crossing_signal_seed',
      'crossing_walk',
    ]) {
      const partial: Record<string, unknown> = { ...props };
      delete partial[key];
      expect(() => decodeCrossingController(partial)).toThrow();
    }
    for (const bad of ['null', '[181,13]', '[123]', 'broken'])
      expect(() => decodeCrossingController({ ...props, crossing_signal_at: bad })).toThrow();
    expect(() => decodeCrossingController({ ...props, crossing_mid: 1 })).toThrow();
  }
  expect(decodeCrossingController({ crossing_bearing: 90 })).toBeUndefined();
  expect(() => decodeCrossingController({ crossing_signal_control: '{}' })).toThrow();
  for (const seed of [-1, 0.1, 0x100000000, Infinity, NaN])
    expect(ControllerSeed.safeParse(seed).success).toBe(false);
});

it('preserves pinned legacy seeds on the rounded maximum-zoom world grid', () => {
  // The renderer's traffic-control test pins placeSeed to these same literal values.
  for (const [lng, lat, seed] of [
    [123.1859231, 13.6248803, 1892173763],
    [0, 0, 4166576904],
    [-179, 80, 3591633896],
  ] as const)
    expect(canonicalSignalSeed(lng, lat, 16)).toBe(seed);
});

it('allows old stop bearings but requires complete local bearings in exact stop records', () => {
  const arm = {
    road_id: 'road',
    junction: [0, 0],
    toward: [0.01, 0],
    direction: -1,
    inbound: true,
    outbound: true,
    group: 'a',
    bearing: 270,
    width: 10,
    stop: [0.001, -0.00001],
    stop_width: 5,
  };
  expect(SignalArm.safeParse(arm).success).toBe(true);
  expect(SignalStops.safeParse([arm]).success).toBe(false);
  expect(SignalStops.safeParse([{ ...arm, stop_bearing: 200 }]).success).toBe(true);
  for (const stop_bearing of [-1, 360, Infinity])
    expect(SignalArm.safeParse({ ...arm, stop_bearing }).success).toBe(false);
  expect(
    SignalArm.safeParse({ ...arm, stop: undefined, stop_width: undefined, stop_bearing: 0 })
      .success,
  ).toBe(false);
});
