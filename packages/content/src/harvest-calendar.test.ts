import { describe, expect, it } from 'vitest';
import { cropStageAt, epochDay, harvestAt } from '@atlas/shared';
import { City } from '@atlas/shared/schemas';

const cityFiles = import.meta.glob('../cities/naga/city.json', { eager: true, import: 'default' });
const climate = City.parse(Object.values(cityFiles)[0]).climate!;
const YEAR = 2026;
const NOON = 12 * 60;
const scene = (month: number, day: number, minutes = NOON) =>
  harvestAt(
    cropStageAt(climate.crops, YEAR, epochDay(YEAR, month, day) - epochDay(YEAR, 1, 1)),
    climate.crops?.rice?.harvest,
    minutes,
  )!;

describe("Naga's harvest scene", () => {
  it('dries palay about Sep 4–Oct 22 and Mar 10–Apr 8', () => {
    expect(scene(9, 3).drying).toBe(0);
    expect(scene(9, 6).drying).toBeGreaterThan(0);
    expect(scene(9, 15).drying).toBe(1);
    expect(scene(10, 21).drying).toBeGreaterThan(0);
    expect(scene(10, 23).drying).toBe(0);

    expect(scene(3, 10).drying).toBe(0);
    expect(scene(3, 12).drying).toBeGreaterThan(0);
    expect(scene(3, 20).drying).toBe(1);
    expect(scene(4, 7).drying).toBeGreaterThan(0);
    expect(scene(4, 9).drying).toBe(0);
  });

  it('dries nothing the rest of the year', () => {
    for (const [month, day] of [
      [1, 15],
      [5, 15],
      [7, 15],
      [12, 15],
    ] as const)
      expect(scene(month, day).drying).toBe(0);
  });

  it('has ducks on the paddies on Nov 5, and tractors on the flooded fields of Nov 20', () => {
    expect(scene(11, 5).ducks).toBe(1);
    expect(scene(11, 20).tractors).toBeGreaterThan(0);
    expect(scene(11, 20).ducks).toBe(0);
  });

  it('covers palay overnight', () => {
    expect(scene(9, 20, 8 * 60).spread).toBe(true);
    expect(scene(9, 20, 22 * 60).spread).toBe(false);
  });

  it('burns straw on an afternoon in the early harvest', () => {
    expect(scene(10, 1, 16 * 60).burning).toBe(true);
    expect(scene(10, 1, 9 * 60).burning).toBe(false);
    expect(scene(11, 5, 16 * 60).burning).toBe(false);
  });

  it('can show mist in any month', () => {
    expect(climate.mist?.months).toHaveLength(12);
    for (const density of climate.mist!.months) expect(density).toBeGreaterThan(0);
  });
});
