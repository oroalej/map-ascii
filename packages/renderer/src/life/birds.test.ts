import { describe, expect, it } from 'vitest';
import {
  birdFit,
  birdGlyph,
  birdGlyphs,
  BirdHeading,
  birdInk,
  birdOf,
  birdPixels,
  BirdPose,
  BIRD_SPECIES,
  BIRD_SPECIES_ORDER,
  Habitat,
  habitatOf,
  pickSpecies,
} from './birds';
import { random } from './random';

describe('bird species', () => {
  it('picks species by habitat: egrets over water and fields, never in trees', () => {
    const count = (habitat: Habitat) => {
      const rng = random(7);
      const seen = new Map<string, number>();
      for (let i = 0; i < 2000; i++) {
        const s = pickSpecies(habitat, rng);
        seen.set(s, (seen.get(s) ?? 0) + 1);
      }
      return seen;
    };
    expect(count(Habitat.trees).has('egret')).toBe(false);
    const water = count(Habitat.water);
    expect(water.get('egret')!).toBeGreaterThan(water.get('maya') ?? 0);
    for (const h of [Habitat.water, Habitat.field, Habitat.park, Habitat.trees]) {
      expect(count(h).size).toBeGreaterThan(1);
    }
    expect(BIRD_SPECIES.egret.perch).toBe(0);
  });

  it('reads the habitat from a roost’s map class', () => {
    expect(habitatOf('water_area')).toBe(Habitat.water);
    expect(habitatOf('farmland')).toBe(Habitat.field);
    expect(habitatOf('grass')).toBe(Habitat.field);
    expect(habitatOf('trees')).toBe(Habitat.trees);
    expect(habitatOf('park')).toBe(Habitat.park);
  });

  it('grows from a font glyph to a silhouette to a stamp', () => {
    expect(birdFit(0.3)).toBe('font');
    expect(birdFit(0.8)).toBe('cell');
    expect(birdFit(1.4)).toBe('cell');
    expect(birdFit(2)).toBe('stamp');
  });

  it('has a head forward and a body in every pose of every species', () => {
    for (const species of BIRD_SPECIES_ORDER) {
      for (const pose of [BirdPose.spread, BirdPose.raised, BirdPose.perched]) {
        for (const detail of [5, 10, 20]) {
          let ink = 0;
          for (let u = 0.025; u < 1; u += 0.05) {
            for (let v = 0.025; v < 1; v += 0.05) {
              if (birdInk(species, pose, u, v, detail) !== '.') ink++;
            }
          }
          expect(ink, `${species} ${pose} ${detail}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('turns one-cell glyphs to their heading', () => {
    expect(birdGlyphs()).toHaveLength(12);
    const g = birdGlyph(BirdPose.spread, BirdHeading.right);
    expect(birdOf(g)).toEqual({ pose: BirdPose.spread, heading: BirdHeading.right });
    // Heading up, the head is at the top; heading right, at the right.
    const up = birdPixels({ pose: BirdPose.spread, heading: BirdHeading.up }, 10);
    const right = birdPixels({ pose: BirdPose.spread, heading: BirdHeading.right }, 10);
    expect(up(4, 1)).toBe('o');
    expect(right(8, 4)).toBe('o');
    expect(right(4, 1)).toBe('.');
  });
});
