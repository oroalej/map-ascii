import { describe, expect, it } from 'vitest';
import { classId } from '../classes';
import { metersPerUnit, tileToLngLat, lngLatToTile } from '../raster/geometry';
import { themes } from '../theme';
import { activityLevels, CellBit, lifeClassFor } from './config';
import { describeAgent } from './describe';
import { packLife, type LifeGrid } from './draw';
import { LifeBuilder, LifeLine } from './geometry';
import { BARRIER_LABEL, RAIL_CROSSING } from './rail-crossings';
import { LifeWorld, type VisibleAgent } from './simulate';
import { worldTiles } from './testing/scenarios';
import { Paint } from './vehicles';

const tile = { z: 16, x: 55192, y: 30266 };
const pm = 1 / metersPerUnit(tile);
const center = tileToLngLat(tile, { x: 2048, y: 2048 });

function setup(crossingAt = 2048) {
  const b = new LifeBuilder();
  b.line(
    [
      { x: 0, y: 2048 },
      { x: 4095, y: 2048 },
    ],
    LifeLine.rail,
  );
  b.line(
    [
      { x: crossingAt, y: 0 },
      { x: crossingAt, y: 4095 },
    ],
    LifeLine.roadMajor,
    12,
  );
  const world = new LifeWorld();
  world.sync([{ key: 'rail', tile, life: b.finish() }]);
  const life = worldTiles(world).get('rail')!;
  life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
  return { world, life, crossing: life.railCrossings.crossings[0]! };
}

const barriers = (world: LifeWorld, zoom = 18) =>
  world.visible(zoom, activityLevels(1), center).filter((a) => a.line);

describe('crossing barriers', () => {
  it('shows only while the crossing is closed', () => {
    const { world, crossing } = setup();
    expect(barriers(world)).toHaveLength(0);
    crossing.closed = true;
    expect(barriers(world)).toHaveLength(2);
    crossing.closed = false;
    expect(barriers(world)).toHaveLength(0);
  });

  it('shows from z17 only', () => {
    const { world, crossing } = setup();
    crossing.closed = true;
    expect(barriers(world, 16.9)).toHaveLength(0);
    expect(barriers(world, 17)).toHaveLength(2);
  });

  it('draws one on each side of the track, across the road and just past its edges', () => {
    const { world, crossing } = setup();
    crossing.closed = true;
    const lines = barriers(world).map((agent) =>
      agent.line!.points.map(([lng, lat]) => lngLatToTile(tile, lng, lat)),
    );
    const sides = lines.map(([a]) => Math.sign(a!.y - 2048)).sort();
    expect(sides).toEqual([-1, 1]);
    for (const [a, b] of lines) {
      expect(a!.y).toBeCloseTo(b!.y, 3);
      expect(Math.abs(a!.x - b!.x) / pm).toBeCloseTo(12 + 2 * RAIL_CROSSING.barrierOverhang, 2);
      const fromRail = Math.abs(a!.y - 2048) / pm;
      expect(fromRail).toBeCloseTo(RAIL_CROSSING.stopBack - RAIL_CROSSING.barrierAhead, 3);
    }
  });

  it('swaps red and white every half second of the life clock', () => {
    const { world, crossing } = setup();
    crossing.closed = true;
    const internal = world as unknown as { clock: number };
    internal.clock = 0.1;
    expect(barriers(world)[0]!.line!.paints).toEqual([Paint.red, Paint.white]);
    internal.clock = 0.6;
    expect(barriers(world)[0]!.line!.paints).toEqual([Paint.white, Paint.red]);
    internal.clock = 1.1;
    expect(barriers(world)[0]!.line!.paints).toEqual([Paint.red, Paint.white]);
  });

  it('respects the agent cap and leaves other tiles out', () => {
    const { world, crossing } = setup();
    crossing.closed = true;
    const internal = world.visible(18, activityLevels(1), center, undefined, undefined, 1, 1);
    expect(internal.length).toBeLessThanOrEqual(1);
    crossing.owned = false;
    expect(barriers(world)).toHaveLength(0);
  });

  it('names itself on hover', () => {
    const { world, crossing } = setup();
    crossing.closed = true;
    expect(describeAgent(barriers(world)[0]!)).toBe(BARRIER_LABEL);
  });
});

describe('a line agent’s layer', () => {
  const grid: LifeGrid = {
    cols: 20,
    rows: 20,
    toCell: (lng: number, lat: number) => [lng, lat],
    water: () => false,
  } as unknown as LifeGrid;
  const pack = (line: VisibleAgent['line']) => {
    const out = new Uint8Array(20 * 20 * 4);
    packLife(
      out,
      grid,
      [{ kind: 'boat', lng: 5, lat: 5, flap: 0, line: line! }],
      themes.dark,
      () => 1,
    );
    const cells: number[][] = [];
    for (let i = 0; i < out.length; i += 4) if (out[i + 2]) cells.push([...out.subarray(i, i + 4)]);
    return cells;
  };
  const points: [number, number][] = [
    [5.5, 5.5],
    [9.5, 5.5],
  ];

  it('keeps a boat’s class and bit by default, as ropes and poles use', () => {
    const plain = pack({ points, paints: [Paint.yellow] });
    expect(plain.length).toBeGreaterThan(0);
    for (const cell of plain) expect(cell[2]! & 255).toBe(CellBit.boat);
  });

  it('takes the class and bit it names', () => {
    const named = pack({
      points,
      paints: [Paint.yellow],
      layer: { cls: lifeClassFor.vehicle, bit: CellBit.vehicle },
    });
    const boat = pack({ points, paints: [Paint.yellow] });
    expect(named.length).toBe(boat.length);
    for (const cell of named) expect(cell[2]! & 255).toBe(CellBit.vehicle);
    expect(named[0]!.slice(0, 2)).not.toEqual(boat[0]!.slice(0, 2));
    expect(classId(lifeClassFor.vehicle)).not.toBe(classId(lifeClassFor.boat));
  });

  it('skips a line within a cell unless it asks to be drawn short', () => {
    const tiny: [number, number][] = [
      [5.1, 5.5],
      [5.6, 5.5],
    ];
    expect(pack({ points: tiny, paints: [Paint.red] })).toHaveLength(0);
    expect(pack({ points: tiny, paints: [Paint.red], short: true })).toHaveLength(1);
  });
});
