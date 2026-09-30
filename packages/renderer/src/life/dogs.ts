/**
 * The life layer's street dogs (askals, SPEC.md §4 "Life layer"): how each looks from above.
 * Like a person (life/people.ts), a dog is drawn at its real size (`DOG_LENGTH_M`, `dogFit`): a
 * silhouette in part of a cell, turned to its heading and stepping as it walks, drawn pixel by
 * pixel into the glyph atlas (glyphs/atlas.ts) at Private Use code points; and closest up
 * stamped over as many cells as it covers (life/draw.ts). It is drawn in the people's class
 * (life/config.ts `lifeClassFor`), in its coat's paint, with its nose and ears the darker ink.
 */
import type { Heading } from './masters';
import { doubled, inkAt, turnedPixels } from './masters';
import { Paint } from './vehicles';

/** Nose to tail, m. */
export const DOG_LENGTH_M = 0.9;

/** A one-cell dog's width, as a share of the cell's; never narrower than `MIN_DOG_PX`. */
export const DOG_SCALE = 0.7;
export const MIN_DOG_PX = 6;

/** Coats, each equally likely: tan (the most), white, cream, black, and brown. */
export const DOG_PAINTS: readonly number[] = [
  Paint.orange,
  Paint.orange,
  Paint.cream,
  Paint.white,
  Paint.graphite,
  Paint.maroon,
];

/**
 * How a dog `cellsAcross` cells long (nose to tail on screen) is drawn: in one cell until it is
 * a cell and a half long, then stamped at its real size.
 */
export const dogFit = (cellsAcross: number): 'cell' | 'stamp' =>
  cellsAcross >= 1.5 ? 'stamp' : 'cell';

/*
 * A dog seen from above, heading up: `#` coat, `o` nose and ears, `.` empty. Walking, its legs
 * reach out diagonal pairs at a time (front left with hind right, then the others); the tail
 * swings with them.
 */
// prettier-ignore
const STEP_10: readonly (readonly string[])[] = [
  [
    '....oo....',
    '...####...',
    '..o####o..',
    '.#.####...',
    '...####...',
    '...####...',
    '...####...',
    '...####.#.',
    '....##....',
    '.....#....',
  ],
  [
    '....oo....',
    '...####...',
    '..o####o..',
    '...####.#.',
    '...####...',
    '...####...',
    '...####...',
    '.#.####...',
    '....##....',
    '....#.....',
  ],
];

// prettier-ignore
const STEP_5: readonly (readonly string[])[] = [
  [
    '..o..',
    '.###.',
    '#.#..',
    '..#.#',
    '..#..',
  ],
  [
    '..o..',
    '.###.',
    '..#.#',
    '#.#..',
    '..#..',
  ],
];

const MASTERS = [0, 1].map((frame) => ({
  5: STEP_5[frame]!,
  10: STEP_10[frame]!,
  20: doubled(STEP_10[frame]!),
}));

/** A stamped dog's ink at (`u` forward, `v` to the right) over its square (life/masters.ts `inkAt`). */
export const dogInk = (frame: 0 | 1, u: number, v: number, detail: number) =>
  inkAt(MASTERS[frame]!, u, v, detail);

/** A one-cell dog glyph: which step, and which way it faces on screen. */
export type DogGlyph = { frame: 0 | 1; heading: Heading };

const FIRST_CODE = 0xe200;
const glyphOf = ({ frame, heading }: DogGlyph) =>
  String.fromCharCode(FIRST_CODE + frame * 4 + heading);
const byGlyph = new Map<string, DogGlyph>();
for (const frame of [0, 1] as const) {
  for (const heading of [0, 1, 2, 3] as const) {
    byGlyph.set(glyphOf({ frame, heading }), { frame, heading });
  }
}

export const dogGlyph = (frame: 0 | 1, heading: Heading) => glyphOf({ frame, heading });

/** Which dog a glyph draws, if it is one. */
export const dogOf = (glyph: string): DogGlyph | undefined => byGlyph.get(glyph);

/** Every glyph dogs draw with, for the map atlas (theme.ts `mapGlyphs`). */
export function dogGlyphs(): string[] {
  return [...byGlyph.keys()];
}

/** A one-cell dog's pixels in a `box` × `box` square: '#' coat, 'o' nose and ears, '.' empty. */
export const dogPixels = (g: DogGlyph, box: number) =>
  turnedPixels(MASTERS[g.frame]!, box, g.heading);
