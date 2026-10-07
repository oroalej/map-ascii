import { describe, expect, it } from 'vitest';
import assert from 'node:assert/strict';
import { packLife, type LifeGrid } from './draw';
import type { VisibleAgent } from './simulate';
import { themes } from '../theme';
import { SIGNAL_VEHICLES, TURN_SIGNAL_BIT, type TurnSide } from './turn-signals';
import { type CraftType, Paint, VehiclePart } from './vehicles';
import { BEACON_BIT, beaconPhase, emergencyBeacon, type EmergencyState } from './emergency';
import { LifeInspection } from './inspection';

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

describe('emergency roof bars', () => {
  const beacons = (out: Uint8Array) =>
    Array.from({ length: out.length / 4 }, (_, i) => i * 4).filter(
      (at) => out[at + 2]! & BEACON_BIT,
    );
  it('alternates distinct bar halves without changing indicators, footprint or inactive bytes', () => {
    for (const vehicle of ['ambulance', 'police', 'firetruck'] as const) {
      const car = agent(vehicle),
        normal = draw([car]);
      const colors = vehicle === 'firetruck' ? ([0, 2] as const) : ([0, 1] as const);
      const halves = [0, 1].map((half) =>
        draw([{ ...car, beacon: { half: half as 0 | 1, colors } }]),
      );
      const positions: number[] = [];
      halves.forEach(({ out, lamps }, half) => {
        const [at] = beacons(out);
        expect(at).toBeDefined();
        expect(beacons(out)).toHaveLength(1);
        expect(lamps).toEqual(normal.lamps);
        expect(lamps).not.toContain(at);
        expect(out[at! + 3]! & 3).toBe(colors[half]);
        expect(out[at! + 3]! & ~3).toBe(normal.out[at! + 3]! & ~3);
        positions.push(at!);
        const restored = out.slice();
        restored.set(normal.out.subarray(at!, at! + 4), at!);
        expect(restored).toEqual(normal.out);
      });
      expect(positions[0]).not.toBe(positions[1]);
    }
  });
  it('keeps parked fire bars but suppresses parked ambulances, and flashes mini craft', () => {
    for (const half of [0, 1] as const) {
      const fire = draw([
        { ...agent('firetruck'), parked: true, beacon: { half, colors: [0, 2] } },
      ]);
      const [at] = beacons(fire.out);
      expect(at).toBeDefined();
      expect(fire.out[at! + 3]! & 128).toBe(128);
      expect(fire.out[at! + 3]! & 3).toBe(half === 0 ? 0 : 2);
      expect(
        beacons(
          draw([{ ...agent('ambulance'), parked: true, beacon: { half, colors: [0, 1] } }]).out,
        ),
      ).toEqual([]);
      const mini = draw([{ ...agent('police', 1, 0, 0.1), beacon: { half, colors: [0, 1] } }]);
      expect(beacons(mini.out)).toHaveLength(half === 0 ? 1 : 0);
    }
  });
  it('uses the one remaining bar cell for both active colours in a clipped narrow stamp', () => {
    const car = {
      ...agent('ambulance', 1, 0, 0.4),
      lng: 50.4,
      lat: 50.5,
      ahead: [50.8, 50.5] as [number, number],
      side: [50.4, 50.9] as [number, number],
      turnSignal: undefined,
    };
    for (const half of [0, 1] as const) {
      const result = draw([{ ...car, beacon: { half, colors: [0, 1] } }], {
        ...grid,
        cols: 50,
        rows: 60,
      });
      const bars = beacons(result.out);
      expect(result.count).toBe(1);
      expect(bars).toHaveLength(1);
      expect(result.out[bars[0]! + 3]! & 3).toBe(half);
    }
  });
  it('treats red as active and freezes the inspection clock without a resume phase jump', () => {
    const state: EmergencyState = {
      id: 'run',
      kind: 'fire',
      phase: 'onscene',
      lights: true,
      baseSpeedMps: 8,
      remaining: 20,
      offscreen: 0,
      run: 1,
    };
    expect(emergencyBeacon(state, 0, 0)?.colors[0]).toBe(0);
    expect(emergencyBeacon({ ...state, lights: false }, 0, 0)).toBeUndefined();
    expect(beaconPhase(0, 0.25)).toBe(1);
    expect(beaconPhase(0, 0.5)).toBe(0);
    const inspection = new LifeInspection(),
      owner = {};
    inspection.begin(0.1);
    const visible = inspection.present(owner, agent('firetruck'));
    inspection.finish([visible]);
    inspection.select({ id: visible.inspectionId!, revision: 1, time: 0.1 }, 0.1);
    const phase = beaconPhase(17, inspection.clock(owner, 0.1));
    expect(beaconPhase(17, inspection.clock(owner, 1.2))).toBe(phase);
    inspection.select({ id: null, revision: 2, time: 1.2 }, 1.2);
    expect(beaconPhase(17, inspection.clock(owner, 1.2))).toBe(phase);
  });
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
      assert.deepEqual(off.out, normal.out);
      const restored = on.out.slice();
      for (const at of on.lamps) {
        restored[at] = normal.out[at]!;
        restored[at + 1] = normal.out[at + 1]!;
        restored[at + 2] = restored[at + 2]! & ~TURN_SIGNAL_BIT;
      }
      assert.deepEqual(restored, normal.out);
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
      assert.deepEqual(draw([car]).out, draw([{ ...car, turnSignal: undefined }]).out);
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
