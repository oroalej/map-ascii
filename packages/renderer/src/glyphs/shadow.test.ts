import { describe, expect, it } from 'vitest';
import { CellState } from '../picking';
import { selectFragment } from '../shaders/select';
import { glyphFragment } from '../shaders/glyph';
import { classId } from '../classes';
import {
  cellLight,
  contactShade,
  kindCodes,
  pixelLight,
  pixelStands,
  shadeTexel,
  standingClasses,
  standing,
  EDGE_STATE,
  STANDING_STATE,
  SHADOW,
  shadowAmount,
  shadowSamples,
  TONE_SHIFT,
  WIND_SHIFT,
} from './select';

describe('shadows', () => {
  const tan = (degrees: number) => Math.tan((degrees * Math.PI) / 180);
  /** A building `height` meters tall from `near` to `far` meters toward the sun, wide enough for
   * every penumbra ray; open ground elsewhere. */
  const building =
    (height: number, near: number, far = near) =>
    (d: number) =>
      d >= near - 1e-9 && d <= far + 1e-9 ? height : 0;
  const shaded = (...args: Parameters<typeof shadowAmount>) => shadowAmount(...args) >= 0.5;

  it('falls on the ground behind a building, as long as the sun is low', () => {
    // A 12 m building 2 steps of 3 m away: shaded while the sun is under atan(12 / 6) ≈ 63°.
    expect(shaded(0, building(12, 6), tan(60), 3)).toBe(true);
    expect(shaded(0, building(12, 6), tan(70), 3)).toBe(false);
    // Farther away needs a lower sun.
    expect(shaded(0, building(12, 15), tan(45), 3)).toBe(false);
    expect(shaded(0, building(12, 15), tan(30), 3)).toBe(true);
  });

  it('shades a roof only under something taller', () => {
    expect(shadowAmount(12, building(12, 3), tan(10), 3)).toBe(0);
    expect(shaded(6, building(12, 3), tan(45), 3)).toBe(true);
  });

  it('keeps looking at the cells next to it when the sun is low', () => {
    const distances = shadowSamples(tan(5), 3);
    expect(distances).toEqual([3, 6, 9, 12, 15, 18, 32, 46, 60]);
    // A lamp post's worth of blocker right next to the cell still shades it.
    expect(shadowAmount(0, building(10, 3), tan(5), 3)).toBe(1);
  });

  it('never looks past its reach, even when six cells are farther', () => {
    for (const step of [3, 9, 12, 25, 70]) {
      for (const degrees of [1, 5, 20, 60]) {
        const distances = shadowSamples(tan(degrees), step);
        expect(Math.max(0, ...distances)).toBeLessThanOrEqual(SHADOW.reach);
      }
    }
    expect(shadowSamples(tan(5), 25)).toEqual([25, 50]);
    expect(shadowSamples(tan(5), 70)).toEqual([]);
  });

  it('fades across the sun line', () => {
    // The sun line is 6 m up 6 m away at 45°: from 2 m under it to 2 m over it, the shade rises.
    const amounts = [3.9, 4, 5, 6, 7, 8, 8.1].map((h) => shadowAmount(0, building(h, 6), 1, 3));
    expect(amounts[0]).toBe(0);
    expect(amounts[1]).toBe(0);
    expect(amounts[3]).toBeCloseTo(0.5);
    expect(amounts[5]).toBe(1);
    expect(amounts[6]).toBe(1);
    for (let i = 1; i < amounts.length; i++)
      expect(amounts[i]!).toBeGreaterThanOrEqual(amounts[i - 1]!);
  });

  it('casts nothing without a sun', () => {
    expect(shadowAmount(0, building(12, 3), 0, 3)).toBe(0);
    expect(shadowAmount(0, building(12, 3), -1, 3)).toBe(0);
    expect(shadowSamples(0, 3)).toEqual([]);
  });

  it('reaches past six cells at a low sun, but no farther than its reach', () => {
    // 18 m of near samples; the far ones find a 20 m building 28–36 m away.
    expect(shadowAmount(0, building(20, 28, 36), tan(10), 3)).toBe(1);
    expect(shadowAmount(0, building(20, 28, 36), tan(60), 3)).toBe(0);
    expect(shadowAmount(0, building(200, SHADOW.reach + 1, 400), tan(5), 3)).toBe(0);
  });

  it('softens a shadow along its side', () => {
    // The building covers the centre ray and one side ray, not the other.
    const edge = (d: number, side: number) => (side === 1 ? 0 : d === 6 ? 12 : 0);
    const amount = shadowAmount(0, edge, tan(45), 3);
    expect(amount).toBeGreaterThan(0);
    expect(amount).toBeLessThan(1);
    expect(amount).toBeCloseTo(2 / 3);
  });

  it('darkens ground at the foot of something tall, sun or not', () => {
    const open = Array<number>(16).fill(0);
    expect(contactShade(0, open)).toBe(0);
    // A tall wall along one side: 3 of ring 1 and 3 of ring 2.
    const wall = [10, 10, 10, 0, 0, 0, 0, 0, 10, 10, 10, 0, 0, 0, 0, 0];
    const foot = contactShade(0, wall);
    expect(foot).toBeGreaterThan(0);
    expect(foot).toBeCloseTo((3 / 8 + 0.5 * (3 / 8)) * SHADOW.ao);
    // Ring 2 counts half of ring 1.
    expect(contactShade(0, [...open.slice(0, 8), 10, 10, 10, 0, 0, 0, 0, 0])).toBeCloseTo(foot / 3);
    // A low kerb is no wall; standing cells take no contact shade.
    expect(
      contactShade(
        0,
        wall.map((h) => (h ? SHADOW.aoRise - 1 : 0)),
      ),
    ).toBe(0);
    expect(contactShade(4, wall)).toBe(0);
  });

  it('lights a cell from its shadow and contact shade', () => {
    expect(cellLight(0, 0)).toBe(1);
    expect(cellLight(1, 0)).toBe(1 - SHADOW.dark);
    expect(cellLight(0, 0.2)).toBeCloseTo(0.8);
    expect(cellLight(1, 0.2)).toBeCloseTo((1 - SHADOW.dark) * 0.8);
  });

  it('marks standing cells with their own bit in the state byte', () => {
    // Nothing else in the byte overlaps it: not the picking state, the edge, the wind level
    // (2 bits) or the tone (2 bits, the top of the byte).
    const others = [EDGE_STATE, 3 << WIND_SHIFT, 3 << TONE_SHIFT, ...Object.values(CellState)];
    for (const bit of others) expect(bit & STANDING_STATE).toBe(0);
    expect(STANDING_STATE + EDGE_STATE + (3 << WIND_SHIFT) + (3 << TONE_SHIFT) + 3).toBe(255);
  });

  it('writes the light on every select path, before any return', () => {
    expect(selectFragment).toContain('layout(location = 1) out vec4 o_shade;');
    const main = selectFragment.slice(selectFragment.indexOf('void main()'));
    const write = main.indexOf('o_shade =');
    expect(write).toBeGreaterThan(0);
    expect(write).toBeLessThan(main.indexOf('return'));
    // Nothing else writes it, and the binary shadow bit is gone from the state.
    expect(selectFragment.split('o_shade =')).toHaveLength(2);
    expect(selectFragment).not.toContain('g_shadow');
  });
});

describe('light on standing things and the ground', () => {
  it('tells standing things from ground by kind and height', () => {
    expect(standing(kindCodes.building, 9)).toBe(true);
    expect(standing(kindCodes.foliage, 6)).toBe(true);
    expect(standing(kindCodes.variant, 4)).toBe(true);
    // A school's or church's grounds: a building class with no height.
    expect(standing(kindCodes.building, 0)).toBe(false);
    // Terrain's height byte is its band, not something standing.
    expect(standing(kindCodes.ramp, 3)).toBe(false);
    expect(standing(kindCodes.grass, 0)).toBe(false);
  });

  /** A 10 m building from 3 m toward the sun on, and the ring of a wall along that side. */
  const wall = (d: number) => (d >= 3 ? 10 : 0);
  const wallRing = [10, 10, 10, 0, 0, 0, 0, 0, 10, 10, 10, 0, 0, 0, 0, 0];
  const inside = Array<number>(16).fill(10);

  it('writes the same light for both channels on the ground', () => {
    const open = shadeTexel(0, () => 0, Array<number>(16).fill(0), 1, 3);
    expect(open).toEqual({ ground: 1, own: 1 });
    const foot = shadeTexel(0, wall, wallRing, 1, 3);
    expect(foot.own).toBe(foot.ground);
    expect(foot.ground).toBeCloseTo(cellLight(1, contactShade(0, wallRing)));
  });

  it("keeps a roof's own light and gives its neighbours the ground's", () => {
    // A sunlit roof: its own light is full; as ground it is shaded by its building and walls,
    // so filtering from the shaded ground at its foot toward it stays dark.
    const roof = shadeTexel(10, wall, inside, 1, 3);
    expect(roof.own).toBe(1);
    expect(roof.ground).toBeLessThan(0.5);
    const foot = shadeTexel(0, wall, wallRing, 1, 3);
    expect(roof.ground).toBeLessThanOrEqual(foot.ground);
    // A lower roof under a taller neighbour keeps that shadow as its own light.
    expect(shadeTexel(4, wall, inside, 1, 3).own).toBe(1 - SHADOW.dark);
  });

  it('reads standing things at their own light and the ground filtered, in one sample', () => {
    expect(pixelLight(true, { own: 1 }, 0.4)).toBe(1);
    expect(pixelLight(false, { own: 1 }, 0.4)).toBe(0.4);
    // Shadows off: every channel is 1, as on main.
    expect(pixelLight(false, { own: 1 }, 1)).toBe(1);
    // The glyph pass takes one sample of the light; only edge pixels look at the standing table.
    const main = glyphFragment.slice(glyphFragment.indexOf('void main()'));
    expect(main.split('u_shade').length - 1).toBe(2);
    expect(main.slice(main.indexOf('if (standing && edge)')).indexOf('u_standing')).toBeGreaterThan(
      0,
    );
  });

  it('lets only the standing samples of an edge cell read its own light', () => {
    // A whole standing cell, edge or not where its sample stands.
    expect(pixelStands(true, false, kindCodes.grass, 0)).toBe(true);
    expect(pixelStands(true, true, kindCodes.building, 9)).toBe(true);
    expect(pixelStands(true, true, kindCodes.foliage, 0, true)).toBe(true);
    // The ground sextants of a roof's edge cell keep the ground's light.
    expect(pixelStands(true, true, kindCodes.grass, 0)).toBe(false);
    expect(pixelStands(true, true, kindCodes.building, 0)).toBe(false);
    expect(pixelStands(true, true, kindCodes.ramp, 3)).toBe(false);
    // Ground cells never read a standing light (their two channels match anyway).
    expect(pixelStands(false, true, kindCodes.building, 9)).toBe(false);
    const kinds = new Int32Array(64);
    kinds[classId('building')] = kindCodes.building;
    kinds[classId('tree_crown')] = kindCodes.foliage;
    kinds[classId('grass')] = kindCodes.grass;
    const mask = standingClasses(kinds);
    const has = (cls: number) => (mask[cls >> 5]! & (1 << (cls & 31))) !== 0;
    expect(has(classId('building'))).toBe(true);
    expect(has(classId('tree_crown'))).toBe(true);
    expect(has(classId('grass'))).toBe(false);
  });
});
