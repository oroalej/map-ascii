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
  const inspect = vi.fn();
  const inspectItem = vi.fn();
  const hover = new LifeHoverController(reads, 100, emit, inspect, inspectItem);
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
  return { hover, frame, emit, inspect, inspectItem, requests, reads, finish };
}

it('renews negative evidence at 125 ms for stable identities without holding the actor', () => {
  const { hover, frame, requests, finish, inspectItem } = fixture();
  frame.agents = [{ ...frame.agents[0]!, inspectionId: 10 }];
  hover.pointer([2, 3]);
  hover.update(frame, 0);
  finish('tree');
  hover.update(frame, 1);
  for (let now = 16; now < 125; now += 16) hover.update({ ...frame, revision: now }, now);
  expect(requests).toHaveLength(0);
  expect(inspectItem).not.toHaveBeenCalled();
  hover.update({ ...frame, revision: 125 }, 125);
  expect(requests).toHaveLength(3);
  finish();
  hover.update(frame, 126);
  expect(inspectItem).toHaveBeenLastCalledWith(frame.agents[0]);
});

it('renews stable identities at 125 ms while unrelated raster revisions and array objects change', () => {
  const { hover, frame, finish, requests, inspectItem } = fixture();
  frame.generation = 7;
  frame.agents = [{ ...frame.agents[0]!, inspectionId: 10 }];
  hover.pointer([2, 3]);
  hover.update(frame, 0);
  finish();
  for (let now = 16; now < 125; now += 16)
    hover.update({ ...frame, revision: now, agents: frame.agents.map((a) => ({ ...a })) }, now);
  expect(requests).toHaveLength(0);
  expect(inspectItem).toHaveBeenCalledTimes(1);
  hover.update({ ...frame, revision: 125 }, 125);
  expect(requests).toHaveLength(3);
  finish();
  hover.update({ ...frame, agents: [{ ...frame.agents[0]!, inspectionId: 11 }] }, 130);
  expect(inspectItem).toHaveBeenLastCalledWith(null);
  expect(requests).toHaveLength(3);
});
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

it('renews a held visible agent for a full second without tooltip or pause flicker', () => {
  const { hover, frame, emit, inspect, requests, finish } = fixture();
  hover.pointer([2, 3]);
  hover.update(frame, 0);
  expect(inspect).not.toHaveBeenCalled();
  finish();
  hover.update(frame, 1);
  for (let at = 40; at <= 1000; at += 40) {
    hover.update(frame, at);
    if (requests.length) {
      expect(requests).toHaveLength(3);
      finish();
      hover.update(frame, at + 1);
    }
  }
  expect(inspect.mock.calls).toEqual([[true]]);
  expect(emit).toHaveBeenCalledTimes(1);
  hover.pointer(null);
  expect(inspect.mock.calls).toEqual([[true], [false]]);
});

it('holds same-owner subcell verification but releases on occlusion or expired evidence', () => {
  const { hover, frame, inspect, reads, finish } = fixture();
  hover.pointer([2, 3]);
  hover.update(frame, 0);
  finish();
  hover.update(frame, 1);
  hover.pointer([6, 3]);
  hover.update(frame, 10);
  expect(inspect.mock.calls).toEqual([[true]]);
  finish('tree');
  hover.update(frame, 11);
  expect(inspect).toHaveBeenLastCalledWith(false);
  hover.clear();
  hover.pointer([2, 3]);
  hover.update(frame, 20);
  finish();
  hover.update(frame, 21);
  reads.size = 6;
  for (let at = 40; at < 269; at += 25) hover.update(frame, at);
  hover.update(frame, 269);
  expect(inspect).toHaveBeenLastCalledWith(true);
  hover.update(frame, 270);
  expect(inspect).toHaveBeenLastCalledWith(false);
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
  for (let at = 25; at < 249; at += 25) hover.update(frame, at);
  hover.update(frame, 249);
  expect(emit).toHaveBeenLastCalledWith({ label: 'Car (simulated)', point: [2, 3] });
  hover.update(frame, 250);
  expect(emit).toHaveBeenLastCalledWith({ label: null, point: null });
  expect(requests).toHaveLength(0);
  reads.size = 3;
  hover.update(frame, 251);
  expect(requests).toHaveLength(3);
  finish();
  hover.update(frame, 252);
  expect(emit).toHaveBeenLastCalledWith({ label: 'Car (simulated)', point: [2, 3] });
});

it.each([true, false])(
  'validates captured evidence after reused buffers reorder owners (visible=%s)',
  (visible) => {
    const { hover, frame, finish, emit, inspectItem, requests } = fixture();
    const original = { ...frame.agents[0]!, inspectionId: 10 };
    frame.agents = [original];
    hover.pointer([2, 3]);
    hover.update(frame, 0);
    // Production packs N+1 before polling N: owners are shared, the N agent list is not.
    frame.owners[0] = 2;
    const next = {
      ...frame,
      revision: 2,
      agents: [{ ...original, inspectionId: 11 }, { ...original }],
    };
    finish(visible ? 'road_mid' : 'tree');
    hover.update(next, 16);
    expect(requests).toHaveLength(0);
    if (visible) {
      expect(emit).toHaveBeenLastCalledWith({ label: 'Car (simulated)', point: [2, 3] });
      expect(inspectItem).toHaveBeenLastCalledWith(next.agents[1]);
    } else {
      expect(emit).not.toHaveBeenCalled();
      expect(inspectItem).not.toHaveBeenCalled();
    }
  },
);

it('keeps a held tooltip across subcells until rejection and reserves two read slots', () => {
  const { hover, frame, finish, emit, inspectItem, reads, requests } = fixture();
  frame.agents = [{ ...frame.agents[0]!, inspectionId: 10 }];
  hover.pointer([2, 3]);
  hover.update(frame, 0);
  finish();
  hover.update(frame, 1);
  reads.size = 4;
  hover.pointer([6, 3]);
  hover.update(frame, 10);
  expect(requests).toHaveLength(0);
  expect(emit).toHaveBeenLastCalledWith({ label: 'Car (simulated)', point: [6, 3] });
  expect(inspectItem).toHaveBeenCalledTimes(1);
  reads.size = 3;
  hover.update(frame, 11);
  expect(requests).toHaveLength(3);
  finish('tree');
  hover.update(frame, 12);
  expect(emit).toHaveBeenLastCalledWith({ label: null, point: null });
  expect(inspectItem).toHaveBeenLastCalledWith(null);
});

it('ages results from their request frame and refreshes cached rejection', () => {
  const { hover, frame, emit, requests, finish } = fixture();
  hover.pointer([2, 3]);
  hover.update(frame, 0);
  for (let at = 25; at < 250; at += 25) hover.update(frame, at);
  finish();
  hover.update(frame, 250);
  expect(emit).not.toHaveBeenCalled();
  expect(requests).toHaveLength(3);
  finish('tree');
  hover.update(frame, 251);
  for (let at = 275; at < 499; at += 25) hover.update(frame, at);
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
  for (let at = 25; at < 253; at += 25) hover.update(frame, at);
  hover.update(frame, 253);
  expired.forEach(({ done }) => done(new Uint8Array([0, classId('road_mid'), 0, 0])));
  hover.update(frame, 254);
  expect(emit).toHaveBeenLastCalledWith({ label: null, point: null });
  expect(requests).toHaveLength(0);
});

it.each([60, 30, 12, 8])('renews two-frame readbacks without flicker at %i fps', (fps) => {
  const { hover, frame, requests, finish, inspect, emit } = fixture();
  hover.pointer([2, 3]);
  let due = -1,
    batches = 0;
  for (let tick = 0; tick <= fps * 2; tick++) {
    if (tick === due) {
      finish();
      due = -1;
    }
    hover.update(frame, (tick * 1000) / fps);
    if (requests.length && due === -1) {
      due = tick + 2;
      batches++;
    }
  }
  expect(inspect.mock.calls).toEqual([[true]]);
  expect(emit).toHaveBeenCalledTimes(1);
  expect(batches).toBeLessThanOrEqual(17);
});

it('bounds evidence under uneven frames and rejects callbacks after a stalled second', () => {
  const { hover, frame, requests, finish, inspect, emit, reads } = fixture();
  hover.pointer([2, 3]);
  hover.update(frame, 0);
  finish();
  hover.update(frame, 100);
  hover.update(frame, 180);
  const late = requests.splice(0);
  reads.size = 8;
  for (const at of [280, 400, 550, 700, 850, 1000]) hover.update(frame, at);
  expect(inspect).toHaveBeenLastCalledWith(false);
  late.forEach(({ done }) => done(new Uint8Array([0, classId('road_mid'), 0, 0])));
  hover.update(frame, 1010);
  expect(emit).toHaveBeenLastCalledWith({ label: null, point: null });
  expect(requests).toHaveLength(0);
});
