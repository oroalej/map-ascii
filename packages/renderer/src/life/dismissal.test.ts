import { DISMISSAL, dismissalNow } from '@atlas/shared';
import { CityLife } from '@atlas/shared/schemas';
import { describe, expect, it, vi } from 'vitest';
import { lngLatToTile, metersPerUnit, tileToLngLat } from '../raster/geometry';
import { activityLevels } from './config';
import { describeAgent } from './describe';
import {
  DISMISSAL_LIFE,
  dismissalLife,
  schoolGates,
  STUDENT_LABEL,
  TRICYCLE_LABEL,
} from './dismissal';
import { LifeBuilder, LifeLine } from './geometry';
import { LifeWorld, type VisibleAgent } from './simulate';

const tile = { z: 16, x: 55192, y: 30266 };
const pm = 1 / metersPerUnit(tile);
const WIDTH = 8;

/** A school 30 m north of an east-west road through the tile. */
function town(schoolY = 2048 - 30 * pm, radius = 20 * pm) {
  const b = new LifeBuilder();
  b.line(
    [
      { x: 0, y: 2048 },
      { x: 2000, y: 2048 },
      { x: 4095, y: 2048 },
    ],
    LifeLine.roadMid,
    WIDTH,
  );
  b.place({ x: 2048, y: schoolY }, 'school', radius);
  return b.finish();
}

const school = { weekdays: [1, 2, 3, 4, 5], in: '07:30', out: '16:30' };
const OUT = 16 * 60 + 30;
const life = { dismissal: { source: 'test' }, schedules: { school } };
const center = tileToLngLat(tile, { x: 2048, y: 2048 });

const scene = (after: number, time: number, geo = town(), crowd = 1) =>
  dismissalLife({ tiles: [{ tile, geo }], after, time, center, crowd });
const walkers = (agents: VisibleAgent[]) => agents.filter((a) => a.kind === 'person');
const curbside = (agents: VisibleAgent[]) => agents.filter((a) => a.kind === 'vehicle');

/** Students in the middle of the release: well after the first has set off. */
const midway = (geo = town()) => {
  for (let time = 0; time < 2000; time += 7) {
    const agents = walkers(scene(30, time, geo));
    if (agents.length >= 3) return { time, agents };
  }
  throw new Error('nobody walking');
};

describe('dismissalNow', () => {
  it('runs from the tricycles gathering until the last walker is home, on school days', () => {
    const at = (minutes: number, weekday = 2) => dismissalNow({ minutes, weekday }, life);
    expect(at(OUT)).toBe(0);
    expect(at(OUT + 15)).toBe(15);
    expect(at(OUT - DISMISSAL.tricycleLead)).toBe(-DISMISSAL.tricycleLead);
    expect(at(OUT - DISMISSAL.tricycleLead - 1)).toBeNull();
    expect(at(OUT + DISMISSAL.release + DISMISSAL.lastWalk)).toBeNull();
    expect(at(OUT + 15, 0)).toBeNull();
    expect(at(OUT + 15, 6)).toBeNull();
  });

  it('is off without the pack option', () => {
    expect(dismissalNow({ minutes: OUT, weekday: 2 }, { schedules: { school } })).toBeNull();
    expect(dismissalNow({ minutes: OUT, weekday: 2 }, undefined)).toBeNull();
  });
});

describe('school gates', () => {
  it('finds the nearest road, once per geometry', () => {
    const geo = town();
    const gates = schoolGates({ tile, geo });
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({ line: 0, width: WIDTH });
    expect(gates[0]!.x).toBeCloseTo(2048);
    expect(gates[0]!.y).toBeCloseTo(2048);
    expect(schoolGates({ tile, geo })).toBe(gates);
  });

  it('skips a school with no road within reach', () => {
    const geo = town(2048 - (DISMISSAL_LIFE.gateReach + 5) * pm);
    expect(schoolGates({ tile, geo })).toEqual([]);
    expect(scene(30, 100, geo)).toEqual([]);
  });

  it('merges a campus of several buildings on one road', () => {
    const b = new LifeBuilder();
    b.line(
      [
        { x: 0, y: 2048 },
        { x: 4095, y: 2048 },
      ],
      LifeLine.roadMid,
      WIDTH,
    );
    b.place({ x: 2048, y: 2000 }, 'school', 0);
    b.place({ x: 2048 + 10 * pm, y: 2000 }, 'school', 60 * pm);
    const gates = schoolGates({ tile, geo: b.finish() });
    expect(gates).toHaveLength(1);
    expect(gates[0]!.students).toBe(DISMISSAL_LIFE.students[1]);
  });

  it('scales students with the school, within bounds', () => {
    const count = (radius: number) =>
      schoolGates({ tile, geo: town(undefined, radius) })[0]!.students;
    expect(count(0)).toBe(DISMISSAL_LIFE.students[0]);
    expect(count(200 * pm)).toBe(DISMISSAL_LIFE.students[1]);
  });

  it('ignores other places and school places in the buffer', () => {
    const b = new LifeBuilder();
    b.line(
      [
        { x: 0, y: 2048 },
        { x: 4095, y: 2048 },
      ],
      LifeLine.roadMid,
      WIDTH,
    );
    b.place({ x: 1000, y: 2040 }, 'worship', 10);
    b.place({ x: -5, y: 2040 }, 'school', 10);
    expect(schoolGates({ tile, geo: b.finish() })).toEqual([]);
  });
});

describe('students going home', () => {
  it('keeps to both shoulders, outside the road', () => {
    const sides = new Set<number>();
    for (let time = 0; time < 3000; time += 11)
      for (const agent of walkers(scene(30, time))) {
        const p = lngLatToTile(tile, agent.lng, agent.lat);
        const off = (p.y - 2048) / pm;
        expect(Math.abs(Math.abs(off) - (WIDTH / 2 + DISMISSAL_LIFE.shoulder))).toBeLessThan(0.01);
        sides.add(Math.sign(off));
      }
    expect(sides).toEqual(new Set([-1, 1]));
  });

  it('walks both ways from the gate, thinning with distance', () => {
    const geo = town();
    const bands = [0, 0];
    const dirs = new Set<number>();
    for (let time = 0; time < 6000; time += 13)
      for (const agent of walkers(scene(30, time, geo))) {
        const p = lngLatToTile(tile, agent.lng, agent.lat);
        const meters = Math.abs(p.x - 2048) / pm;
        expect(meters).toBeLessThanOrEqual(DISMISSAL_LIFE.reach[1]);
        bands[meters < 200 ? 0 : 1]!++;
        dirs.add(Math.sign(p.x - 2048));
      }
    expect(dirs).toEqual(new Set([-1, 1]));
    expect(bands[1]).toBeGreaterThan(0);
    expect(bands[0]).toBeGreaterThan(bands[1]! * 1.5);
  });

  it('starts at the end of classes, and stops releasing at the end of the stream', () => {
    const ever = (after: number) => {
      for (let time = 0; time < 2000; time += 7)
        if (walkers(scene(after, time)).length) return true;
      return false;
    };
    expect(ever(-5)).toBe(false);
    expect(ever(0.5)).toBe(true);
    expect(ever(DISMISSAL.release + 1)).toBe(true);
    expect(ever(DISMISSAL.release + DISMISSAL.lastWalk)).toBe(false);
  });

  it('is the same for the same moment, with no random draw, and keeps walking at a fixed hour', () => {
    const random = vi.spyOn(Math, 'random');
    const { time, agents } = midway();
    expect(walkers(scene(30, time))).toEqual(agents);
    expect(random).not.toHaveBeenCalled();
    random.mockRestore();
    expect(walkers(scene(30, time + 3))).not.toEqual(agents);
  });

  it('stops at the tile edge, draws children mostly in white', () => {
    const all: VisibleAgent[] = [];
    for (let time = 0; time < 2000; time += 13) all.push(...walkers(scene(30, time)));
    expect(all.length).toBeGreaterThan(20);
    const children = all.filter((a) => a.people![0]!.figure === 'child');
    const white = all.filter((a) => a.people![0]!.paint === 0);
    expect(children.length / all.length).toBeGreaterThan(0.5);
    expect(white.length / all.length).toBeGreaterThan(0.5);
    expect(describeAgent(all[0]!)).toBe(STUDENT_LABEL);
    const b = new LifeBuilder();
    b.line(
      [
        { x: 100, y: 2048 },
        { x: 4095, y: 2048 },
      ],
      LifeLine.roadMid,
      WIDTH,
    );
    b.place({ x: 100, y: 2040 }, 'school', 40 * pm);
    const edge = b.finish();
    for (let time = 0; time < 1000; time += 13)
      for (const agent of walkers(scene(30, time, edge))) {
        const p = lngLatToTile(tile, agent.lng, agent.lat);
        expect(p.x).toBeGreaterThanOrEqual(100 - 1);
      }
  });

  it('caps what shows, across many schools', () => {
    const b = new LifeBuilder();
    for (let i = 0; i < 40; i++) {
      const y = 100 + i * 100;
      b.line(
        [
          { x: 0, y },
          { x: 4095, y },
        ],
        LifeLine.roadMid,
        WIDTH,
      );
      b.place({ x: 2048, y: y + 5 }, 'school', 60 * pm);
    }
    const geo = b.finish();
    let most = 0;
    for (let time = 0; time < 600; time += 30) most = Math.max(most, scene(30, time, geo).length);
    expect(most).toBe(DISMISSAL_LIFE.maxOnScreen);
  });

  it('drops the same students on a lower crowd knob', () => {
    const { time, agents } = midway();
    expect(scene(30, time, town(), 0)).toEqual([]);
    const half = walkers(scene(30, time, town(), 0.5));
    expect(half.length).toBeLessThanOrEqual(agents.length);
    for (const agent of half) expect(agents).toContainEqual(agent);
  });
});

describe('tricycles at the gate', () => {
  it('wait at the curb within the window', () => {
    const geo = town();
    expect(curbside(scene(-DISMISSAL.tricycleLead - 1, 0, geo))).toEqual([]);
    const during = curbside(scene(5, 0, geo));
    expect(during.length).toBeGreaterThanOrEqual(DISMISSAL_LIFE.tricycles[0]);
    expect(during.length).toBeLessThanOrEqual(DISMISSAL_LIFE.tricycles[1]);
    expect(curbside(scene(DISMISSAL.tricyclesLeave, 0, geo))).toEqual([]);
    for (const agent of during) {
      expect(agent).toMatchObject({ vehicle: 'tricycle', parked: true });
      expect(describeAgent(agent)).toBe(TRICYCLE_LABEL);
      const p = lngLatToTile(tile, agent.lng, agent.lat);
      const off = Math.abs(p.y - 2048) / pm;
      expect(off + 1.6 / 2).toBeLessThanOrEqual(WIDTH / 2 + 0.01);
    }
  });

  it('stands still whatever the shared time', () => {
    const geo = town();
    expect(curbside(scene(5, 0, geo))).toEqual(curbside(scene(5, 500, geo)));
  });
});

describe('in the world', () => {
  const geo = town();
  const weather = (dismissal?: number) => ({
    rain: 0,
    sunAltitude: 20,
    field: { time: midway(geo).time, wind: [1, 0] as const, minutes: OUT + 30, dismissal },
  });
  const setup = () => {
    const world = new LifeWorld();
    world.sync([{ key: 't', tile, life: geo }]);
    return world;
  };
  const labelled = (agents: VisibleAgent[]) => agents.filter((a) => a.fieldLabel === STUDENT_LABEL);

  it('shows from the people zoom, only while school lets out', () => {
    const world = setup();
    const at = (zoom: number, dismissal?: number) =>
      labelled(world.visible(zoom, activityLevels(1), center, weather(dismissal)));
    expect(at(18, 30).length).toBeGreaterThan(0);
    expect(at(16.9, 30)).toEqual([]);
    expect(at(18)).toEqual([]);
  });

  it('never moves an existing agent', () => {
    const world = setup();
    const movers = world
      .visible(18, activityLevels(1), center, weather())
      .filter((a) => !a.fieldLabel);
    const again = world
      .visible(18, activityLevels(1), center, weather(30))
      .filter((a) => !a.fieldLabel);
    expect(again).toEqual(movers);
  });

  it('respects the world agent cap', () => {
    const world = setup();
    const agents = world.visible(18, activityLevels(1), center, weather(30), undefined, 1, 3);
    expect(agents.length).toBeLessThanOrEqual(3);
  });
});

describe('the pack option', () => {
  it('requires a source', () => {
    expect(CityLife.safeParse({ dismissal: { source: 'x' }, source: 'y' }).success).toBe(true);
    expect(CityLife.safeParse({ dismissal: {}, source: 'y' }).success).toBe(false);
  });
});
