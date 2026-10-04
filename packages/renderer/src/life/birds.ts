/**
 * The life layer's birds (SPEC.md §4 "Life layer"): which kinds fly, where each gathers, and how
 * each looks from above. A flock is one species, picked by the habitat of the roost it starts
 * over (`pickSpecies`). Like people (life/people.ts), a bird is drawn at its real size (its
 * wingspan, `birdFit`): far out a font glyph, then a silhouette in one cell (drawn pixel by pixel
 * into the glyph atlas, glyphs/atlas.ts, at Private Use code points), and closest up stamped over
 * as many cells as it covers (life/draw.ts). Each silhouette has two inks: full for the body and
 * `FIGURE_TONE` for the accent (a beak, a cap, a throat), in the species' colors (theme.ts
 * `birdPaints`, shaders/glyph.ts `birdColor`).
 */
import { doubled, Heading, inkAt, turnedPixels } from './masters';

export type BirdSpecies = 'maya' | 'swallow' | 'pigeon' | 'egret' | 'bat';
/** In theme.ts `birdPaints` order; a bird texel holds its index. */
export const BIRD_SPECIES_ORDER: readonly BirdSpecies[] = [
  'maya',
  'swallow',
  'pigeon',
  'egret',
  'bat',
];

/** What a roost is: open water, a field (grass or farmland), a park, or trees. */
export const Habitat = { water: 0, field: 1, park: 2, trees: 3 } as const;
export type Habitat = (typeof Habitat)[keyof typeof Habitat];

/** A roost's habitat, from its map class (life/geometry.ts `roostClasses`). */
export function habitatOf(className: string): Habitat {
  switch (className) {
    case 'water_area':
      return Habitat.water;
    case 'grass':
    case 'farmland':
      return Habitat.field;
    case 'trees':
      return Habitat.trees;
    default:
      return Habitat.park;
  }
}

/** Wings spread, wings raised (the other half of the beat), or sitting. */
export const BirdPose = { spread: 0, raised: 1, perched: 2 } as const;
export type BirdPose = (typeof BirdPose)[keyof typeof BirdPose];

export type BirdSpec = {
  /** Wingspan, m: how big it is drawn. */
  wingspan: number;
  flockSize: readonly [number, number];
  /** m/s */
  speed: number;
  /** Circles over a roost, m. */
  orbit: readonly [number, number];
  /** How far birds spread around the flock's center, m. */
  spread: readonly [number, number];
  /** Wing beats per second (the pose alternates). */
  flap: number;
  /** The chance a flock picking where to go next lands in a tree (config.ts `PERCH`). */
  perch: number;
  /** The chance it lands on the ground at its roost instead of circling it (not in trees). */
  ground: number;
  /** A sitting flock takes off when someone comes within this many meters (a dog, twice). */
  wary: number;
  /**
   * How likely a roost of each habitat is to have this species, relative to the others; for
   * night creatures, which roosts they favor (they fly besides the day's flocks).
   */
  habitats: Readonly<Record<keyof typeof Habitat, number>>;
  /** Out at night instead of by day (config.ts `nightActivity`). */
  nocturnal?: boolean;
};

/**
 * The species: maya (tree sparrows) in small quick flocks around trees and parks, swallows
 * sweeping wide over water and fields, pigeons over parks and plazas, and egrets, large and
 * slow, over water and rice fields (they never land in the trees here). Pigeons, egrets and maya
 * also come down to feed on suitable ground, and take off when someone comes near. By night, bats: small fruit
 * bats flitting over trees and water.
 */
export const BIRD_SPECIES: Readonly<Record<BirdSpecies, BirdSpec>> = {
  maya: {
    wingspan: 0.22,
    flockSize: [4, 9],
    speed: 7,
    orbit: [8, 20],
    spread: [1, 4],
    flap: 5,
    perch: 0.7,
    ground: 0.25,
    wary: 4,
    habitats: { water: 0.3, field: 2, park: 3, trees: 3 },
  },
  swallow: {
    wingspan: 0.32,
    flockSize: [3, 6],
    speed: 12,
    orbit: [20, 40],
    spread: [3, 10],
    flap: 4,
    perch: 0.1,
    ground: 0,
    wary: 0,
    habitats: { water: 3, field: 2, park: 1, trees: 0.5 },
  },
  pigeon: {
    wingspan: 0.65,
    flockSize: [4, 10],
    speed: 9,
    orbit: [12, 30],
    spread: [2, 6],
    flap: 3,
    perch: 0.3,
    ground: 0.4,
    wary: 3,
    habitats: { water: 0.3, field: 1, park: 3, trees: 0.5 },
  },
  egret: {
    wingspan: 0.95,
    flockSize: [2, 5],
    speed: 7,
    orbit: [25, 40],
    spread: [4, 10],
    flap: 1.5,
    perch: 0,
    ground: 0.5,
    wary: 8,
    habitats: { water: 3, field: 3, park: 0.5, trees: 0 },
  },
  bat: {
    wingspan: 0.35,
    flockSize: [2, 6],
    speed: 10,
    orbit: [10, 25],
    spread: [2, 8],
    flap: 6,
    perch: 0,
    ground: 0,
    wary: 0,
    habitats: { water: 2, field: 0.5, park: 1, trees: 3 },
    nocturnal: true,
  },
};

/** `Habitat` codes' names, for species' `habitats` weights. */
export const HABITAT_NAMES = ['water', 'field', 'park', 'trees'] as const;

/**
 * A day species for a flock over a roost of `habitat`, by the species' weights for it (night
 * creatures are spawned apart, simulate.ts `spawnFlocks`).
 */
export function pickSpecies(habitat: Habitat, rng: () => number): BirdSpecies {
  const key = HABITAT_NAMES[habitat];
  const weights = BIRD_SPECIES_ORDER.map((s) =>
    BIRD_SPECIES[s].nocturnal ? 0 : BIRD_SPECIES[s].habitats[key],
  );
  let pick = rng() * weights.reduce((a, b) => a + b, 0);
  let last = 0;
  for (let i = 0; i < weights.length; i++) {
    if (weights[i]! <= 0) continue;
    last = i;
    pick -= weights[i]!;
    if (pick < 0) return BIRD_SPECIES_ORDER[i]!;
  }
  // Rounding: the last species the habitat has.
  return BIRD_SPECIES_ORDER[last]!;
}

/**
 * How a bird `cellsAcross` cells wide (its wingspan on screen) is drawn: a font glyph while it
 * is well under a cell (theme.ts `life_bird`), a silhouette filling one cell, and from a cell
 * and a half, stamped at its real size.
 */
export function birdFit(cellsAcross: number): 'font' | 'cell' | 'stamp' {
  if (cellsAcross >= 1.5) return 'stamp';
  return cellsAcross >= 0.6 ? 'cell' : 'font';
}

/** A bird texel's last byte: set for a stamped cell of its accent. */
export const BIRD_ACCENT_BIT = 16;
/** Set for a one-cell silhouette, whose glyph holds both inks (the shader tells them apart). */
export const BIRD_SILHOUETTE_BIT = 32;

/** A bird texel's last byte: its species (bits 0–3), then `BIRD_ACCENT_BIT`, `BIRD_SILHOUETTE_BIT`. */
export const birdByte = (species: BirdSpecies, accent = false, silhouette = false) =>
  BIRD_SPECIES_ORDER.indexOf(species) |
  (accent ? BIRD_ACCENT_BIT : 0) |
  (silhouette ? BIRD_SILHOUETTE_BIT : 0);

/*
 * Birds seen from above, heading up: `#` body, `o` accent, `.` empty. Each is left–right
 * symmetric. The 5-pixel masters are shared (at that size the species don't differ); each species
 * has its own 10-pixel masters, in pose order (spread, raised, perched), and 20 is 10 doubled.
 */
// prettier-ignore
const SMALL: readonly (readonly string[])[] = [
  [
    '..o..',
    '.###.',
    '#####',
    '..#..',
    '.###.',
  ],
  [
    '..o..',
    '.###.',
    '.###.',
    '..#..',
    '.#.#.',
  ],
  [
    '.....',
    '..o..',
    '.###.',
    '.###.',
    '..#..',
  ],
];

// prettier-ignore
const MASTERS_10: Readonly<Record<BirdSpecies, readonly (readonly string[])[]>> = {
  // Small and plump, short wings, a dark cap.
  maya: [
    [
      '..........',
      '..........',
      '....oo....',
      '...oooo...',
      '.########.',
      '##########',
      '...####...',
      '....##....',
      '....##....',
      '..........',
    ],
    [
      '..........',
      '..........',
      '....oo....',
      '...oooo...',
      '..######..',
      '..#.##.#..',
      '....##....',
      '....##....',
      '....##....',
      '..........',
    ],
    [
      '..........',
      '..........',
      '..........',
      '....oo....',
      '...oooo...',
      '...####...',
      '...####...',
      '....##....',
      '....##....',
      '..........',
    ],
  ],
  // Long swept wings, a pale throat, a forked tail.
  swallow: [
    [
      '..........',
      '....##....',
      '...#oo#...',
      '..######..',
      '.##.##.##.',
      '##..##..##',
      '....##....',
      '...#..#...',
      '..#....#..',
      '..........',
    ],
    [
      '..........',
      '....##....',
      '...#oo#...',
      '...####...',
      '..#.##.#..',
      '....##....',
      '....##....',
      '...#..#...',
      '...#..#...',
      '..........',
    ],
    [
      '..........',
      '..........',
      '....##....',
      '...#oo#...',
      '...####...',
      '...####...',
      '....##....',
      '...#..#...',
      '...#..#...',
      '..........',
    ],
  ],
  // Broad wings, a dark head, a fanned tail.
  pigeon: [
    [
      '..........',
      '....oo....',
      '....oo....',
      '.########.',
      '##########',
      '#...##...#',
      '....##....',
      '...####...',
      '...####...',
      '..........',
    ],
    [
      '..........',
      '....oo....',
      '....oo....',
      '...####...',
      '..######..',
      '..#.##.#..',
      '....##....',
      '...####...',
      '...####...',
      '..........',
    ],
    [
      '..........',
      '..........',
      '....oo....',
      '...####...',
      '..######..',
      '..######..',
      '..######..',
      '...####...',
      '....##....',
      '..........',
    ],
  ],
  // Wide wings, a long neck and yellow bill ahead, legs trailing behind.
  egret: [
    [
      '....oo....',
      '....##....',
      '....##....',
      '..######..',
      '##########',
      '##########',
      '....##....',
      '....##....',
      '....oo....',
      '....oo....',
    ],
    [
      '....oo....',
      '....##....',
      '....##....',
      '...####...',
      '..######..',
      '..#.##.#..',
      '....##....',
      '....##....',
      '....oo....',
      '....oo....',
    ],
    [
      '..........',
      '....oo....',
      '....##....',
      '....##....',
      '...####...',
      '...####...',
      '...####...',
      '...####...',
      '....##....',
      '..........',
    ],
  ],
  // Scalloped wings (the fingers between), a small head, no tail. Seen only in flight: sitting
  // (by day) they are out of sight, so it is the raised pose.
  bat: [
    [
      '..........',
      '..........',
      '#...oo...#',
      '##..##..##',
      '##########',
      '.########.',
      '.#.####.#.',
      '....##....',
      '..........',
      '..........',
    ],
    [
      '..........',
      '..........',
      '....oo....',
      '...####...',
      '..######..',
      '..#.##.#..',
      '....##....',
      '....##....',
      '..........',
      '..........',
    ],
    [
      '..........',
      '..........',
      '....oo....',
      '...####...',
      '..######..',
      '..#.##.#..',
      '....##....',
      '....##....',
      '..........',
      '..........',
    ],
  ],
};

/** A species' masters for a pose, by size. */
const mastersOf = (
  species: BirdSpecies,
  pose: BirdPose,
): Readonly<Record<number, readonly string[]>> => ({
  5: SMALL[pose]!,
  10: MASTERS_10[species][pose]!,
  20: doubled(MASTERS_10[species][pose]!),
});
const MASTERS = Object.fromEntries(
  BIRD_SPECIES_ORDER.map((s) => [s, [0, 1, 2].map((p) => mastersOf(s, p as BirdPose))]),
) as Record<BirdSpecies, Readonly<Record<number, readonly string[]>>[]>;

/**
 * A stamped bird's ink at (`u` forward, `v` to the right), both 0–1 over its wingspan square:
 * from the largest master no finer than `detail` (how many sixths of a cell it spans).
 */
export function birdInk(
  species: BirdSpecies,
  pose: BirdPose,
  u: number,
  v: number,
  detail: number,
): string {
  return inkAt(MASTERS[species][pose]!, u, v, detail);
}

/** Which way a one-cell bird faces on screen. */
export const BirdHeading = Heading;
export type BirdHeading = Heading;

/** A one-cell bird glyph: shared by the species (their colors tell them apart). */
export type BirdGlyph = { pose: BirdPose; heading: BirdHeading };

const FIRST_CODE = 0xe100;
const glyphTable: BirdGlyph[] = [];
for (const pose of [0, 1, 2] as const) {
  for (const heading of [0, 1, 2, 3] as const) glyphTable.push({ pose, heading });
}
const glyphOf = (g: BirdGlyph) => String.fromCharCode(FIRST_CODE + g.pose * 4 + g.heading);
const byGlyph = new Map(glyphTable.map((g) => [glyphOf(g), g]));

export const birdGlyph = (pose: BirdPose, heading: BirdHeading) => glyphOf({ pose, heading });

/** Which bird a glyph draws, if it is one. */
export const birdOf = (glyph: string): BirdGlyph | undefined => byGlyph.get(glyph);

/** Every glyph birds draw with, for the map atlas (theme.ts `mapGlyphs`). */
export function birdGlyphs(): string[] {
  return [...byGlyph.keys()];
}

/**
 * A one-cell bird's pixels in a `box` × `box` square: '#' body, 'o' accent, '.' empty. The
 * pigeon's smallest master at least `box` wide is sampled down to it, then turned to its heading.
 */
export function birdPixels(g: BirdGlyph, box: number): (x: number, y: number) => string {
  return turnedPixels(MASTERS.pigeon[g.pose]!, box, g.heading);
}
