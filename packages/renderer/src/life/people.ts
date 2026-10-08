/**
 * The life layer's people (SPEC.md §4 "Life layer"): how each looks from above. A person is a
 * figure, drawn pixel by pixel into the glyph atlas (glyphs/atlas.ts) at Private Use code points,
 * never by the font: head and shoulders turned with the heading, stepping as it walks, in its
 * shirt's color; a child, smaller; or an umbrella's canopy. Like a vehicle, a figure is drawn at
 * its real size (`FIGURE_SIZE_M`, `figureFit`), in proportion to the cars around it: part of a
 * cell, a whole one, 2×2 cells, and closest up stamped over as many cells as it covers
 * (life/draw.ts), but never smaller than `MIN_FIGURE_PX` on screen.
 * Each figure glyph has two inks: full for its paint (a shirt, a canopy),
 * and `FIGURE_TONE` for its skin (the theme's person color) or a canopy's ribs, which the glyph
 * shader tells apart (shaders/glyph.ts `personColor`).
 */
import { doubled, inkAt, turnedPixels, type Heading } from './masters';
import { Paint } from './vehicles';
import { UMBRELLA_MOTION } from './config';

/** Walking or seated people, a child, an umbrella, or a paddler with their paddle. */
export type CarrierFigure = 'pole-buckets' | 'basket' | 'head-tray' | 'chest-tray';
export type PersonFigure = 'adult' | 'child' | 'umbrella' | 'rower' | 'seated' | CarrierFigure;
export type PersonPose = 'attentive' | 'gesture';

/**
 * One person as drawn (life/draw.ts `drawPeople`): their figure and its paint (`PAINT_NONE` for
 * none), their slot in a group (`lateral` to the right of the first, `back` behind it), and
 * which step of their stride they are on.
 */
export type PersonLook = {
  figure: PersonFigure;
  paint: number;
  lateral: number;
  back: number;
  flap: number;
  /** Stationary social pose; age, clothing and physical size remain the same. */
  pose?: PersonPose;
  /** A partly open canopy over the person's own figure and shirt. */
  canopy?: { open: number; figure: PersonFigure; paint: number };
};

/**
 * How wide each figure is, m: across the shoulders with the arms, or an umbrella's canopy. The
 * figure is drawn this big, like a vehicle, in proportion to the cars around it.
 */
export const FIGURE_SIZE_M: Readonly<Record<PersonFigure, number>> = {
  adult: 0.6,
  seated: 0.6,
  child: 0.45,
  umbrella: 1,
  // A paddler with their paddle reaching out over the water.
  rower: 1.2,
  'pole-buckets': 1.6,
  basket: 0.9,
  'head-tray': 1,
  'chest-tray': 0.9,
};

/** A one-cell figure's width, as a share of the cell's (`figureFit`). */
export const FIGURE_SCALES = [0.6, 0.8, 1] as const;
export type FigureScale = 0 | 1 | 2;
/** A one-cell figure is never narrower than this, device px (unless the cell is). */
export const MIN_FIGURE_PX = 6;

/**
 * How a figure `cellsAcross` cells wide (its real width on screen, `FIGURE_SIZE_M`) is drawn:
 * in one cell at the nearest of `FIGURE_SCALES` (the smallest, if it is narrower still); over 2×2
 * cells once it is a cell and a half wide (adults and umbrellas); and once it is 3 cells wide (a
 * child 2), stamped at its real size like a vehicle (life/draw.ts `stampFigure`).
 */
export function figureFit(
  figure: PersonFigure,
  cellsAcross: number,
): FigureScale | 'big' | 'stamp' {
  if (cellsAcross >= (figure === 'child' ? 2 : 3)) return 'stamp';
  // A paddler shows only close up (life/procession.ts `PROCESSION.crewZoom`): never in one cell.
  if ((cellsAcross >= 1.5 && figure !== 'child') || figure === 'rower') return 'big';
  return cellsAcross < 0.7 ? 0 : cellsAcross < 0.9 ? 1 : 2;
}

/**
 * How the shader colors a person texel. A figure glyph's tone ink is skin, or a canopy's ribs;
 * a stamped figure's cells (all full ink) say which they show.
 */
export const PersonPart = { figure: 0, canopy: 1, skin: 2, rib: 3, puff: 4 } as const;
export type PersonPart = (typeof PersonPart)[keyof typeof PersonPart];

/** Coverage of the tone ink (0–255); the shader splits full ink from tone at 0.7. */
export const FIGURE_TONE = 110;
/** No paint: the figure takes the theme's person color. */
export const PAINT_NONE = 15;
/** Holding a candle (lit at dusk and night). */
export const CANDLE_BIT = 128;

/** A person's paint (bits 0–3), part (4–6), and candle (bit 7), in the life texel's last byte. */
export const personByte = (paint: number, part: PersonPart, candle = false) =>
  (paint & 15) | (part << 4) | (candle ? CANDLE_BIT : 0);

const P = Paint;

/** Shirts, each equally likely. */
export const SHIRT_PAINTS: readonly number[] = [
  P.white,
  P.white,
  P.red,
  P.blue,
  P.sky,
  P.yellow,
  P.green,
  P.orange,
  P.purple,
  P.pink,
  P.teal,
  P.maroon,
  P.cream,
  P.graphite,
];

/** Umbrellas: mostly the plain black payong. */
export const UMBRELLA_PAINTS: readonly number[] = [
  P.graphite,
  P.graphite,
  P.graphite,
  P.red,
  P.blue,
  P.purple,
  P.pink,
  P.green,
  P.yellow,
];

/*
 * Figures seen from above, heading up, left hand forward: `#` paint, `o` tone, `.` empty. Solid,
 * so a person has the weight of the cars beside them: the shoulders across the whole width, the
 * head in their middle, and the arms swinging forward and back. Each is the same turned half
 * round, so heading down draws the same; the other step is its mirror, and heading across the
 * screen, it turned a quarter. Drawn from the smallest master at least as big as the glyph
 * (`figurePixels`).
 */
// prettier-ignore
const ADULT_10 = [
  '..........',
  'oo........',
  '##..oo....',
  '###oooo###',
  '###oooo###',
  '###oooo###',
  '###oooo###',
  '....oo..##',
  '........oo',
  '..........',
];

// prettier-ignore
const ADULT: Readonly<Record<number, readonly string[]>> = {
  5: [
    'o....',
    '##o##',
    '#ooo#',
    '##o##',
    '....o',
  ],
  10: ADULT_10,
  20: doubled(ADULT_10),
};

/** A child: slighter shoulders, a larger head for them. */
// prettier-ignore
const CHILD: Readonly<Record<number, readonly string[]>> = {
  5: [
    '.....',
    '.o...',
    '#ooo#',
    '...o.',
    '.....',
  ],
  10: [
    '..........',
    '.oo.......',
    '.##.oo....',
    '.##oooo##.',
    '.##oooo##.',
    '.##oooo##.',
    '.##oooo##.',
    '....oo.##.',
    '.......oo.',
    '..........',
  ],
};

/** Stationary shoulders and an off-center head make all four headings readable from above. */
// prettier-ignore
const ATTENTIVE_ADULT_10 = [
  '..........', '..........', '....oo....', '...oooo...', '...oooo...',
  '..##oo##..', '.########.', '.########.', '..######..', '..........',
];
// prettier-ignore
const GESTURE_ADULT_10 = [
  '.oo.......', '.##.......', '.##.oo....', '.##oooo...', '.##oooo...',
  '.###oo##..', '.########.', '..#######.', '..######..', '..........',
];
// prettier-ignore
const ATTENTIVE_CHILD_10 = [
  '..........', '..........', '....oo....', '...oooo...', '...oooo...',
  '...#oo#...', '..######..', '..######..', '...####...', '..........',
];
// prettier-ignore
const GESTURE_CHILD_10 = [
  '..oo......', '..##......', '..##oo....', '..#oooo...', '..#oooo...',
  '..##oo#...', '..######..', '...#####..', '...####...', '..........',
];
const stationaryMasters = (small: readonly string[], medium: readonly string[]) => ({
  5: small,
  10: medium,
  20: doubled(medium),
});
export const POSE_MASTERS = {
  adult: {
    attentive: stationaryMasters(['.....', '..o..', '.#o#.', '.###.', '.###.'], ATTENTIVE_ADULT_10),
    gesture: stationaryMasters(['o....', '#.o..', '##o#.', '.###.', '.###.'], GESTURE_ADULT_10),
  },
  child: {
    attentive: stationaryMasters(['.....', '..o..', '..o..', '.###.', '..#..'], ATTENTIVE_CHILD_10),
    gesture: stationaryMasters(['.o...', '.#o..', '.#o..', '.###.', '..#..'], GESTURE_CHILD_10),
  },
} as const;

const poseMasters = (figure: PersonFigure, pose?: PersonPose) =>
  pose && (figure === 'adult' || figure === 'child') ? POSE_MASTERS[figure][pose] : undefined;

/** An umbrella's canopy: an octagon, its ribs crossing to the tip (just the tip when small). */
function canopy(n: number, share = 1): string[] {
  let m = Math.min(n, Math.max(3, Math.round(n * share)));
  // Larger boxes have room for two distinct, centered insets. Compact stages keep their
  // minimum ink width even when that requires a half-pixel offset.
  if (share < 1 && n >= 7)
    m = Math.max(n % 2 === 0 ? 4 : 3, Math.min(n - 2, n - 2 * Math.round((n - n * share) / 2)));
  const offset = Math.floor((n - m) / 2);
  const cut = Math.max(1, Math.round(m / 5));
  const tip0 = Math.floor((m - 1) / 2);
  const tip1 = Math.ceil((m - 1) / 2);
  return Array.from({ length: n }, (_, y) =>
    Array.from({ length: n }, (_, x) => {
      const cx = x - offset;
      const cy = y - offset;
      if (cx < 0 || cy < 0 || cx >= m || cy >= m) return '.';
      if (Math.min(cx, m - 1 - cx) + Math.min(cy, m - 1 - cy) < cut) return '.';
      const rib =
        m >= 8
          ? cx === cy || cx + cy === m - 1
          : share === 1
            ? cx === cy && 2 * cx === m - 1
            : cx >= tip0 && cx <= tip1 && cy >= tip0 && cy <= tip1;
      return rib ? 'o' : '#';
    }).join(''),
  );
}

const UMBRELLA: Readonly<Record<number, readonly string[]>> = {
  5: canopy(5),
  10: canopy(10),
  20: canopy(20),
};

/**
 * A paddler seated at a boat's side, heading up, paddle on their left at the reach (its blade
 * forward): the paddle (tone) out over the water, arms to it, shoulders (paint, their team's)
 * and head (tone) in the right half. Unlike the others it is not the same turned half round:
 * turned, it is the other side's paddler at the other end of the stroke (`stroke`).
 */
// prettier-ignore
const ROWER_10 = [
  'oo........',
  'oo........',
  '..o.......',
  '...o......',
  '....o#ooo#',
  '....##ooo#',
  '.....#ooo#',
  '..........',
  '..........',
  '..........',
];

// prettier-ignore
const ROWER: Readonly<Record<number, readonly string[]>> = {
  5: [
    'o....',
    '.o...',
    '..#o#',
    '.....',
    '.....',
  ],
  10: ROWER_10,
  20: doubled(ROWER_10),
};

/** Seated facing up: knees and feet ahead of compact shoulders and the head. */
// prettier-ignore
const SEATED_10 = [
  '..oo..oo..',
  '..##..##..',
  '..##..##..',
  '..######..',
  '..######..',
  '..#oooo#..',
  '..#oooo#..',
  '...oooo...',
  '..........',
  '..........',
];
// prettier-ignore
const SEATED: Readonly<Record<number, readonly string[]>> = {
  5: ['.o.o.', '.###.', '.#o#.', '..o..', '.....'],
  10: SEATED_10,
  20: doubled(SEATED_10),
};

// Carrier props are stamped masters only: coarse views retain the existing adult glyphs.
// prettier-ignore
const CARRIERS: Record<CarrierFigure, readonly string[]> = {
  'pole-buckets': ['..........', '..........', '.ooo..ooo.', '.o#o..o#o.', '.ooo##ooo.', '....oo....', '...####...', '...####...', '....##....', '..........'],
  basket: ['..........', '..........', '....oo....', '...####...', '..######..', '...###ooo.', '...###o#o.', '....##ooo.', '....##....', '..........'],
  'head-tray': ['..........', '..oooooo..', '.oo####oo.', '.o######o.', '.oo####oo.', '..oooooo..', '..######..', '...####...', '....##....', '..........'],
  'chest-tray': ['..........', '..........', '....oo....', '...####...', '..######..', '...oooo...', '...o##o...', '...oooo...', '....##....', '..........'],
};
const carrierMasters = (figure: CarrierFigure) => ({
  10: CARRIERS[figure],
  20: doubled(CARRIERS[figure]),
});
export const isCarrier = (figure: PersonFigure): figure is CarrierFigure => figure in CARRIERS;

export const FIGURE_MASTERS: Readonly<
  Record<PersonFigure, Readonly<Record<number, readonly string[]>>>
> = {
  adult: ADULT,
  child: CHILD,
  umbrella: UMBRELLA,
  rower: ROWER,
  seated: SEATED,
  'pole-buckets': carrierMasters('pole-buckets'),
  basket: carrierMasters('basket'),
  'head-tray': carrierMasters('head-tray'),
  'chest-tray': carrierMasters('chest-tray'),
};

/** Each figure's master sizes, smallest first. */
const sizesOf = (figure: PersonFigure) =>
  Object.keys(FIGURE_MASTERS[figure])
    .map(Number)
    .sort((a, b) => a - b);
const MASTER_SIZES: Readonly<Record<PersonFigure, readonly number[]>> = {
  adult: sizesOf('adult'),
  child: sizesOf('child'),
  umbrella: sizesOf('umbrella'),
  rower: sizesOf('rower'),
  seated: sizesOf('seated'),
  'pole-buckets': sizesOf('pole-buckets'),
  basket: sizesOf('basket'),
  'head-tray': sizesOf('head-tray'),
  'chest-tray': sizesOf('chest-tray'),
};

/**
 * A figure glyph: which figure, turned across the screen or not, and which step; then for a
 * one-cell figure its `scale` (`FIGURE_SCALES`), or for a 2×2 figure which cell of it (`slice`:
 * 0 top left, 1 top right, 2 bottom left, 3 bottom right).
 */
export type FigureGlyph = {
  figure: PersonFigure;
  across: boolean;
  frame: 0 | 1;
  scale?: FigureScale;
  slice?: 0 | 1 | 2 | 3;
  /** A paddler: at the reach (0, the blade forward) or the pull (1, the master turned end to end). */
  stroke?: 0 | 1;
  /** Seated figures are directional, unlike the symmetric walking silhouettes. */
  heading?: Heading;
  pose?: PersonPose;
  stage?: 0 | 1;
};

/** Where a figure glyph goes: one cell at a scale, or one cell of a 2×2 figure. */
export type FigureAt = { scale: FigureScale } | { slice: 0 | 1 | 2 | 3 };

const FIRST_CODE = 0xe000;

const glyphTable: FigureGlyph[] = [];
for (const scale of [0, 1, 2] as const) {
  for (const figure of ['adult', 'child'] as const) {
    for (const across of [false, true]) {
      for (const frame of [0, 1] as const) glyphTable.push({ figure, across, frame, scale });
    }
  }
  glyphTable.push({ figure: 'umbrella', across: false, frame: 0, scale });
}
for (const across of [false, true]) {
  for (const frame of [0, 1] as const) {
    for (const slice of [0, 1, 2, 3] as const) {
      glyphTable.push({ figure: 'adult', across, frame, slice });
    }
  }
}
for (const slice of [0, 1, 2, 3] as const) {
  glyphTable.push({ figure: 'umbrella', across: false, frame: 0, slice });
}
// Paddlers: 2×2 only; `frame` is the side their paddle is on.
for (const across of [false, true]) {
  for (const frame of [0, 1] as const) {
    for (const stroke of [0, 1] as const) {
      for (const slice of [0, 1, 2, 3] as const) {
        glyphTable.push({ figure: 'rower', across, frame, slice, stroke });
      }
    }
  }
}

// Append seated glyphs so every existing Private Use character keeps its meaning.
for (const heading of [0, 1, 2, 3] as const) {
  for (const scale of [0, 1, 2] as const)
    glyphTable.push({ figure: 'seated', across: false, frame: 0, heading, scale });
  for (const slice of [0, 1, 2, 3] as const)
    glyphTable.push({ figure: 'seated', across: false, frame: 0, heading, slice });
}

// Append poses: legacy glyph characters, including seated figures, keep their meanings.
for (const figure of ['adult', 'child'] as const)
  for (const pose of ['attentive', 'gesture'] as const)
    for (const heading of [0, 1, 2, 3] as const) {
      for (const scale of [0, 1, 2] as const)
        glyphTable.push({ figure, pose, heading, across: false, frame: 0, scale });
      if (figure === 'adult')
        for (const slice of [0, 1, 2, 3] as const)
          glyphTable.push({ figure, pose, heading, across: false, frame: 0, slice });
    }

// Append canopy stages after poses, preserving every previous Private Use character.
for (const stage of [0, 1] as const) {
  for (const scale of [0, 1, 2] as const)
    glyphTable.push({ figure: 'umbrella', across: false, frame: 0, stage, scale });
  for (const slice of [0, 1, 2, 3] as const)
    glyphTable.push({ figure: 'umbrella', across: false, frame: 0, stage, slice });
}

const keyOf = ({
  figure,
  across,
  frame,
  scale,
  slice,
  stroke,
  heading,
  pose,
  stage,
}: FigureGlyph) => {
  const at = slice === undefined ? `s${scale}` : `c${slice}`;
  if (poseMasters(figure, pose)) return `${figure}:${pose}:${heading ?? (across ? 1 : 0)}:${at}`;
  if (figure === 'umbrella')
    return stage === undefined ? `umbrella:${at}` : `umbrella:${stage}:${at}`;
  if (figure === 'seated') return `seated:${heading ?? (across ? 1 : 0)}:${at}`;
  return `${figure}:${+across}:${frame}:${at}:${stroke ?? 0}`;
};
const byKey = new Map(glyphTable.map((g, i) => [keyOf(g), String.fromCharCode(FIRST_CODE + i)]));
const byGlyph = new Map(glyphTable.map((g, i) => [String.fromCharCode(FIRST_CODE + i), g]));

/**
 * The glyph for a figure: in one cell at a scale (a whole cell by default), or one cell of a 2×2
 * figure, which exist for adults, umbrellas, and paddlers (at each `stroke`) only.
 */
export function figureGlyph(
  figure: PersonFigure,
  across: boolean,
  frame: 0 | 1,
  at: FigureAt = { scale: 2 },
  stroke: 0 | 1 = 0,
  heading?: Heading,
  pose?: PersonPose,
  stage?: 0 | 1,
): string {
  if (isCarrier(figure)) figure = 'adult';
  return byKey.get(keyOf({ figure, across, frame, ...at, stroke, heading, pose, stage }))!;
}

/** Which figure a glyph draws, if it is one. */
export const figureOf = (glyph: string): FigureGlyph | undefined => byGlyph.get(glyph);

/** Every glyph people draw with, for the map atlas (theme.ts `mapGlyphs`). */
export function personGlyphs(): string[] {
  return [...byGlyph.keys()];
}

/**
 * A figure's pixels in a `box` × `box` square: '#' paint, 'o' tone, '.' empty. The smallest
 * master at least `box` wide is sampled down to it (the largest, if none is), then turned and
 * mirrored for its heading and step.
 * Staged canopies instead generate their pixels directly at the requested box size.
 */
export function figurePixels(g: FigureGlyph, box: number): (x: number, y: number) => string {
  if (g.figure === 'umbrella' && g.stage !== undefined) {
    const rows = canopy(box, UMBRELLA_MOTION.stages[g.stage]);
    return (x, y) => rows[y]?.[x] ?? '.';
  }
  const posed = poseMasters(g.figure, g.pose);
  if (posed) return turnedPixels(posed, box, g.heading ?? (g.across ? 1 : 0));
  if (g.figure === 'seated') return turnedPixels(SEATED, box, g.heading ?? (g.across ? 1 : 0));
  const masters = FIGURE_MASTERS[g.figure];
  const sizes = MASTER_SIZES[g.figure];
  const size = sizes.find((s) => s >= box) ?? sizes[sizes.length - 1]!;
  const master = masters[size]!;
  return (x, y) => {
    const [turnedX, turnedY] = g.across ? [y, box - 1 - x] : [x, y];
    const mx = g.frame === 1 ? box - 1 - turnedX : turnedX;
    const my = g.stroke === 1 ? box - 1 - turnedY : turnedY;
    const row = master[Math.floor(((my + 0.5) * size) / box)];
    return row?.[Math.floor(((mx + 0.5) * size) / box)] ?? '.';
  };
}

/**
 * The ink of a figure at (`u` along it from the back, `v` across it from the left), both 0–1, on
 * the step `frame` (a paddler: their side, and their `stroke`): '#' paint, 'o' tone, '.' empty,
 * for a figure stamped at its real size and sampled `detail` times across. From the largest
 * master no finer than that (the smallest, if all are), so thin lines like a canopy's ribs stay
 * as wide as a sample.
 */
export function figureInk(
  figure: PersonFigure,
  frame: 0 | 1,
  u: number,
  v: number,
  detail: number,
  stroke: 0 | 1 = 0,
  pose?: PersonPose,
): string {
  const posed = poseMasters(figure, pose);
  if (posed) return inkAt(posed, u, v, detail);
  const masters = FIGURE_MASTERS[figure];
  const sizes = MASTER_SIZES[figure];
  let size = sizes[0]!;
  for (const s of sizes) if (s <= detail) size = s;
  const at = (t: number) => Math.min(size - 1, Math.max(0, Math.floor(t * size)));
  const x = at(v);
  const y = at(1 - u);
  return masters[size]![figure !== 'seated' && stroke === 1 ? size - 1 - y : y]![
    figure !== 'seated' && frame === 1 ? size - 1 - x : x
  ]!;
}
