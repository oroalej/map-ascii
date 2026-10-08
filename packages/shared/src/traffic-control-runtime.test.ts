import { expect, it } from 'vitest';
import { SignalArm, SignalLayout, SignalPosition } from './signal-layout';
import {
  ControllerSeed,
  CrossingController,
  SignalController,
  SignalStops,
  crossingControllerProperties,
  decodeCrossingController as schemaCrossing,
  decodeCrossingSignal as schemaSignal,
} from './traffic-control';
import { isSignalArm, isSignalLayout, isSignalPosition } from './signal-layout-runtime';
import {
  isControllerSeed,
  isCrossingController,
  isSignalController,
  isSignalStops,
  decodeCrossingController,
  decodeCrossingSignal,
} from './traffic-control-runtime';

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
  stop_bearing: 200,
  stop_road_id: 'local',
  stop_direction: 1,
  stop_road_width: 4,
};
const crossing: CrossingController = {
  id: 'signal',
  at: [123, 13],
  seed: 0xffffffff,
  midBlock: false,
  walk: 'a',
};
const signal = {
  id: crossing.id,
  at: crossing.at,
  seed: crossing.seed,
  radius: 4,
  a: 0,
  b: 90,
  mapped: true,
  layout: { members: [[0, 0]], arms: [arm] },
  stops: [arm],
};
const variants = (value: Record<string, unknown>) => [
  value,
  null,
  [],
  { ...value, extra: 1 },
  ...Object.keys(value).flatMap((key) => {
    const omitted = { ...value };
    delete omitted[key];
    return [
      omitted,
      ...[undefined, null, false, '', -1, 0, 0.5, Infinity, NaN, [], {}].map((bad) => ({
        ...value,
        [key]: bad,
      })),
    ];
  }),
];
it('matches strict schema validation, including optional stop refinements and numeric boundaries', () => {
  const cases = [
    { schema: SignalArm, guard: isSignalArm, values: variants(arm) },
    { schema: SignalLayout, guard: isSignalLayout, values: variants(signal.layout) },
    { schema: CrossingController, guard: isCrossingController, values: variants(crossing) },
    { schema: SignalController, guard: isSignalController, values: variants(signal) },
    {
      schema: SignalPosition,
      guard: isSignalPosition,
      values: [[-180, -90], [180, 90], [181, 0], [0, 91], [0], [0, 0, 0], [NaN, 0]],
    },
    {
      schema: ControllerSeed,
      guard: isControllerSeed,
      values: [0, 0xffffffff, -1, 0.1, 0x100000000, Infinity, NaN, '0'],
    },
    {
      schema: SignalStops,
      guard: isSignalStops,
      values: [[], [arm], ...variants(arm).map((v) => [v]), [{ ...arm, stop_bearing: undefined }]],
    },
  ];
  for (const { schema, guard, values } of cases)
    for (const value of values) {
      const result = schema.safeParse(value);
      expect(guard(value), JSON.stringify(value)).toBe(result.success);
      if (result.success) expect(value).toEqual(result.data);
    }
  // All combinations of optional stop fields exercise the cross-field refinements.
  const optional = [
    'stop',
    'stop_width',
    'stop_bearing',
    'stop_road_id',
    'stop_direction',
    'stop_road_width',
  ] as const;
  for (let mask = 0; mask < 64; mask++)
    for (const inbound of [true, false]) {
      const value: Record<string, unknown> = { ...arm, inbound };
      optional.forEach((key, i) => {
        if (mask & (1 << i)) delete value[key];
      });
      expect(isSignalArm(value)).toBe(SignalArm.safeParse(value).success);
      expect(isSignalStops([value])).toBe(SignalStops.safeParse([value]).success);
    }
});
it('matches crossing property decoding and rejects partial tags', () => {
  const props = crossingControllerProperties(crossing);
  const values: Record<string, unknown>[] = [props, {}, { crossing_signal_control: '{}' }];
  for (const key of Object.keys(props)) {
    const partial: Record<string, unknown> = { ...props };
    delete partial[key];
    values.push(partial);
    for (const bad of [null, false, 0, '', 'null', 'broken', '[181,13]', '[123]'])
      values.push({ ...props, [key]: bad });
  }
  for (const value of values) {
    let expected: CrossingController | undefined;
    try {
      expected = schemaCrossing(value);
    } catch {
      expect(() => decodeCrossingController(value)).toThrow();
      continue;
    }
    expect(decodeCrossingController(value)).toEqual(expected);
  }
});
it('matches signal decoding, including consistency checks and scalar JSON errors', () => {
  const values = [
    undefined,
    1,
    'broken',
    ...variants(signal).map((v) => JSON.stringify(v)),
    ...[{ id: 'other' }, { seed: 0 }, { at: [0, 0] }, { a: -1 }].map((change) =>
      JSON.stringify({ ...signal, ...change }),
    ),
  ];
  for (const value of values) {
    const props = { crossing_signal_control: value };
    let expected: SignalController | undefined;
    try {
      expected = schemaSignal(props, crossing);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      expect(() => decodeCrossingSignal(props, crossing)).toThrow(
        /scalar JSON|inconsistent/.test(message) ? message : undefined,
      );
      continue;
    }
    expect(decodeCrossingSignal(props, crossing)).toEqual(expected);
  }
});
