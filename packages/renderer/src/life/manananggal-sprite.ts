/**
 * The manananggal's sprite sheet (SPEC.md §4), painted once in code rather than from the font: an
 * upper body on bat wings, fanged, with its entrails hanging from the waist and, on a roof, its long
 * tongue let down. The legs it left behind are a single frame, since they don't move.
 */
import { SPRITE_COLUMNS, SPRITE_ROWS, SPRITE_SIZE, SpriteFrame } from './manananggal-frames';

export const Ink = {
  clear: 0,
  edge: 1,
  wingDark: 2,
  wing: 3,
  bone: 4,
  skin: 5,
  skinShade: 6,
  hair: 7,
  hairLight: 8,
  eye: 9,
  gutDark: 10,
  gut: 11,
  fang: 12,
  dress: 13,
  dressShade: 14,
  mouth: 15,
  tongue: 16,
} as const;
type Ink = (typeof Ink)[keyof typeof Ink];

const PALETTE: readonly (readonly [number, number, number, number])[] = [
  [0, 0, 0, 0],
  [12, 3, 8, 230],
  [92, 18, 38, 255],
  [138, 28, 50, 255],
  [226, 110, 120, 255],
  [224, 206, 182, 255],
  [164, 140, 124, 255],
  [24, 18, 34, 255],
  [78, 66, 108, 255],
  [255, 58, 48, 255],
  [150, 30, 58, 255],
  [236, 112, 124, 255],
  [255, 248, 228, 255],
  [84, 70, 112, 255],
  [56, 46, 78, 255],
  [40, 6, 14, 255],
  [214, 74, 96, 255],
];

type Point = readonly [number, number];
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const mixPoint = (a: Point, b: Point, t: number): Point => [mix(a[0], b[0], t), mix(a[1], b[1], t)];
const polar = (from: Point, angle: number, length: number, squash = 1): Point => [
  from[0] + Math.cos(angle) * length * squash,
  from[1] - Math.sin(angle) * length,
];

/** A frame of palette inks, centred on the origin with y down. */
class Canvas {
  readonly ink = new Uint8Array(SPRITE_SIZE * SPRITE_SIZE);

  private put(ix: number, iy: number, ink: Ink) {
    if (ix >= 0 && iy >= 0 && ix < SPRITE_SIZE && iy < SPRITE_SIZE)
      this.ink[iy * SPRITE_SIZE + ix] = ink;
  }

  polygon(points: readonly Point[], ink: Ink) {
    const half = SPRITE_SIZE / 2;
    for (let iy = 0; iy < SPRITE_SIZE; iy++) {
      const y = iy - half + 0.5;
      const crossings: number[] = [];
      for (let i = 0; i < points.length; i++) {
        const a = points[i]!,
          b = points[(i + 1) % points.length]!;
        if (a[1] <= y !== b[1] <= y)
          crossings.push(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
      }
      crossings.sort((p, q) => p - q);
      for (let i = 0; i + 1 < crossings.length; i += 2)
        for (
          let ix = Math.ceil(crossings[i]! + half - 0.5);
          ix <= Math.floor(crossings[i + 1]! + half - 0.5);
          ix++
        )
          this.put(ix, iy, ink);
    }
  }

  ellipse(cx: number, cy: number, rx: number, ry: number, ink: Ink) {
    const half = SPRITE_SIZE / 2;
    for (let iy = Math.floor(cy - ry + half); iy <= Math.ceil(cy + ry + half); iy++)
      for (let ix = Math.floor(cx - rx + half); ix <= Math.ceil(cx + rx + half); ix++) {
        const dx = (ix - half + 0.5 - cx) / rx,
          dy = (iy - half + 0.5 - cy) / ry;
        if (dx * dx + dy * dy <= 1) this.put(ix, iy, ink);
      }
  }

  /** A stroke, tapering from `r0` to `r1`, in half-widths. */
  line(a: Point, b: Point, r0: number, r1: number, ink: Ink) {
    const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) * 2));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps,
        [x, y] = mixPoint(a, b, t),
        r = mix(r0, r1, t);
      if (r <= 0.5) this.put(Math.floor(x + SPRITE_SIZE / 2), Math.floor(y + SPRITE_SIZE / 2), ink);
      else this.ellipse(x, y, r, r, ink);
    }
  }

  dot(x: number, y: number, ink: Ink) {
    this.put(Math.floor(x + SPRITE_SIZE / 2), Math.floor(y + SPRITE_SIZE / 2), ink);
  }

  /** A dark line round the figure, so it holds its shape over a pale roof. */
  outline() {
    const from = this.ink.slice();
    for (let iy = 0; iy < SPRITE_SIZE; iy++)
      for (let ix = 0; ix < SPRITE_SIZE; ix++) {
        if (from[iy * SPRITE_SIZE + ix]) continue;
        const near =
          (ix > 0 && from[iy * SPRITE_SIZE + ix - 1]) ||
          (ix + 1 < SPRITE_SIZE && from[iy * SPRITE_SIZE + ix + 1]) ||
          (iy > 0 && from[(iy - 1) * SPRITE_SIZE + ix]) ||
          (iy + 1 < SPRITE_SIZE && from[(iy + 1) * SPRITE_SIZE + ix]);
        if (near) this.ink[iy * SPRITE_SIZE + ix] = Ink.edge;
      }
  }
}

/** The points of one wing on the figure's right (+x), raised by `lift` in -1..1, drawn in by `fold`. */
function wingPoints(lift: number, fold: number) {
  const shoulder: Point = [4, -5];
  const arm = 0.1 + lift * 0.55;
  const forearm = arm + 0.32;
  // Seen from ahead, a wing at the top or bottom of its beat is foreshortened.
  const squash = Math.cos(lift * 0.55) * 0.84;
  const elbow = polar(shoulder, arm, 7.5, squash);
  const wrist = polar(elbow, forearm, 6.5, squash);
  const spread = {
    shoulder,
    elbow,
    wrist,
    tips: [
      polar(wrist, forearm - 0.3, 7, squash),
      polar(wrist, forearm - 1.15, 10, squash),
      polar(wrist, forearm - 2, 12, squash),
    ] as const,
    root: [3, 6] as Point,
  };
  const drawn = {
    shoulder: [3.5, -6] as Point,
    elbow: [9, -5] as Point,
    wrist: [8.5, -13] as Point,
    tips: [[11.5, 8] as Point, [8, 15] as Point, [3.5, 15] as Point] as const,
    root: [2, -1] as Point,
  };
  return {
    shoulder: mixPoint(spread.shoulder, drawn.shoulder, fold),
    elbow: mixPoint(spread.elbow, drawn.elbow, fold),
    wrist: mixPoint(spread.wrist, drawn.wrist, fold),
    tips: spread.tips.map((tip, i) => mixPoint(tip, drawn.tips[i]!, fold)),
    root: mixPoint(spread.root, drawn.root, fold),
  };
}

/** The curve of membrane hanging between two finger tips, pulled in toward `anchor`. */
function scallop(a: Point, b: Point, anchor: Point): Point[] {
  const points: Point[] = [];
  for (let i = 1; i < 5; i++) {
    const t = i / 5,
      pull = 0.26 * Math.sin(t * Math.PI);
    points.push(mixPoint(mixPoint(a, b, t), anchor, pull));
  }
  return points;
}

function drawWing(c: Canvas, side: 1 | -1, lift: number, fold: number) {
  const w = wingPoints(lift, fold);
  const flip = (p: Point): Point => [p[0] * side, p[1]];
  const [t0, t1, t2] = w.tips as [Point, Point, Point];
  c.polygon([w.wrist, t0, ...scallop(t0, t1, w.wrist), t1].map(flip), Ink.wing);
  c.polygon([w.wrist, t1, ...scallop(t1, t2, w.wrist), t2].map(flip), Ink.wingDark);
  c.polygon(
    [w.shoulder, w.elbow, w.wrist, t2, ...scallop(t2, w.root, w.elbow), w.root].map(flip),
    Ink.wing,
  );
  for (const tip of w.tips) c.line(flip(w.wrist), flip(tip), 0.7, 0.4, Ink.bone);
  c.line(flip(w.shoulder), flip(w.elbow), 1.1, 0.9, Ink.bone);
  c.line(flip(w.elbow), flip(w.wrist), 0.9, 0.7, Ink.bone);
  // The hooked claw at the wrist.
  c.line(flip(w.wrist), flip([w.wrist[0] + 0.6, w.wrist[1] - 2.4]), 0.6, 0.4, Ink.fang);
}

/** Head, hair and torso, `dy` lower on the frame; `hunch` brings the head down into the shoulders. */
function drawBody(c: Canvas, dy: number, sway: number, hunch: number, blink: boolean) {
  const head = -11.5 + dy + hunch * 2;
  // Hair behind everything, falling past the shoulders and lifting in the beat.
  c.polygon(
    [
      [-5, head - 1],
      [-7 + sway, 1 + dy],
      [-6 + sway * 1.5, 7 + dy],
      [-3, 3 + dy],
      [3, 3 + dy],
      [6 + sway * 1.5, 7 + dy],
      [7 + sway, 1 + dy],
      [5, head - 1],
    ],
    Ink.hair,
  );
  c.line([-5.6 + sway, 0 + dy], [-5.4 + sway * 1.4, 5 + dy], 0.4, 0.4, Ink.hairLight);
  c.line([5.6 + sway, 0 + dy], [5.4 + sway * 1.4, 5 + dy], 0.4, 0.4, Ink.hairLight);

  // Torn dress, narrowing to the ragged waist.
  c.polygon(
    [
      [-5, -5 + dy],
      [5, -5 + dy],
      [3.6, 3 + dy],
      [2.6, 5 + dy],
      [1.2, 3.6 + dy],
      [0, 5.4 + dy],
      [-1.2, 3.6 + dy],
      [-2.6, 5 + dy],
      [-3.6, 3 + dy],
    ],
    Ink.dress,
  );
  c.polygon(
    [
      [1.5, -5 + dy],
      [5, -5 + dy],
      [3.6, 3 + dy],
      [2.6, 5 + dy],
      [1.2, 3.6 + dy],
    ],
    Ink.dressShade,
  );
  // Neck and bare shoulders.
  c.polygon(
    [
      [-5, -5.6 + dy],
      [5, -5.6 + dy],
      [1.6, -3.4 + dy],
      [-1.6, -3.4 + dy],
    ],
    Ink.skin,
  );
  c.ellipse(0, head + 4, 1.7, 2.6, Ink.skinShade);

  // Arms, thin, with the hands hooked forward.
  for (const side of [1, -1] as const) {
    c.line([side * 5, -4.6 + dy], [side * 7, 0.6 + dy], 1, 0.8, Ink.skin);
    c.line([side * 7, 0.6 + dy], [side * 4.4, 3.2 + dy], 0.8, 0.7, Ink.skinShade);
    c.dot(side * 3.7, 4 + dy, Ink.fang);
    c.dot(side * 4.7, 4.2 + dy, Ink.fang);
  }

  // Face, with the hair parted over it.
  c.ellipse(0, head, 4.1, 4.8, Ink.skin);
  c.polygon(
    [
      [-4.8, head + 1.6],
      [-4.8, head - 3],
      [-2.2, head - 5.4],
      [2.2, head - 5.4],
      [4.8, head - 3],
      [4.8, head + 1.6],
      [3.2, head - 1.6],
      [0.6, head - 3.6],
      [-0.6, head - 3.6],
      [-3.2, head - 1.6],
    ],
    Ink.hair,
  );
  c.dot(-2.2, head - 4.2, Ink.hairLight);
  c.dot(-1, head - 4.6, Ink.hairLight);
  for (const side of [1, -1] as const) {
    const x = side > 0 ? 1.2 : -2.2;
    if (blink) {
      c.dot(x, head - 0.5, Ink.skinShade);
      c.dot(x + 1, head - 0.5, Ink.skinShade);
    } else {
      c.dot(x, head - 0.5, Ink.eye);
      c.dot(x + 1, head - 0.5, Ink.eye);
    }
  }
  // Open mouth and fangs.
  c.polygon(
    [
      [-1.8, head + 1.6],
      [1.8, head + 1.6],
      [1.1, head + 3.4],
      [-1.1, head + 3.4],
    ],
    Ink.mouth,
  );
  c.dot(-1.5, head + 1.8, Ink.fang);
  c.dot(1.5, head + 1.8, Ink.fang);
}

/** Loops of gut hanging from the waist, waving by `phase` in 0..1. */
function drawEntrails(c: Canvas, phase: number, top: number, length: number) {
  const wave = phase * Math.PI * 2;
  const strand = (
    x: number,
    reach: number,
    amount: number,
    offset: number,
    ink: Ink,
    r: number,
  ) => {
    let previous: Point = [x, top];
    for (let i = 1; i <= 8; i++) {
      const t = i / 8;
      const next: Point = [
        x * (1 - t * 0.6) + Math.sin(wave + offset + t * 6.5) * amount * Math.sqrt(t),
        top + reach * t,
      ];
      c.line(previous, next, r, r * (1 - t * 0.35), ink);
      previous = next;
    }
  };
  strand(-1.8, length * 0.6, 2.2, 2.1, Ink.gutDark, 1);
  strand(1.8, length * 0.78, 2.6, 4.1, Ink.gutDark, 1);
  strand(0, length, 3, 0, Ink.gut, 1.1);
  // The short raw edge at the waist.
  c.ellipse(0, top - 0.4, 3, 1.4, Ink.gutDark);
  c.dot(-1, top - 0.4, Ink.gut);
  c.dot(1, top, Ink.gut);
}

/** How high the wings are through the beat, by the frame's share of it. */
export const wingLift = (phase: number) => Math.sin(phase * Math.PI * 2 + 0.25);

function flapFrame(c: Canvas, frame: number) {
  const phase = frame / SpriteFrame.flaps,
    lift = wingLift(phase);
  drawWing(c, 1, lift, 0);
  drawWing(c, -1, lift, 0);
  drawBody(c, lift * 0.8, lift * 0.8, 0, false);
  c.outline();
}

function foldFrame(c: Canvas, frame: number) {
  const fold = (frame + 1) / SpriteFrame.folds;
  const lift = wingLift(0) * (1 - fold);
  drawBody(c, lift * 0.8 + fold, 0, fold, false);
  drawWing(c, 1, lift, fold);
  drawWing(c, -1, lift, fold);
  c.outline();
}

function perchFrame(c: Canvas, frame: number) {
  const phase = (frame % 3) / 3;
  drawEntrails(c, phase, 6, 13);
  drawBody(c, 1, 0, 1, frame === SpriteFrame.perches - 1);
  drawWing(c, 1, 0, 1);
  drawWing(c, -1, 0, 1);
  // The long tongue let down from the mouth, in front of everything.
  const mouth = -6;
  let previous: Point = [0, mouth];
  const sway = Math.sin(phase * Math.PI * 2) * 2.2;
  for (let i = 1; i <= 10; i++) {
    const t = i / 10;
    const next: Point = [Math.sin(t * 2.6) * sway * t, mouth + t * 26];
    c.line(previous, next, 0.7, 0.5, Ink.tongue);
    previous = next;
  }
  c.outline();
}

function trailFrame(c: Canvas, frame: number) {
  drawEntrails(c, frame / SpriteFrame.trails, 4, 17);
  c.outline();
}

/** Drawn in the middle half of the frame, so the quad can be sized to match the upper body's pixels. */
function lowerFrame(c: Canvas) {
  for (const side of [1, -1] as const) {
    const hip: Point = [side * 2.4, -2];
    const knee: Point = [side * 2.7, 4];
    const ankle: Point = [side * 2.5, 10];
    c.line(hip, knee, 1.7, 1.3, Ink.skin);
    c.line(knee, ankle, 1.3, 1, side > 0 ? Ink.skinShade : Ink.skin);
    c.line(ankle, [side * 3.6, 11], 1, 0.8, Ink.skinShade);
  }
  c.polygon(
    [
      [-4.6, -7],
      [4.6, -7],
      [5.6, 0.5],
      [3.6, -0.5],
      [1.8, 1],
      [0, -0.5],
      [-1.8, 1],
      [-3.6, -0.5],
      [-5.6, 0.5],
    ],
    Ink.dress,
  );
  c.polygon(
    [
      [1.5, -7],
      [4.6, -7],
      [5.6, 0.5],
      [3.6, -0.5],
      [1.8, 1],
    ],
    Ink.dressShade,
  );
  c.ellipse(0, -7.4, 4.6, 1.8, Ink.gutDark);
  c.ellipse(-0.8, -7.6, 2.4, 0.9, Ink.gut);
  c.dot(1.8, -7, Ink.gut);
  c.outline();
}

export function spriteFrameInks(frame: number): Uint8Array {
  const c = new Canvas();
  if (frame < SpriteFrame.fold) flapFrame(c, frame);
  else if (frame < SpriteFrame.perch) foldFrame(c, frame - SpriteFrame.fold);
  else if (frame < SpriteFrame.trail) perchFrame(c, frame - SpriteFrame.perch);
  else if (frame < SpriteFrame.lower) trailFrame(c, frame - SpriteFrame.trail);
  else lowerFrame(c);
  return c.ink;
}

/** The whole sheet as RGBA rows from the top, for one upload the first time the figure shows. */
export function bakeSpriteSheet() {
  const width = SPRITE_COLUMNS * SPRITE_SIZE,
    height = SPRITE_ROWS * SPRITE_SIZE;
  const data = new Uint8Array(width * height * 4);
  for (let frame = 0; frame < SpriteFrame.count; frame++) {
    const ink = spriteFrameInks(frame);
    const ox = (frame % SPRITE_COLUMNS) * SPRITE_SIZE,
      oy = Math.floor(frame / SPRITE_COLUMNS) * SPRITE_SIZE;
    for (let y = 0; y < SPRITE_SIZE; y++)
      for (let x = 0; x < SPRITE_SIZE; x++) {
        const color = PALETTE[ink[y * SPRITE_SIZE + x]!]!;
        data.set(color, ((oy + y) * width + ox + x) * 4);
      }
  }
  return { width, height, data };
}
