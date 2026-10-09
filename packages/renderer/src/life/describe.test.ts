import { expect, it } from 'vitest';
import { agentAt, describeAgent } from './describe';
import { BIRD_SPECIES, BirdPose } from './birds';
import { VEHICLES } from './vehicles';
import type { VisibleAgent } from './simulate';

const person: VisibleAgent = { kind: 'person', lng: 0, lat: 0, flap: 0 };
it('uses a generic pack label for an owned peddler', () => {
  expect(
    describeAgent({
      ...person,
      peddler: {
        id: 'unrelated-goods',
        label: 'Local seller',
        prop: 'basket',
        parasol: 0,
        lamp: 0,
      },
    }),
  ).toBe('Local seller (simulated)');
});
it('names every craft, species, pet and figure as simulated', () => {
  for (const [vehicle, name] of [
    ['ambulance', 'Ambulance'],
    ['police', 'Police car'],
    ['firetruck', 'Fire truck'],
  ] as const)
    expect(describeAgent({ ...person, kind: 'vehicle', vehicle })).toBe(`${name} (simulated)`);
  expect(describeAgent({ ...person, kind: 'vehicle', vehicle: 'ambulance', parked: true })).toBe(
    'Parked ambulance (simulated)',
  );
  for (const vehicle of Object.keys(VEHICLES) as (keyof typeof VEHICLES)[]) {
    expect(describeAgent({ ...person, kind: 'vehicle', vehicle })).toMatch(/^.+ \(simulated\)$/);
  }
  for (const species of Object.keys(BIRD_SPECIES) as (keyof typeof BIRD_SPECIES)[]) {
    expect(
      describeAgent({ ...person, kind: 'bird', bird: { species, pose: BirdPose.spread } }),
    ).toMatch(/^.+ \(simulated\)$/);
  }
  expect(describeAgent({ ...person, kind: 'cat' })).toBe('Cat (simulated)');
  expect(describeAgent({ ...person, kind: 'dog' })).toBe('Dog (simulated)');
  expect(describeAgent({ ...person, kind: 'vehicle', vehicle: 'jeepney', parked: true })).toBe(
    'Parked jeepney (simulated)',
  );
});
it('uses vendor, carabao, paddler and candle precedence, and omits lines', () => {
  const people = [
    { figure: 'child' as const, paint: 0, flap: 0, lateral: 0, back: 0 },
    { figure: 'adult' as const, paint: 1, flap: 0, lateral: 1, back: 0 },
  ];
  expect(describeAgent({ ...person, people })).toBe('People together (simulated)');
  expect(describeAgent({ ...person, people, candle: true })).toBe(
    'People with candles (simulated)',
  );
  expect(describeAgent({ ...person, people, candle: true, aboard: true })).toBe(
    'Paddlers (simulated)',
  );
  expect(describeAgent({ ...person, vehicle: 'cart', candle: true })).toBe(
    'Street vendor (simulated)',
  );
  expect(describeAgent({ ...person, vehicle: 'carabao' })).toBe('Carabao (simulated)');
  expect(
    describeAgent({
      ...person,
      line: {
        points: [
          [0, 0],
          [1, 1],
        ],
        paints: [0],
      },
    }),
  ).toBeNull();
});
it('omits airborne props from independent inspection', () => {
  expect(describeAgent({ ...person, prop: 'ball' })).toBeNull();
});
it('bounds checks frame-local ownership', () => {
  const owners = new Uint32Array([0, 2, 1, 99]);
  const agents = [person, { ...person, kind: 'cat' as const }];
  expect(agentAt(owners, 2, 2, agents, [1, 0])).toBe(agents[1]);
  for (const point of [
    [0, 0],
    [1, 1],
    [-1, 1],
    [2, 0],
    [0.5, 0],
  ] as [number, number][])
    expect(agentAt(owners, 2, 2, agents, point)).toBeNull();
});
