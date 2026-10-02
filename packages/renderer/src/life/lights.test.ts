import { describe, expect, it } from 'vitest';
import type { TilePoint } from '../raster/geometry';
import { BEAM, BULB, CANDLE, FLOOD, SHOP, STREETLIGHT } from './config';
import {
  lampCondition,
  LAMP_STRIDE,
  LampState,
  lightByte,
  packBeams,
  packCandles,
  packLights,
  placeTileLamps,
  SIDE_CELLS,
  type LightGrid,
  type LitLine,
  type VisibleLamp,
} from './lights';
import type { VisibleAgent } from './simulate';

const EXTENT = 4096;

/** Each lamp's fields (one tile unit per meter). */
const lampsOf = (lines: readonly LitLine[], origin?: TilePoint) => {
  const out = placeTileLamps(lines, 1, EXTENT, origin);
  const lamps = [];
  for (let i = 0; i < out.length; i += LAMP_STRIDE) {
    lamps.push({
      x: out[i]!,
      y: out[i + 1]!,
      pool: [out[i + 4]!, out[i + 5]!],
      center: [out[i + 6]!, out[i + 7]!],
    });
  }
  return lamps.sort((a, b) => a.x - b.x || a.y - b.y);
};
const road = (width: number, ...points: [number, number][]): LitLine => ({
  width,
  points: points.map(([x, y]): TilePoint => ({ x, y })),
});

describe('placeTileLamps', () => {
  it('spaces lamps on a world lattice, alternating sides at the road’s edge', () => {
    // A 100 m road along x, 10 m wide: lattice lines every 30 m cross it at 120, 150, 180.
    const lamps = lampsOf([road(10, [100, 500], [200, 500])]);
    expect(lamps.map((l) => l.x)).toEqual([120, 150, 180]);
    const edge = 5 - STREETLIGHT.setback;
    expect(lamps.map((l) => l.y)).toEqual([500 + edge, 500 - edge, 500 + edge]);
    // The road's center line beside each, and its pool in over the road where its arm reaches.
    expect(lamps.map((l) => l.center)).toEqual([
      [120, 500],
      [150, 500],
      [180, 500],
    ]);
    const over = edge - STREETLIGHT.reach;
    expect(lamps.map((l) => l.pool[1])).toEqual([500 + over, 500 - over, 500 + over]);
  });

  it('places the same lamps whichever way the road runs', () => {
    const one = lampsOf([road(10, [100, 500], [200, 500])]);
    const other = lampsOf([road(10, [200, 500], [100, 500])]);
    expect(other.map((l) => [l.x, l.y])).toEqual(one.map((l) => [l.x, l.y]));
  });

  it('agrees across neighboring tiles, so lamps don’t bunch at a tile’s edge', () => {
    // One road seen from two tiles side by side (the second 4096 m east), each with its buffer.
    const west = lampsOf([road(6, [3900, 500], [4300, 500])], { x: 0, y: 0 });
    const east = lampsOf([road(6, [-196, 500], [204, 500])], { x: EXTENT, y: 0 });
    const all = [...west.map((l) => [l.x, l.y]), ...east.map((l) => [l.x + EXTENT, l.y])];
    all.sort((a, b) => a[0]! - b[0]!);
    for (let i = 1; i < all.length; i++) {
      expect(all[i]![0]! - all[i - 1]![0]!).toBeCloseTo(STREETLIGHT.spacing);
      // Sides still alternate across the edge.
      expect(Math.sign(all[i]![1]! - 500)).toBe(-Math.sign(all[i - 1]![1]! - 500));
    }
  });

  it('centers a narrow road’s pools no further in than its center line', () => {
    const [first] = lampsOf([road(4, [100, 500], [200, 500])]);
    expect(first!.pool[0]).toBeCloseTo(120);
    expect(first!.pool[1]).toBeCloseTo(500);
  });

  it('never stands a lamp on the center line, however narrow the road', () => {
    const lamps = lampsOf([road(1, [100, 500], [200, 500])]);
    expect(lamps.length).toBeGreaterThan(0);
    for (const l of lamps) {
      expect(Math.abs(l.y - 500)).toBeCloseTo(0.5 * STREETLIGHT.minSide);
    }
  });

  it('keeps only lamps inside the tile', () => {
    const lamps = lampsOf([road(6, [-100, 10], [100, 10])]);
    expect(lamps.length).toBeGreaterThan(0);
    for (const l of lamps) {
      expect(l.x).toBeGreaterThanOrEqual(0);
      expect(l.y).toBeGreaterThanOrEqual(0);
    }
  });

  it('keeps lamps out of a divided road’s median', () => {
    // Two carriageways 12 m apart, the second the other way.
    const lamps = lampsOf([road(6, [0, 500], [300, 500]), road(6, [300, 512], [0, 512])]);
    expect(lamps.length).toBeGreaterThan(0);
    for (const l of lamps) expect(l.y < 500 || l.y > 512).toBe(true);
  });

  it('lights a junction from a corner, outside both roads, and spaces lamps around it', () => {
    const along = road(6, [0, 500], [100, 500], [200, 500]);
    const across = road(6, [100, 500], [100, 700]);
    const lamps = lampsOf([along, across]);
    const corner = lamps.find((l) => Math.hypot(l.x - 100, l.y - 500) < 6);
    expect(corner).toBeDefined();
    expect(Math.abs(corner!.x - 100)).toBeGreaterThan(3);
    expect(Math.abs(corner!.y - 500)).toBeGreaterThan(3);
    // Its pool reaches over the junction.
    expect(Math.hypot(corner!.pool[0]! - 100, corner!.pool[1]! - 500)).toBeLessThan(
      Math.hypot(corner!.x - 100, corner!.y - 500),
    );
    for (const a of lamps) {
      for (const b of lamps) {
        if (a !== b)
          expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(STREETLIGHT.minGap);
      }
    }
  });

  it('adds no junction where one road simply carries on as the next', () => {
    const joined = lampsOf([road(6, [0, 500], [100, 500]), road(6, [100, 500], [200, 500])]);
    const whole = lampsOf([road(6, [0, 500], [200, 500])]);
    expect(joined.map((l) => [l.x, l.y])).toEqual(whole.map((l) => [l.x, l.y]));
  });
});

describe('lampCondition', () => {
  it('is fixed by position, with about the configured shares out and flickering', () => {
    expect(lampCondition(123, 456)).toEqual(lampCondition(123, 456));
    const counts = [0, 0, 0];
    const n = 5000;
    for (let i = 0; i < n; i++) counts[lampCondition((i * 37) % 4096, (i * 131) % 4096).state]!++;
    expect(counts[LampState.dead]! / n).toBeCloseTo(STREETLIGHT.dead, 1);
    expect(counts[LampState.flicker]! / n).toBeCloseTo(STREETLIGHT.flicker, 1);
  });
});

/** lng → column and lat → row, one cell per degree. */
const grid: LightGrid = { cols: 20, rows: 20, toCell: (lng, lat) => [lng, lat] };
const cell = (out: Uint8Array, col: number, row: number) =>
  Array.from(out.subarray((row * grid.cols + col) * 4, (row * grid.cols + col) * 4 + 4));
/** A lamp whose pool is centered on its head, well off its road's center line. */
const lamp = (lng: number, lat: number, state: LampState, seed = 0, radius = 3): VisibleLamp => ({
  lng,
  lat,
  center: [lng, lat + 5],
  pool: [lng, lat],
  east: [lng + radius, lat],
  north: [lng, lat - radius],
  state,
  seed,
});

describe('lightByte', () => {
  it('packs the state in the low 3 bits and the seed above', () => {
    expect(lightByte(LampState.flood, 31)).toBe(5 | (31 << 3));
    expect(lightByte(LampState.candle, 33)).toBe(4 | (1 << 3));
  });
});

describe('packLights', () => {
  it('lights a pool that fades out from its center, and marks the head', () => {
    const out = new Uint8Array(grid.cols * grid.rows * 4).fill(7);
    expect(packLights(out, grid, [lamp(5.5, 5.5, LampState.flicker, 9)])).toBe(1);
    const g = lightByte(LampState.flicker, 9);
    expect(cell(out, 5, 5)).toEqual([255, g, 255, 255]);
    expect(cell(out, 6, 5)[0]!).toBeGreaterThan(cell(out, 7, 5)[0]!);
    expect(cell(out, 7, 5)[0]!).toBeGreaterThan(0);
    // Just outside the pool: claimed for the lamp, so the filtered rim takes its state.
    expect(cell(out, 9, 5)).toEqual([0, g, 0, 255]);
    expect(cell(out, 11, 5)).toEqual([0, 0, 0, 0]);
    expect(cell(out, 6, 5)[2]).toBe(0);
  });

  it('centers the pool where the lamp reaches, not on its head', () => {
    const out = new Uint8Array(grid.cols * grid.rows * 4);
    packLights(out, grid, [
      {
        ...lamp(5.5, 5.5, LampState.working),
        pool: [5.5, 8.5],
        east: [8.5, 8.5],
        north: [5.5, 5.5],
      },
    ]);
    expect(cell(out, 5, 5)[2]).toBe(255);
    expect(cell(out, 5, 8)[0]).toBe(255);
    expect(cell(out, 5, 8)[0]!).toBeGreaterThan(cell(out, 5, 6)[0]!);
    expect(cell(out, 5, 10)[0]!).toBeGreaterThan(0);
  });

  it('moves a head off the road line when zoomed out', () => {
    const out = new Uint8Array(grid.cols * grid.rows * 4);
    // Half a cell from the center line: pushed out to SIDE_CELLS, the same way.
    packLights(out, grid, [{ ...lamp(5.5, 5.5, LampState.working), center: [5.5, 6] }]);
    expect(cell(out, 5, Math.floor(6 - SIDE_CELLS))[2]).toBe(255);
    expect(cell(out, 5, 5)[2]).toBe(0);
  });

  it('casts no pool from a lamp that is out, but still marks its head', () => {
    const out = new Uint8Array(grid.cols * grid.rows * 4);
    packLights(out, grid, [lamp(5.5, 5.5, LampState.dead)]);
    expect(cell(out, 5, 5)).toEqual([0, lightByte(LampState.dead, 0), 255, 255]);
    expect(cell(out, 6, 5)).toEqual([0, 0, 0, 0]);
  });

  it('floodlights a landmark with no head', () => {
    const out = new Uint8Array(grid.cols * grid.rows * 4);
    expect(packLights(out, grid, [lamp(5.5, 5.5, LampState.flood)])).toBe(0);
    expect(cell(out, 5, 5)).toEqual([
      Math.round(255 * FLOOD.strength),
      lightByte(LampState.flood, 0),
      0,
      255,
    ]);
  });

  it('gives a cell to the lamp whose pool is strongest there', () => {
    const out = new Uint8Array(grid.cols * grid.rows * 4);
    packLights(out, grid, [
      lamp(4.5, 5.5, LampState.working, 1),
      lamp(8.5, 5.5, LampState.flicker, 2),
    ]);
    expect(cell(out, 5, 5)[1]).toBe(lightByte(LampState.working, 1));
    expect(cell(out, 7, 5)[1]).toBe(lightByte(LampState.flicker, 2));
  });

  it('skips heads off the grid but keeps their pools on it', () => {
    const out = new Uint8Array(grid.cols * grid.rows * 4);
    expect(packLights(out, grid, [lamp(-1, 5.5, LampState.working)])).toBe(0);
    expect(cell(out, 0, 5)[0]!).toBeGreaterThan(0);
  });
});

describe('packLights shops', () => {
  it('lights an open shop at its own strength, with no head', () => {
    const out = new Uint8Array(grid.cols * grid.rows * 4);
    expect(packLights(out, grid, [lamp(5.5, 5.5, LampState.shop, 3)])).toBe(0);
    expect(cell(out, 5, 5)).toEqual([
      Math.round(255 * SHOP.strength),
      lightByte(LampState.shop, 3),
      0,
      255,
    ]);
  });
});

describe('packCandles', () => {
  it('hangs a bulb on a vendor’s cart, but not on a plain passer-by', () => {
    const out = new Uint8Array(grid.cols * grid.rows * 4);
    const people: VisibleAgent[] = [
      { kind: 'person', lng: 5.5, lat: 5.5, vehicle: 'cart', flap: 0 },
      { kind: 'person', lng: 15.5, lat: 5.5, flap: 0 },
    ];
    expect(packCandles(out, grid, people, 1)).toBe(1);
    expect(cell(out, 5, 5)[0]).toBe(Math.round(255 * BULB.strength));
    expect(cell(out, 5, 5)[1]).toBe(lightByte(LampState.bulb, 0));
    expect(cell(out, 15, 5)).toEqual([0, 0, 0, 0]);
  });

  it('lights a small flickering pool around each candle', () => {
    const out = new Uint8Array(grid.cols * grid.rows * 4);
    const people: VisibleAgent[] = [
      { kind: 'person', lng: 5.5, lat: 5.5, candle: true, flap: 0 },
      { kind: 'person', lng: 15.5, lat: 5.5, flap: 0 },
    ];
    expect(packCandles(out, grid, people, 1)).toBe(1);
    expect(cell(out, 5, 5)).toEqual([
      Math.round(255 * CANDLE.strength),
      lightByte(LampState.candle, 0),
      0,
      255,
    ]);
    expect(cell(out, 15, 5)).toEqual([0, 0, 0, 0]);
  });

  it('pairs clock tokens with the winning candle pool and preserves lamp heads', () => {
    const out = new Uint8Array(grid.cols * grid.rows * 4);
    const clocks = new Float32Array(grid.cols * grid.rows * 2).fill(-1);
    const candles: VisibleAgent[] = [
      {
        kind: 'person',
        lng: 5.5,
        lat: 5.5,
        candle: true,
        candleSeed: 17,
        effectClock: -12,
        flap: 0,
      },
      { kind: 'person', lng: 15.5, lat: 5.5, candle: true, effectClock: 3, flap: 0 },
    ];
    out[(5 * grid.cols + 6) * 4 + 2] = 255;
    packCandles(out, grid, candles, 1, clocks);
    expect(cell(out, 5, 5)[1]).toBe(lightByte(LampState.candle, 17));
    expect(clocks[(5 * grid.cols + 5) * 2 + 1]).toBe(-12);
    expect(clocks[(5 * grid.cols + 15) * 2 + 1]).toBe(3);
    expect(clocks[(5 * grid.cols + 6) * 2 + 1]).toBe(-1);
    expect(clocks[0]).toBe(-1); // Pool metadata never changes the Life-ink channel.
  });
});

describe('packBeams', () => {
  /** A car at (5.5, 10.5) heading east, `scale` cells per meter. */
  const car = (scale: number, parked = false): VisibleAgent => ({
    kind: 'vehicle',
    lng: 5.5,
    lat: 10.5,
    ahead: [5.5 + scale, 10.5],
    side: [5.5, 10.5 + scale],
    vehicle: 'car',
    paint: 0,
    parked,
    flap: 0,
  });
  const big: LightGrid = { cols: 60, rows: 20, toCell: (lng, lat) => [lng, lat] };
  const at = (out: Uint8Array, col: number, row: number) =>
    Array.from(out.subarray((row * big.cols + col) * 4, (row * big.cols + col) * 4 + 4));

  it('throws a cone of light ahead of a moving vehicle, fading with distance', () => {
    const out = new Uint8Array(big.cols * big.rows * 4);
    expect(packBeams(out, big, [car(2)])).toBe(1);
    // Ahead: lit, brighter near the front, and marked as a beam.
    const near = at(out, 14, 10);
    const far = at(out, 30, 10);
    expect(near[0]!).toBeGreaterThan(far[0]!);
    expect(far[0]!).toBeGreaterThan(0);
    expect(near[1]).toBe(LampState.beam);
    expect(near[3]).toBe(255);
    // Wider further on.
    expect(at(out, 30, 13)[0]!).toBeGreaterThan(0);
    expect(at(out, 14, 14)[0]).toBe(0);
    // Behind it, and past its reach: dark.
    expect(at(out, 2, 10)[0]).toBe(0);
    expect(at(out, Math.ceil(5.5 + 2 * (2 + BEAM.length)), 10)[0]).toBe(0);
  });

  it('casts none from parked vehicles, or when zoomed out', () => {
    const out = new Uint8Array(big.cols * big.rows * 4);
    expect(packBeams(out, big, [car(2, true)])).toBe(0);
    expect(packBeams(out, big, [car(0.1)])).toBe(0);
    expect(out.every((v) => v === 0)).toBe(true);
  });

  it('keeps lamp heads and brighter pools', () => {
    const out = new Uint8Array(big.cols * big.rows * 4);
    const head = (14 + 10 * big.cols) * 4;
    out[head + 1] = LampState.dead;
    out[head + 2] = 255;
    const pool = (16 + 10 * big.cols) * 4;
    out[pool] = 255;
    out[pool + 1] = LampState.working;
    packBeams(out, big, [car(2)]);
    expect(at(out, 14, 10)).toEqual([0, LampState.dead, 255, 0]);
    expect(at(out, 16, 10)[1]).toBe(LampState.working);
  });
});
