/**
 * The manananggal's sprite sheet (SPEC.md §4), painted once in code rather than from the font. The
 * map looks straight down, so it is drawn from above, face to the ground, with its head toward the
 * top of the frame: parted hair streaming down its back, arms reaching ahead, bat wings to either
 * side and its entrails trailing behind. The legs it left behind are a single frame, since they
 * don't move, with the raw waist uppermost.
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
  gutDark: 9,
  gut: 10,
  claw: 11,
  dress: 12,
  dressShade: 13,
  tongue: 14,
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
  [38, 30, 58, 255],
  [104, 90, 142, 255],
  [150, 30, 58, 255],
  [236, 112, 124, 255],
  [255, 248, 228, 255],
  [84, 70, 112, 255],
  [56, 46, 78, 255],
  [214, 74, 96, 255],
];

type Point = readonly [number, number];
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const mixPoint = (a: Point, b: Point, t: number): Point => [mix(a[0], b[0], t), mix(a[1], b[1], t)];
/** From `from`, along `angle` above +x (so toward the head), with its x narrowed by `span`. */
const polar = (from: Point, angle: number, length: number, span = 1): Point => [
  from[0] + Math.cos(angle) * length * span,
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
      if (r <= 0.5) this.dot(x, y, ink);
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

/**
 * The points of the wing on the figure's right (+x). From above, a beat shows as the wing narrowing
 * at the top and bottom of its stroke (`span`) and reaching ahead or falling back (`sweep`).
 */
function wingPoints(span: number, sweep: number, fold: number) {
  const shoulder: Point = [3, -3];
  const arm = 0.4 + sweep,
    forearm = 0.12 + sweep * 1.4;
  const elbow = polar(shoulder, arm, 7.5, span);
  const wrist = polar(elbow, forearm, 7, span);
  const spread = {
    shoulder,
    elbow,
    wrist,
    tips: [
      polar(wrist, forearm - 0.1, 7, span),
      polar(wrist, forearm - 1, 10.5, span),
      polar(wrist, forearm - 1.95, 13, span),
    ] as const,
    root: [3, 6] as Point,
  };
  // Folded, they lie back along its body like a cloak, with the wrists at its shoulders.
  const drawn = {
    shoulder: [3.5, -4.5] as Point,
    elbow: [8.5, -5] as Point,
    wrist: [8, -9.5] as Point,
    tips: [[9.5, 7] as Point, [6.5, 12] as Point, [2.6, 13.5] as Point] as const,
    root: [1.2, 0] as Point,
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

function drawWing(c: Canvas, side: 1 | -1, span: number, sweep: number, fold: number) {
  const w = wingPoints(span, sweep, fold);
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
  // The hooked claw at the wrist, pointing ahead.
  c.line(flip(w.wrist), flip([w.wrist[0] + 0.5, w.wrist[1] - 2.4]), 0.6, 0.4, Ink.claw);
}

/** Its back in a torn dress, down to the ragged waist, and its arms reaching ahead. */
function drawTorso(c: Canvas) {
  c.polygon(
    [
      [-5.4, -4.5],
      [5.4, -4.5],
      [4.8, -1],
      [3.6, 4.5],
      [2.6, 6.5],
      [1.2, 5],
      [0, 6.8],
      [-1.2, 5],
      [-2.6, 6.5],
      [-3.6, 4.5],
      [-4.8, -1],
    ],
    Ink.dress,
  );
  c.polygon(
    [
      [2.4, -4.5],
      [5.4, -4.5],
      [4.8, -1],
      [3.6, 4.5],
      [2.6, 6.5],
      [1.6, 5.2],
    ],
    Ink.dressShade,
  );
  for (const side of [1, -1] as const) {
    c.ellipse(side * 5, -3.8, 1.8, 1.6, Ink.skin);
    c.line([side * 5.4, -4.4], [side * 7.4, -8], 1, 0.8, Ink.skin);
    c.line([side * 7.4, -8], [side * 4.8, -12.6], 0.8, 0.7, Ink.skinShade);
    c.dot(side * 3.9, -14, Ink.claw);
    c.dot(side * 4.9, -14.2, Ink.claw);
    c.dot(side * 5.9, -13.6, Ink.claw);
  }
}

/** The crown of its head, and parted hair lying back along its spine, drifting by `drift`. */
function drawHead(c: Canvas, cy: number, drift: number, length: number) {
  const end = cy + length;
  c.polygon(
    [
      [-3.6, cy],
      [-3.1, cy + length * 0.4],
      [-2.7 + drift * 0.5, cy + length * 0.7],
      [-1 + drift, end],
      [0.2 + drift, end + 1.5],
      [1.2 + drift, end],
      [2.7 + drift * 0.5, cy + length * 0.7],
      [3.1, cy + length * 0.4],
      [3.6, cy],
    ],
    Ink.hair,
  );
  c.ellipse(0, cy, 4.2, 4.6, Ink.hair);
  // Strands, and the pale parting that says this is the top of a head.
  for (const side of [1, -1] as const) {
    c.line([side * 2.4, cy - 2.2], [side * 2.6, cy + 2.4], 0.4, 0.4, Ink.hairLight);
    c.line(
      [side * 1.7, cy + 3],
      [side * 1.3 + drift * 0.7, cy + length * 0.75],
      0.4,
      0.4,
      Ink.hairLight,
    );
  }
  c.line([0, cy - 3.8], [0, cy + 2.6], 0.4, 0.4, Ink.skinShade);
}

/** Loops of gut trailing behind the waist, waving by `phase` in 0..1. */
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

/** How narrow and how far ahead the wings are at this share of the beat. */
export function wingBeatShape(phase: number) {
  const angle = phase * Math.PI * 2 + 0.25;
  return { span: Math.cos(Math.sin(angle) * 0.7) * 0.9, sweep: -Math.cos(angle) * 0.16 };
}

function flapFrame(c: Canvas, frame: number) {
  const phase = frame / SpriteFrame.flaps,
    { span, sweep } = wingBeatShape(phase);
  drawWing(c, 1, span, sweep, 0);
  drawWing(c, -1, span, sweep, 0);
  drawTorso(c);
  drawHead(c, -8.5, Math.sin(phase * Math.PI * 2) * 0.9, 16);
  c.outline();
}

function foldFrame(c: Canvas, frame: number) {
  const fold = (frame + 1) / SpriteFrame.folds;
  const { span, sweep } = wingBeatShape(0);
  // The wings come over its back half way in.
  if (fold < 0.5) {
    drawWing(c, 1, span, sweep, fold);
    drawWing(c, -1, span, sweep, fold);
    drawTorso(c);
  } else {
    drawTorso(c);
    drawWing(c, 1, span, sweep, fold);
    drawWing(c, -1, span, sweep, fold);
  }
  drawHead(c, -8.5 + fold * 1.5, 0, 16 - fold * 4);
  c.outline();
}

function perchFrame(c: Canvas, frame: number) {
  const phase = frame / SpriteFrame.perches;
  drawEntrails(c, phase, 6, 13);
  drawTorso(c);
  drawWing(c, 1, 0.9, 0, 1);
  drawWing(c, -1, 0.9, 0, 1);
  // The long tongue let out ahead of it over the roof, feeling its way.
  const sway = Math.sin(phase * Math.PI * 2) * 2;
  let previous: Point = [0, -11];
  for (let i = 1; i <= 8; i++) {
    const t = i / 8;
    const next: Point = [Math.sin(t * 4.2) * sway * t, -11 - t * 11];
    c.line(previous, next, 0.8, 0.5, Ink.tongue);
    previous = next;
  }
  drawHead(c, -7, Math.sin(phase * Math.PI * 2) * 0.4, 12);
  c.outline();
}

function trailFrame(c: Canvas, frame: number) {
  drawEntrails(c, frame / SpriteFrame.trails, 4, 17);
  c.outline();
}

/** From above: feet showing past a torn skirt, and the raw waist uppermost. */
function lowerFrame(c: Canvas) {
  for (const side of [1, -1] as const) {
    c.ellipse(side * 2.7, 7.6, 1.7, 2.8, Ink.skin);
    c.dot(side * 2, 10.2, Ink.skinShade);
    c.dot(side * 3.2, 10.4, Ink.skinShade);
  }
  const hem: Point[] = [];
  for (let i = 0; i < 18; i++) {
    const angle = (i / 18) * Math.PI * 2;
    const r = i % 2 ? 7.4 : 8.6;
    hem.push([Math.cos(angle) * r, Math.sin(angle) * r * 0.9]);
  }
  c.polygon(hem, Ink.dress);
  c.polygon(
    hem.filter(([x]) => x > 1.5),
    Ink.dressShade,
  );
  c.ellipse(0, 0, 4.8, 4.2, Ink.dressShade);
  c.ellipse(0, 0, 3.6, 3, Ink.gutDark);
  c.ellipse(-0.5, -0.4, 1.9, 1.5, Ink.gut);
  c.dot(1.4, 0.8, Ink.gut);
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
