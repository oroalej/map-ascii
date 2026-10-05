import { describe, expect, it, vi } from 'vitest';
import { metersPerUnit } from '../raster/geometry';
import { activityLevels, RUN } from './config';
import { LifeBuilder, LifeLine } from './geometry';
import { JunctionTable } from './junctions';
import { exposed, runPace } from './running';
import { TileLife, type LifeEnv, type Mover, type Walker } from './simulate';

const tile = { z: 16, x: 55192, y: 30266 };
const perMeter = 1 / metersPerUnit(tile);

const adult = (umbrella: number): Walker => ({
  figure: 'adult',
  shirt: 0,
  umbrella,
  canopy: 0,
  lateral: 0,
  back: 0,
  step: 0,
});
const child: Walker = { ...adult(0.99), figure: 'child', lateral: 1 };

/** A tile with one long path and only `groups` walking it, spread along it. */
const street = (groups: Walker[][], seed = 1, shelter = false) => {
  const b = new LifeBuilder();
  b.line(
    [
      { x: 0, y: 2048 },
      { x: 4095, y: 2048 },
    ],
    LifeLine.path,
    4,
  );
  if (shelter) b.site({ x: 420, y: 2048 }, 2, 0, true);
  const life = new TileLife(tile, b.finish(), seed);
  life.movers.length = 0;
  life.flocks.length = 0;
  groups.forEach((group, i) => {
    const x = 400 + (i * 3200) / groups.length;
    const m: Mover = {
      kind: 'person',
      line: 0,
      from: 0,
      dir: i % 2 ? -1 : 1,
      d: x,
      speed: 1.2 * perMeter,
      paint: 0,
      lane: 0,
      pause: 0,
      rank: 0,
      x,
      y: 2048,
      hx: 1,
      hy: 0,
      group,
      walked: 0,
    };
    if (m.dir === -1) {
      m.from = 1;
      m.d = 4095 - x;
      m.hx = -1;
    }
    life.movers.push(m);
  });
  return life;
};

const streams = (life: TileLife) =>
  life as unknown as { walkerRng: () => number; runRng: () => number };

describe('who runs in the rain', () => {
  it('is everyone with no umbrella over them, and only while it rains', () => {
    expect(exposed([adult(0.9)], 1)).toBe(true);
    expect(exposed([adult(0.1)], 1)).toBe(false);
    expect(exposed([adult(0.9)], 0)).toBe(false);
    expect(exposed(undefined, 1)).toBe(false);
  });
  it('keeps a child dry under their adult’s umbrella', () => {
    expect(exposed([adult(0.1), child], 1)).toBe(false);
    expect(exposed([adult(0.9), child], 1)).toBe(true);
  });
});

describe('running pace', () => {
  const m = (umbrella: number, speed = 0): Mover => ({ speed, group: [adult(umbrella)] }) as Mover;
  it('is each person’s own, within the range, and never slower than their walk', () => {
    const paces = [0.05, 0.3, 0.6, 0.95].map((u) => runPace(m(u), RUN.speed, perMeter));
    for (const pace of paces) {
      expect(pace).toBeGreaterThanOrEqual(RUN.speed[0] * perMeter);
      expect(pace).toBeLessThan(RUN.speed[1] * perMeter);
    }
    expect(new Set(paces).size).toBe(paces.length);
    expect(runPace(m(0.3), RUN.speed, perMeter)).toBe(paces[1]);
    expect(runPace(m(0.3, 9 * perMeter), RUN.speed, perMeter)).toBe(9 * perMeter);
  });
});

describe('random runners', () => {
  const singles = () => Array.from({ length: 40 }, (_, i) => [adult(((i * 37) % 100) / 100)]);

  it('now and then one runs, never more than a couple at once, and only those alone', () => {
    const groups = [...singles(), [adult(0.5), adult(0.6)], [adult(0.2), child]];
    const life = street(groups);
    let most = 0;
    let runs = 0;
    let groupViolations = 0;
    let leastAdvance = Infinity;
    for (let t = 0; t < 3000; t++) {
      const walked = life.movers.map((m) => m.walked ?? 0);
      const was = life.movers.map((m) => (m.run ?? 0) > 0);
      life.step(0.1, undefined, undefined, undefined, { rain: 0 });
      let running = 0;
      life.movers.forEach((m, i) => {
        if ((m.run ?? 0) <= 0) return;
        running++;
        if (!was[i]) runs++;
        groupViolations += Number(m.group?.length !== 1);
        leastAdvance = Math.min(leastAdvance, (m.walked ?? 0) - walked[i]!);
      });
      most = Math.max(most, running);
    }
    expect(runs).toBeGreaterThan(5);
    expect(most).toBe(RUN.maxPerTile);
    expect(groupViolations).toBe(0);
    expect(leastAdvance).toBeGreaterThan(RUN.speed[0] * 0.1 - 1e-9);
  });

  it('stops running when held up', () => {
    const life = street([[adult(0.5)]]);
    const m = life.movers[0]!;
    m.run = 5;
    const env = { rain: 0 };
    life.step(0.1, undefined, undefined, undefined, env, () => false);
    expect(m.waiting).toBeGreaterThan(0);
    life.step(0.1, undefined, undefined, undefined, env, () => true);
    expect(m.run).toBe(0);
  });

  it('does not start a random run while collision waiting', () => {
    const life = street([[adult(0.5)]]);
    streams(life).walkerRng = () => 1;
    streams(life).runRng = () => 1;
    const m = life.movers[0]!;
    life.step(0.1, undefined, undefined, undefined, { rain: 0 }, () => false);
    expect(m.waiting).toBeGreaterThan(0);
    const runRng = vi.fn<() => number>().mockReturnValue(0);
    streams(life).runRng = runRng;
    life.step(0.1, undefined, undefined, undefined, { rain: 0 }, () => false);
    expect(m.run ?? 0).toBe(0);
    expect(runRng).not.toHaveBeenCalled();
  });

  it('ends a live run when the person turns back', () => {
    const life = street([[adult(0.5)]]);
    streams(life).walkerRng = vi.fn<() => number>().mockReturnValueOnce(1).mockReturnValue(0);
    streams(life).runRng = () => 1;
    const m = life.movers[0]!;
    m.run = 5;
    life.step(0.1, undefined, undefined, undefined, { rain: 0 });
    expect(m.dir).toBe(-1);
    expect(m.run).toBe(0);
  });

  it('ends a live run when the person starts a scene visit', () => {
    const life = street([[adult(0.5)]], 1, true);
    streams(life).walkerRng = () => 1;
    streams(life).runRng = () => 1;
    const m = life.movers[0]!;
    m.run = 5;
    expect(life.scenes.reserve(m, 0)).toBe(true);
    life.step(0.1, undefined, undefined, undefined, { rain: 0 });
    expect(life.scenes.visits.has(m)).toBe(true);
    expect(m.run).toBe(0);
  });

  it('expires at zero and never frees a slot twice when the former runner pauses', () => {
    const life = street(Array.from({ length: 4 }, () => [adult(0.5)]));
    const rng = streams(life);
    rng.walkerRng = () => 1;
    rng.runRng = () => 1;
    const expired = life.movers[0]!;
    expired.run = 0.05;
    life.step(0.1, undefined, undefined, undefined, { rain: 0 });
    expect(expired.run).toBe(0);

    life.movers[1]!.run = 5;
    life.movers[2]!.run = 5;
    let draws = 0;
    rng.walkerRng = () => (draws++ === 0 ? 0 : 1);
    rng.runRng = () => 0;
    life.step(0.1, undefined, undefined, undefined, { rain: 0 });
    expect(expired.pause).toBeGreaterThan(0);
    expect(life.movers.filter((m) => (m.run ?? 0) > 0)).toHaveLength(RUN.maxPerTile);
    expect(life.movers[3]!.run ?? 0).toBe(0);
  });

  it('leaves slots available when daytime runners become inactive at night', () => {
    const life = street(Array.from({ length: 4 }, () => [adult(0.5)]));
    streams(life).walkerRng = () => 1;
    streams(life).runRng = () => 0;
    for (const m of life.movers.slice(0, 2)) Object.assign(m, { rank: 0.6, run: 5 });
    const levels = activityLevels(0, { minutes: 22 * 60, weekday: 1 });
    life.step(0.1, undefined, undefined, undefined, { rain: 0, levels });
    expect(life.movers.slice(0, 2).map((m) => m.run)).toEqual([5, 5]);
    expect(life.movers.slice(2).every((m) => (m.run ?? 0) > 0)).toBe(true);
  });

  it('leaves slots available when frozen runners belong to another tile', () => {
    const life = street(Array.from({ length: 4 }, () => [adult(0.5)]));
    streams(life).walkerRng = () => 1;
    streams(life).runRng = () => 0;
    for (const m of life.movers.slice(0, 2)) m.run = 5;
    life.step(0.1, undefined, undefined, undefined, { rain: 0 }, undefined, {
      junctions: new JunctionTable(),
      owns: (p) => p.x >= 2000,
    });
    expect(life.movers.slice(0, 2).map((m) => m.run)).toEqual([5, 5]);
    expect(life.movers.slice(2).every((m) => (m.run ?? 0) > 0)).toBe(true);
  });

  it('holds an inspected run without occupying a moving runner slot', () => {
    const life = street(Array.from({ length: 3 }, () => [adult(0.5)]));
    streams(life).walkerRng = () => 1;
    streams(life).runRng = () => 0;
    const inspected = life.movers[0]!;
    inspected.run = 5;
    const x = inspected.x;
    life.step(0.1, undefined, undefined, undefined, { rain: 0, inspecting: inspected });
    expect(inspected.run).toBe(5);
    expect(inspected.x).toBe(x);
    expect(life.movers.slice(1).every((m) => (m.run ?? 0) > 0)).toBe(true);
  });

  it.each(['view', 'activity', 'ownership', 'inspection'] as const)(
    'keeps resumed runs within the cap after a change in %s',
    (change) => {
      const frozenCount = change === 'inspection' ? 1 : 2;
      const life = street(Array.from({ length: frozenCount + RUN.maxPerTile }, () => [adult(0.5)]));
      streams(life).walkerRng = () => 1;
      streams(life).runRng = () => 0;
      const frozen = life.movers.slice(0, frozenCount);
      for (const m of frozen) Object.assign(m, { rank: 0.6, run: 5 });
      const env: LifeEnv = { rain: 0 };
      if (change === 'activity') env.levels = activityLevels(0, { minutes: 22 * 60, weekday: 1 });
      if (change === 'inspection') env.inspecting = frozen[0];
      const cutoff = life.movers[frozenCount]!.x;
      const near = change === 'view' ? (x: number) => x >= cutoff : undefined;
      const pass =
        change === 'ownership'
          ? { junctions: new JunctionTable(), owns: (p: { x: number; y: number }) => p.x >= cutoff }
          : undefined;
      life.step(0.1, undefined, undefined, near, env, undefined, pass);
      expect(frozen.every((m) => m.run === 5)).toBe(true);
      expect(life.movers.slice(frozenCount).every((m) => (m.run ?? 0) > 0)).toBe(true);

      const walked = life.movers.map((m) => m.walked ?? 0);
      life.step(0.1, undefined, undefined, undefined, { rain: 0 });
      expect(life.movers.filter((m) => (m.run ?? 0) > 0)).toHaveLength(RUN.maxPerTile);
      const boosted = life.movers.filter(
        (m, i) => (m.walked ?? 0) - walked[i]! >= RUN.speed[0] * 0.1 - 1e-9,
      );
      expect(boosted).toHaveLength(RUN.maxPerTile);
    },
  );

  it('replays exactly for the same seed', () => {
    const a = street(singles(), 9);
    const b = street(singles(), 9);
    let starts = 0;
    for (let t = 0; t < 600; t++) {
      const wasRunning = a.movers.map((m) => (m.run ?? 0) > 0);
      a.step(0.1, undefined, undefined, undefined, { rain: 0 });
      b.step(0.1, undefined, undefined, undefined, { rain: 0 });
      starts += a.movers.filter((m, i) => !wasRunning[i] && (m.run ?? 0) > 0).length;
    }
    expect(starts).toBeGreaterThan(0);
    expect(a.movers).toEqual(b.movers);
  });
});

describe('running from the rain', () => {
  it('suppresses spontaneous pauses while preserving the pause RNG draws', () => {
    const life = street([[adult(0.9)]]);
    const rng = vi.fn<() => number>().mockReturnValueOnce(0).mockReturnValue(0.5);
    streams(life).walkerRng = rng;
    const m = life.movers[0]!;
    life.step(0.1, undefined, undefined, undefined, { rain: 1 });
    expect(rng).toHaveBeenCalledTimes(2);
    expect(m.pause).toBe(0);
    expect(m.walked).toBeGreaterThanOrEqual(RUN.dash[0] * 0.1 - 1e-9);
  });

  it('suppresses spontaneous turn-backs while preserving the decision RNG draws', () => {
    const life = street([[adult(0.9)]]);
    const rng = vi.fn<() => number>().mockReturnValueOnce(1).mockReturnValue(0);
    streams(life).walkerRng = rng;
    const m = life.movers[0]!;
    life.step(0.1, undefined, undefined, undefined, { rain: 1 });
    expect(rng).toHaveBeenCalledTimes(2);
    expect(m.dir).toBe(1);
    expect(m.walked).toBeGreaterThanOrEqual(RUN.dash[0] * 0.1 - 1e-9);
  });

  it('starts dashing when rain catches someone in an existing idle pause', () => {
    const life = street([[adult(0.9)]]);
    streams(life).walkerRng = () => 1;
    const m = life.movers[0]!;
    m.pause = 5;
    life.step(0.1, undefined, undefined, undefined, { rain: 1 });
    expect(m.pause).toBe(0);
    expect(m.walked).toBeGreaterThanOrEqual(RUN.dash[0] * 0.1 - 1e-9);
  });

  it('runs those with no umbrella on their way, and no one runs for fun', () => {
    const groups = [[adult(0.9)], [adult(0.95), child], [adult(0.1)], [adult(0.2), child]];
    const life = street(groups);
    for (const m of life.movers) m.run = 3;
    for (let t = 0; t < 30; t++) {
      const walked = life.movers.map((m) => m.walked ?? 0);
      life.step(0.1, undefined, undefined, undefined, { rain: 1 });
      life.movers.forEach((m, i) => {
        if (m.pause > 0) return;
        const step = (m.walked ?? 0) - walked[i]!;
        if (exposed(m.group, 1)) expect(step).toBeGreaterThan(RUN.dash[0] * 0.1 - 1e-9);
        else expect(step).toBeLessThan(1.2 * 0.1 + 1e-9);
        expect(m.run).toBe(0);
      });
    }
  });
});
