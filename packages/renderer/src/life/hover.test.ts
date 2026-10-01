import { expect, it, vi } from 'vitest';
import { classId } from '../classes';
import type { HoverFrame } from './hover';
import { LifeHoverController, lifeVisibleOnSurface } from './hover';
import { CellBit } from './config';
import type { ReadRect } from '../readback';

function fixture() {
  const requests: { rect: ReadRect; done: (bytes: Uint8Array) => void }[] = [];
  const reads = {
    size: 0,
    request: (
      _fbo: WebGLFramebuffer,
      _attachment: number,
      rect: ReadRect,
      done: (bytes: Uint8Array) => void,
    ) => {
      requests.push({ rect, done });
    },
  };
  const emit = vi.fn();
  const hover = new LifeHoverController(reads, 100, emit);
  const life = new Uint8Array(16);
  life[1] = classId('life_vehicle');
  life[2] = CellBit.vehicle;
  const frame: HoverFrame = {
    targets: {
      cols: 2,
      rows: 2,
      glyphFbo: {},
      sub: { fbo: {} } as HoverFrame['targets']['sub'],
    },
    grid: { shiftX: 1, shiftY: 1, cellWidth: 10, cellHeight: 18 },
    dpr: 1.25,
    geometry: 'one',
    revision: 1,
    owners: new Uint32Array([1, 0, 0, 0]),
    life,
    agents: [{ kind: 'vehicle', vehicle: 'car', lng: 0, lat: 0, flap: 0 }],
    labelsCover: () => false,
  };
  const finish = (coarse = 'road_mid', surface = coarse, height = 0) => {
    requests
      .splice(0, 3)
      .forEach(({ done }, i) =>
        done(
          new Uint8Array(
            i === 0 ? [0, classId(coarse), 0, 0] : [i === 1 ? classId(surface) : height, 0, 0, 0],
          ),
        ),
      );
  };
  return { hover, frame, emit, requests, reads, finish };
}
it('checks surfaces, trees, grounds and birds using agent permissions only', () => {
  const person = classId('life_person'),
    bird = classId('life_bird'),
    road = classId('road_mid');
  expect(lifeVisibleOnSurface(person, 2, road, classId('building'), 5)).toBe(false);
  for (const cls of ['tree', 'tree_crown', 'trees'])
    expect(lifeVisibleOnSurface(person, 2, road, classId(cls), 0)).toBe(false);
  expect(lifeVisibleOnSurface(person, 2, classId('tree'), road, 0)).toBe(false);
  expect(lifeVisibleOnSurface(person, 2, road, classId('building_school'), 0)).toBe(true);
  expect(lifeVisibleOnSurface(person, 2, road, classId('building_school'), 1)).toBe(false);
  expect(lifeVisibleOnSurface(bird, 8, classId('trees'), classId('building'), 4)).toBe(true);
});
it('issues one three-read batch at fractional DPR, publishes on frames and updates position', () => {
  const { hover, frame, emit, requests, finish } = fixture();
  hover.pointer([2, 3]);
  hover.update(frame, 0);
  hover.update(frame, 1);
  expect(requests).toHaveLength(3);
  expect(requests[1]!.rect).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  finish();
  expect(emit).not.toHaveBeenCalled();
  hover.update(frame, 2);
  expect(emit).toHaveBeenLastCalledWith({ label: 'Car (simulated)', point: [2, 3] });
  hover.pointer([3, 3]);
  hover.update(frame, 3);
  expect(emit).toHaveBeenLastCalledWith({ label: 'Car (simulated)', point: [3, 3] });
  hover.update(frame, 4);
  expect(emit).toHaveBeenCalledTimes(2);
});
it('rejects stale names and geometry, expires dropped batches and respects queue capacity', () => {
  const { hover, frame, emit, requests, finish, reads } = fixture();
  hover.pointer([2, 3]);
  hover.update(frame, 0);
  const stale = requests.slice();
  hover.update({ ...frame, geometry: 'two' }, 10);
  finish();
  hover.update({ ...frame, geometry: 'two' }, 11);
  expect(emit).not.toHaveBeenCalled();
  expect(requests).toHaveLength(3);
  hover.update(frame, 300);
  expect(requests).toHaveLength(6);
  stale.forEach(({ done }) => done(new Uint8Array([0, classId('road_mid'), 0, 0])));
  expect(emit).not.toHaveBeenCalled();
  hover.pointer(null);
  requests.length = 0;
  reads.size = 6;
  hover.pointer([2, 3]);
  hover.update(frame, 301);
  expect(requests).toHaveLength(0);
});
it('rechecks moving owners without a pointer move and never reads empty, line or label cells', () => {
  const { hover, frame, emit, requests, finish } = fixture();
  hover.pointer([2, 3]);
  hover.update(frame, 0);
  finish();
  hover.update(frame, 1);
  hover.update({ ...frame, revision: 2, agents: [{ ...frame.agents[0]!, vehicle: 'bus' }] }, 2);
  expect(emit).toHaveBeenLastCalledWith({ label: null, point: null });
  finish();
  hover.update({ ...frame, revision: 2, agents: [{ ...frame.agents[0]!, vehicle: 'bus' }] }, 3);
  expect(emit).toHaveBeenLastCalledWith({ label: 'Bus (simulated)', point: [2, 3] });
  for (const changed of [
    { ...frame, owners: new Uint32Array(4) },
    { ...frame, labelsCover: () => true },
    {
      ...frame,
      agents: [
        { ...frame.agents[0]!, line: { points: [[0, 0] as [number, number]], paints: [0] } },
      ],
    },
  ])
    hover.update(changed, 4);
  expect(requests).toHaveLength(0);
  expect(emit).toHaveBeenLastCalledWith({ label: null, point: null });
});

it('expires confirmed visibility at 250 ms even with an unchanged revision and a full queue', () => {
  const { hover, frame, emit, reads, requests, finish } = fixture();
  hover.pointer([2, 3]);
  hover.update(frame, 0);
  finish();
  hover.update(frame, 1);
  reads.size = 6;
  hover.update(frame, 249);
  expect(emit).toHaveBeenLastCalledWith({ label: 'Car (simulated)', point: [2, 3] });
  hover.update(frame, 250);
  expect(emit).toHaveBeenLastCalledWith({ label: null, point: null });
  expect(requests).toHaveLength(0);
  reads.size = 5;
  hover.update(frame, 251);
  expect(requests).toHaveLength(3);
  finish();
  hover.update(frame, 252);
  expect(emit).toHaveBeenLastCalledWith({ label: 'Car (simulated)', point: [2, 3] });
});

it('ages results from their request frame and refreshes cached rejection', () => {
  const { hover, frame, emit, requests, finish } = fixture();
  hover.pointer([2, 3]);
  hover.update(frame, 0);
  finish();
  hover.update(frame, 250);
  expect(emit).not.toHaveBeenCalled();
  expect(requests).toHaveLength(3);
  finish('tree');
  hover.update(frame, 251);
  hover.update(frame, 499);
  expect(requests).toHaveLength(0);
  hover.update(frame, 500);
  expect(requests).toHaveLength(3);
  finish();
  hover.update(frame, 501);
  expect(emit).toHaveBeenLastCalledWith({ label: 'Car (simulated)', point: [2, 3] });
});

it('invalidates same-name candidates when packed class or permissions change, ignoring cosmetics', () => {
  const { hover, frame, emit, requests, finish } = fixture();
  hover.pointer([2, 3]);
  hover.update(frame, 0);
  finish();
  hover.update(frame, 1);
  frame.life[2] = CellBit.vehicle | 32 | 128;
  hover.update(frame, 2);
  expect(requests).toHaveLength(0);
  frame.life[2] = CellBit.boat;
  hover.update(frame, 3);
  expect(emit).toHaveBeenLastCalledWith({ label: null, point: null });
  expect(requests).toHaveLength(3);
  finish();
  hover.update(frame, 4);
  expect(emit).toHaveBeenLastCalledWith({ label: null, point: null });
  frame.life[1] = classId('life_bird');
  hover.update(frame, 5);
  expect(requests).toHaveLength(3);
});

it('abandons changed candidates immediately and never revives expired batches', () => {
  const { hover, frame, emit, requests, finish, reads } = fixture();
  hover.pointer([2, 3]);
  hover.update(frame, 0);
  const stale = requests.splice(0);
  frame.life[2] = CellBit.person;
  hover.update(frame, 1);
  expect(requests).toHaveLength(3);
  stale.forEach(({ done }) => done(new Uint8Array([0, classId('road_mid'), 0, 0])));
  finish();
  hover.update(frame, 2);
  expect(emit).toHaveBeenLastCalledWith({ label: 'Car (simulated)', point: [2, 3] });
  hover.update({ ...frame, revision: 2 }, 3);
  const expired = requests.splice(0);
  reads.size = 6;
  hover.update(frame, 253);
  expired.forEach(({ done }) => done(new Uint8Array([0, classId('road_mid'), 0, 0])));
  hover.update(frame, 254);
  expect(emit).toHaveBeenLastCalledWith({ label: null, point: null });
  expect(requests).toHaveLength(0);
});
