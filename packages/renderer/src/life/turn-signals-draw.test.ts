import { describe, expect, it } from 'vitest';
import { packLife, type LifeGrid } from './draw';
import type { VisibleAgent } from './simulate';
import { themes } from '../theme';
import { SIGNAL_VEHICLES, TURN_SIGNAL_BIT, type TurnSide } from './turn-signals';
import { type CraftType, Paint, VehiclePart } from './vehicles';

const grid: LifeGrid = {
  cols: 100,
  rows: 100,
  cellWidth: 6,
  cellHeight: 11,
  toCell: (x, y) => [x, y],
};
const agent = (
  vehicle: CraftType,
  dx = 1,
  dy = 0,
  scale = 3,
  side: TurnSide = 'left',
): VisibleAgent => ({
  kind: 'vehicle',
  vehicle,
  paint: Paint.red,
  lng: 50,
  lat: 50,
  ahead: [50 + dx * scale, 50 + dy * scale],
  side: [50 - dy * scale, 50 + dx * scale],
  flap: 0,
  turnSignal: { side, on: true },
});
const glyphIndex = (glyph: string) => (glyph === '█' ? 300 : 301);
function draw(agents: readonly VisibleAgent[], customGrid = grid) {
  const out = new Uint8Array(customGrid.cols * customGrid.rows * 4);
  const count = packLife(out, customGrid, agents, themes.dark, glyphIndex);
  const lamps: number[] = [];
  for (let at = 0; at < out.length; at += 4) if (out[at + 2]! & TURN_SIGNAL_BIT) lamps.push(at);
  return { out, count, lamps };
}

describe('turn signal stamps', () => {
  it('places front and rear lamps on the heading-relative side of all six motor vehicles', () => {
    for (const vehicle of SIGNAL_VEHICLES)
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
        [Math.SQRT1_2, Math.SQRT1_2],
      ])
        for (const side of ['left', 'right'] as const) {
          const car = agent(vehicle, dx, dy, 3, side);
          const { out, lamps, count } = draw([car]);
          expect(count).toBe(1);
          expect(lamps).toHaveLength(2);
          const forward = lamps.map((at) => {
            const x = ((at / 4) % grid.cols) + 0.5 - car.lng;
            const y = Math.floor(at / 4 / grid.cols) + 0.5 - car.lat;
            const right = -dy! * x + dx! * y;
            expect(side === 'left' ? right < 0 : right > 0).toBe(true);
            expect(out[at + 3]! & 15).toBe(
              ((out[at + 3]! >> 4) & 7) === VehiclePart.taillight ? Paint.red & ~1 : Paint.red,
            );
            expect(out[at]! + ((out[at + 1]! >> 6) << 8)).toBe(300);
            return dx! * x + dy! * y;
          });
          expect(Math.min(...forward)).toBeLessThan(0);
          expect(Math.max(...forward)).toBeGreaterThan(0);
        }
  });

  it('retains the footprint, part bytes, and permissions, restoring normal parts when off', () => {
    for (const vehicle of SIGNAL_VEHICLES) {
      const car = agent(vehicle);
      const on = draw([car]);
      const normal = draw([{ ...car, turnSignal: undefined }]);
      const off = draw([{ ...car, turnSignal: { side: 'left', on: false } }]);
      expect(off.out).toEqual(normal.out);
      const restored = on.out.slice();
      for (const at of on.lamps) {
        restored[at] = normal.out[at]!;
        restored[at + 1] = normal.out[at + 1]!;
        restored[at + 2] = restored[at + 2]! & ~TURN_SIGNAL_BIT;
      }
      expect(restored).toEqual(normal.out);
    }
  });

  it('suppresses parked craft, non-motors, narrow stamps, and single-glyph vehicles', () => {
    const cases: VisibleAgent[] = [
      { ...agent('car'), parked: true },
      agent('car', 1, 0, 0.1),
      agent('car', 1, 0, 0.7),
      agent('motorcycle', 1, 0, 2),
      agent('bicycle'),
      { ...agent('motorboat'), kind: 'boat' },
      { ...agent('locomotive'), kind: 'train' },
      { ...agent('cart'), kind: 'person' },
    ];
    for (const car of cases) {
      expect(draw([car]).lamps).toEqual([]);
      expect(draw([car]).out).toEqual(draw([{ ...car, turnSignal: undefined }]).out);
    }
  });

  it('journals lamps with the body so a rejected stamp leaves no fragments', () => {
    const car = agent('car');
    const parked = {
      ...car,
      parked: true,
      lng: 57,
      ahead: [60, 50] as [number, number],
      side: [57, 53] as [number, number],
    };
    const alone = draw([parked]);
    const together = draw([car, parked]);
    expect(together.count).toBe(1);
    expect(together.out).toEqual(alone.out);
    expect(together.lamps).toEqual([]);
    const forbidden = draw([car], { ...grid, allowsGroundCell: (_agent, col) => col >= 50 });
    expect(forbidden.count).toBe(0);
    expect(forbidden.out.every((byte) => byte === 0)).toBe(true);
  });

  it('keeps lamps inside occupied cells under fractional pans and clipped viewports', () => {
    for (const vehicle of SIGNAL_VEHICLES)
      for (const x of [0, 0.4, 1.5, 50.25, 99.75]) {
        const car = {
          ...agent(vehicle),
          lng: x,
          ahead: [x + 3, 50] as [number, number],
          side: [x, 53] as [number, number],
        };
        const on = draw([car]);
        const off = draw([{ ...car, turnSignal: undefined }]);
        for (const at of on.lamps) expect(off.out[at + 2]).toBeGreaterThan(0);
        if (x === 0) expect(on.lamps).toHaveLength(1);
      }
  });
});
