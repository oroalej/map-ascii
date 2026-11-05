import { describe, expect, it } from 'vitest';
import { metersPerUnit } from '../raster/geometry';
import { LifeBuilder, LifeLine, type LifeGeometry } from './geometry';
import { RAIL_CROSSING } from './rail-crossings';
import { TileLife } from './simulate';

const tile = { z: 16, x: 55192, y: 30266 };
const pm = 1 / metersPerUnit(tile);
const crossingsOf = (geo: LifeGeometry) => new TileLife(tile, geo, 1).railCrossings.crossings;

const rail = (b: LifeBuilder, kind: LifeLine = LifeLine.rail, navigationOnly = false) =>
  b.line(
    [
      { x: 2000, y: 0 },
      { x: 2000, y: 2000 },
      { x: 2000, y: 4095 },
    ],
    kind,
    0,
    100,
    0,
    navigationOnly,
  );

describe('finding level crossings', () => {
  it('finds a road that shares a vertex with the track', () => {
    const b = new LifeBuilder();
    rail(b);
    b.line(
      [
        { x: 0, y: 2000 },
        { x: 2000, y: 2000 },
        { x: 4095, y: 2000 },
      ],
      LifeLine.roadMajor,
      12,
    );
    const [crossing, ...rest] = crossingsOf(b.finish());
    expect(rest).toHaveLength(0);
    expect(crossing).toMatchObject({ x: 2000, y: 2000, owned: true, closed: false });
    expect(crossing!.stops).toHaveLength(2);
  });

  it('finds a road whose vertex lies on the track, with no track vertex there', () => {
    const b = new LifeBuilder();
    b.line(
      [
        { x: 2000, y: 0 },
        { x: 2000, y: 4095 },
      ],
      LifeLine.rail,
    );
    b.line(
      [
        { x: 0, y: 2000 },
        { x: 2000, y: 2000 },
        { x: 4095, y: 2000 },
      ],
      LifeLine.roadMid,
      8,
    );
    const crossings = crossingsOf(b.finish());
    expect(crossings).toHaveLength(1);
    expect(crossings[0]).toMatchObject({ x: 2000, y: 2000 });
    expect(crossings[0]!.stops).toHaveLength(2);
  });

  it('finds a road that properly crosses between vertices', () => {
    const b = new LifeBuilder();
    rail(b);
    b.line(
      [
        { x: 1000, y: 1000 },
        { x: 3000, y: 1000 },
      ],
      LifeLine.roadMinor,
      6,
    );
    const crossings = crossingsOf(b.finish());
    expect(crossings).toHaveLength(1);
    expect(crossings[0]!.x).toBeCloseTo(2000);
    expect(crossings[0]!.y).toBeCloseTo(1000);
  });

  it('counts one crossing where a road is split at the rail', () => {
    const b = new LifeBuilder();
    rail(b);
    for (const x of [0, 4095])
      b.line(
        [
          { x, y: 2000 },
          { x: 2000, y: 2000 },
        ],
        LifeLine.roadMid,
        8,
      );
    const crossings = crossingsOf(b.finish());
    expect(crossings).toHaveLength(1);
    // One approach per road: neither road runs on past the rail.
    expect(crossings[0]!.stops).toHaveLength(2);
    expect(crossings[0]!.stops.map((s) => s.dir)).toEqual([1, 1]);
  });

  it('ignores parallel lines, sidings, paths and navigation-only track', () => {
    const parallel = new LifeBuilder();
    rail(parallel);
    parallel.line(
      [
        { x: 2200, y: 0 },
        { x: 2200, y: 4095 },
      ],
      LifeLine.roadMajor,
      12,
    );
    expect(crossingsOf(parallel.finish())).toHaveLength(0);
    const road = (b: LifeBuilder, kind: LifeLine = LifeLine.roadMajor) =>
      b.line(
        [
          { x: 0, y: 2000 },
          { x: 4095, y: 2000 },
        ],
        kind,
        12,
      );
    const siding = new LifeBuilder();
    rail(siding, LifeLine.siding);
    road(siding);
    expect(crossingsOf(siding.finish())).toHaveLength(0);
    const path = new LifeBuilder();
    rail(path);
    road(path, LifeLine.path);
    expect(crossingsOf(path.finish())).toHaveLength(0);
    const navigation = new LifeBuilder();
    rail(navigation, LifeLine.rail, true);
    road(navigation);
    expect(crossingsOf(navigation.finish())).toHaveLength(0);
  });

  it('owns a crossing only inside its half-open extent', () => {
    const on = (x: number) => {
      const b = new LifeBuilder();
      b.line(
        [
          { x, y: 0 },
          { x, y: 4095 },
        ],
        LifeLine.rail,
      );
      b.line(
        [
          { x: -60, y: 2000 },
          { x: 4156, y: 2000 },
        ],
        LifeLine.roadMajor,
        12,
      );
      return crossingsOf(b.finish());
    };
    expect(on(0)[0]!.owned).toBe(true);
    expect(on(4096)[0]!.owned).toBe(false);
    expect(on(-10)[0]!.owned).toBe(false);
    expect(on(4095)[0]!.owned).toBe(true);
  });

  it('puts each stop the set distance before the rail, around a bend', () => {
    const b = new LifeBuilder();
    rail(b);
    const back = RAIL_CROSSING.stopBack * pm;
    // A bend closer to the rail than the stop on one side only.
    b.line(
      [
        { x: 2000 - back / 2, y: 2000 + back },
        { x: 2000 - back / 2, y: 2000 },
        { x: 2000, y: 2000 },
        { x: 2500, y: 2000 },
      ],
      LifeLine.roadMid,
      8,
    );
    const stops = crossingsOf(b.finish())[0]!.stops;
    expect(stops).toHaveLength(2);
    const coming = stops.find((s) => s.dir === 1)!;
    const going = stops.find((s) => s.dir === -1)!;
    // Half of the distance on the last stretch, half on the one before it.
    expect(coming.x).toBeCloseTo(2000 - back / 2);
    expect(coming.y).toBeCloseTo(2000 + back / 2);
    expect(coming.hx).toBeCloseTo(0);
    expect(coming.hy).toBeCloseTo(-1);
    expect(going.x).toBeCloseTo(2000 + back);
    expect(going.y).toBeCloseTo(2000);
    expect(going.hx).toBeCloseTo(-1);
    // `along` is measured from the line's own start, as signals store it.
    expect(going.along - coming.along).toBeCloseTo(2 * back);
  });

  it('stops a short road from a junction at its own start', () => {
    const b = new LifeBuilder();
    rail(b);
    const short = (RAIL_CROSSING.stopBack / 2) * pm;
    b.line(
      [
        { x: 2000 - short, y: 2000 },
        { x: 2000, y: 2000 },
      ],
      LifeLine.roadMinor,
      6,
    );
    const stops = crossingsOf(b.finish())[0]!.stops;
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({ dir: 1, along: 0 });
  });

  it('costs a tile without track nothing', () => {
    const b = new LifeBuilder();
    b.line(
      [
        { x: 0, y: 2000 },
        { x: 4095, y: 2000 },
      ],
      LifeLine.roadMajor,
      12,
    );
    expect(crossingsOf(b.finish())).toEqual([]);
  });
});
