import { describe, expect, it } from 'vitest';
import { metersPerUnit } from '../raster/geometry';
import { RUN } from './config';
import { LifeBuilder, LifeLine } from './geometry';
import { exposed, runPace } from './running';
import { TileLife, type Mover, type Walker } from './simulate';

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
const street = (groups: Walker[][], seed = 1) => {
  const b = new LifeBuilder();
  b.line(
    [
      { x: 0, y: 2048 },
      { x: 4095, y: 2048 },
    ],
    LifeLine.path,
    4,
  );
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
    for (let t = 0; t < 3000; t++) {
      const walked = life.movers.map((m) => m.walked ?? 0);
      const was = life.movers.map((m) => (m.run ?? 0) > 0);
      life.step(0.1, undefined, undefined, undefined, { rain: 0 });
      let running = 0;
      life.movers.forEach((m, i) => {
        if ((m.run ?? 0) <= 0) return;
        running++;
        if (!was[i]) runs++;
        expect(m.group).toHaveLength(1);
        expect((m.walked ?? 0) - walked[i]!).toBeGreaterThan(RUN.speed[0] * 0.1 - 1e-9);
      });
      most = Math.max(most, running);
    }
    expect(runs).toBeGreaterThan(5);
    expect(most).toBe(RUN.maxPerTile);
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

  it('replays exactly for the same seed', () => {
    const a = street(singles(), 9);
    const b = street(singles(), 9);
    for (let t = 0; t < 600; t++) {
      a.step(0.1, undefined, undefined, undefined, { rain: 0 });
      b.step(0.1, undefined, undefined, undefined, { rain: 0 });
    }
    expect(a.movers).toEqual(b.movers);
  });
});

describe('running from the rain', () => {
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
