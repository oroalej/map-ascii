/**
 * The overlay: labels placed on the cell grid over the map (ARCHITECTURE.md §3 step 6),
 * greedily in priority order, with collision so they never overlap: place names (provinces,
 * cities, subdivisions, smaller places), landmarks, and monuments.
 */
import { bandVisibility, type ZoomBand } from '@atlas/shared';

/** Label priority: lower ranks are placed first. */
export const LabelRank = {
  province: 0,
  city: 1,
  subdivision: 2,
  landmark: 3,
  roadMajor: 4,
  monument: 5,
  street: 6,
  place: 7,
  /** Tertiary and smaller streets and paths, named only up close. */
  streetMinor: 8,
} as const;
export type LabelRank = (typeof LabelRank)[keyof typeof LabelRank];

/** Punctuation the label atlas lacks, spelled with the ASCII it has. */
const LABEL_ASCII: Readonly<Record<string, string>> = {
  '–': '-',
  '—': '-',
  '‘': "'",
  '’': "'",
  '“': '"',
  '”': '"',
};

/**
 * A name as a label draws it: compatibility characters spelled out (`Ⅱ` → `II`, ligatures, full
 * width forms) and typographic punctuation made ASCII, so it fits the label atlas (theme.ts
 * `labelCharacters`) instead of showing `?`. Accented Latin letters stay.
 */
export const labelText = (name: string): string =>
  name.normalize('NFKC').replace(/[–—‘’“”]/g, (c) => LABEL_ASCII[c] ?? c);

/** When curated names show (SPEC.md §4 Place-level detail); place names use their own band. */
export const LANDMARK_LABEL_BAND: ZoomBand = { min: 16 };
export const MONUMENT_LABEL_BAND: ZoomBand = { min: 18 };

/**
 * How much of a label shows at `zoom`, 0–1. Labels fade in and out over the same half level as
 * the classes (`bandVisibility`): a partly shown label keeps that share of its cells.
 */
export const labelVisibility = (band: ZoomBand, zoom: number) => bandVisibility(band, zoom);

/**
 * Whether a label's cell `k` (counted across its halo box) shows at visibility `vis`: a fixed
 * hash of the label and the cell, so the dissolve pattern stays put while the camera moves.
 */
export function labelCellShows(id: number, k: number, vis: number): boolean {
  if (vis >= 1) return true;
  let h = Math.imul(id ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(k + 1, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 8) / 0x1000000 < vis;
}

/**
 * Tilted views (orbit mode, SPEC.md §3): past map mode's 15°, names thin out so the buildings
 * show. At 60°, street and small-place names keep to the nearer 45% of the screen, and major
 * roads and monuments to the nearer 72%; landmarks and place names of subdivisions and up
 * always show. In between, the far limit rises with the pitch.
 */
export const TILT_LABEL_PITCH = 15;
const TILT_FULL_PITCH = 60;
const FAR_SHARE: Partial<Record<LabelRank, number>> = {
  [LabelRank.roadMajor]: 0.28,
  [LabelRank.monument]: 0.28,
  [LabelRank.street]: 0.55,
  [LabelRank.place]: 0.55,
  [LabelRank.streetMinor]: 0.55,
};

/**
 * Whether a label anchored at `row` (0 = top, the far edge of a tilted view) of `rows` shows at
 * `pitch` degrees.
 */
export function tiltedLabelShows(rank: number, row: number, rows: number, pitch: number): boolean {
  const share = FAR_SHARE[rank as LabelRank];
  if (share === undefined || pitch <= TILT_LABEL_PITCH || rows <= 0) return true;
  const t = Math.min(1, (pitch - TILT_LABEL_PITCH) / (TILT_FULL_PITCH - TILT_LABEL_PITCH));
  return row >= rows * share * t;
}

/** Extra rows kept clear above and below each label in tilted views, so fewer fit. */
export const TILT_LABEL_GAP = 1;

/** Longest line before a label wraps, in cells. */
export const LABEL_WIDTH = 18;

/** Overlay glyph codes: 0 = nothing (the map shows), 1 = blank (hides the map), else index + 1. */
export const OVERLAY_NONE = 0;
export const OVERLAY_BLANK = 1;

type Box = { left: number; top: number; width: number; height: number };

/** The overlay grid (the same size as the cell grid) and what has been placed on it. */
export type Overlay = {
  cols: number;
  rows: number;
  glyphs: Uint16Array;
  /** Boxes taken so far, which later placements avoid. */
  taken: Box[];
  /**
   * The same boxes by cell, 1 where taken, over the grid and `TAKEN_PAD` cells around it, so a
   * placement checks its own cells instead of every box placed.
   */
  takenCells?: Uint8Array;
};

/** How far past the grid's edges `takenCells` reaches (a halo, and a tilted view's gap). */
const TAKEN_PAD = 4;

export const createOverlay = (cols: number, rows: number): Overlay => ({
  cols,
  rows,
  glyphs: new Uint16Array(cols * rows),
  taken: [],
  takenCells: new Uint8Array((cols + 2 * TAKEN_PAD) * (rows + 2 * TAKEN_PAD)),
});

/** Whether `box` is within `takenCells` (the grid and its pad). */
const inTakenCells = (o: Overlay, b: Box) =>
  b.left >= -TAKEN_PAD &&
  b.top >= -TAKEN_PAD &&
  b.left + b.width <= o.cols + TAKEN_PAD &&
  b.top + b.height <= o.rows + TAKEN_PAD;

/** Whether `box` overlaps any box taken so far. */
function isTaken(o: Overlay, b: Box): boolean {
  const cells = o.takenCells;
  if (!cells || !inTakenCells(o, b)) return o.taken.some((p) => overlaps(p, b));
  const stride = o.cols + 2 * TAKEN_PAD;
  for (let y = b.top; y < b.top + b.height; y++) {
    const row = (y + TAKEN_PAD) * stride + TAKEN_PAD;
    for (let x = b.left; x < b.left + b.width; x++) if (cells[row + x]) return true;
  }
  return false;
}

/** Take `box`, so later placements avoid it. */
function take(o: Overlay, b: Box) {
  o.taken.push(b);
  const cells = o.takenCells;
  if (!cells) return;
  const stride = o.cols + 2 * TAKEN_PAD;
  // A box past the pad stays out of the cells: `isTaken` checks the list for boxes that reach it.
  const x0 = Math.max(b.left, -TAKEN_PAD);
  const x1 = Math.min(b.left + b.width, o.cols + TAKEN_PAD);
  const y0 = Math.max(b.top, -TAKEN_PAD);
  const y1 = Math.min(b.top + b.height, o.rows + TAKEN_PAD);
  for (let y = y0; y < y1; y++) {
    const row = (y + TAKEN_PAD) * stride + TAKEN_PAD;
    for (let x = x0; x < x1; x++) cells[row + x] = 1;
  }
}

/** The overlay as RGBA8 texels: glyph code low byte, high byte, 0, 0. */
export function packOverlay(overlay: Overlay): Uint8Array {
  const out = new Uint8Array(overlay.glyphs.length * 4);
  overlay.glyphs.forEach((glyph, i) => {
    out[i * 4] = glyph & 0xff;
    out[i * 4 + 1] = glyph >> 8;
  });
  return out;
}

/** The part of the grid placements may use: [left, top] inclusive to [right, bottom] exclusive. */
export type LabelArea = { left: number; top: number; right: number; bottom: number };

const overlaps = (a: Box, b: Box) =>
  a.left < b.left + b.width &&
  b.left < a.left + a.width &&
  a.top < b.top + b.height &&
  b.top < a.top + a.height;

const fullArea = (o: Overlay): LabelArea => ({ left: 0, top: 0, right: o.cols, bottom: o.rows });

function write(o: Overlay, x: number, y: number, glyph: number) {
  if (x < 0 || y < 0 || x >= o.cols || y >= o.rows) return;
  o.glyphs[y * o.cols + x] = glyph;
}

export type LabelCandidate = {
  /** Feature index; ties in rank are broken by it so placement is stable. */
  id: number;
  text: string;
  rank: number;
  /** The anchor's cell in the grid (may be off-grid). */
  col: number;
  row: number;
  /**
   * How much of the label shows, 0–1 (default 1). A partly shown label still takes its whole
   * box, so its neighbors don't jump as it fades.
   */
  vis?: number;
  /**
   * How the text sits: `beside` the anchor (below, above, right, or left), or on one line
   * `along` a horizontal street or `down` a vertical one, over the street's own cells.
   */
  mode?: LabelMode;
};

export type LabelMode = 'beside' | 'along' | 'down';

/** Streets within this many degrees of horizontal or vertical carry their name on them. */
export const STREET_ALIGN_DEG = 20;

/**
 * How a street's name sits, from the street's direction on screen (radians, any sign; y down):
 * along it when it is near horizontal, down it when near vertical, else beside it.
 */
export function streetMode(angle: number): LabelMode {
  const deg = ((((angle * 180) / Math.PI) % 180) + 180) % 180; // 0–180
  if (deg <= STREET_ALIGN_DEG || deg >= 180 - STREET_ALIGN_DEG) return 'along';
  if (Math.abs(deg - 90) <= STREET_ALIGN_DEG) return 'down';
  return 'beside';
}

/** Labels with the same text closer than this (cells) are one: the first placed wins. */
export const DUPLICATE_DISTANCE = 30;

/** Each label text's lines at `LABEL_WIDTH`, and their width in characters, wrapped once. */
const wrapped = new Map<string, { lines: string[]; width: number }>();
const WRAPPED_MAX = 20_000;
function wrapOnce(text: string) {
  let found = wrapped.get(text);
  if (!found) {
    const lines = wrapText(text);
    found = { lines, width: Math.max(0, ...lines.map((l) => [...l].length)) };
    if (wrapped.size >= WRAPPED_MAX) wrapped.clear();
    wrapped.set(text, found);
  }
  return found;
}

/** Split text into lines of at most `width` characters at word boundaries. */
export function wrapText(text: string, width = LABEL_WIDTH): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.trim().split(/\s+/)) {
    if (!word) continue;
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Candidate text boxes around an anchor: below, above, right, left. */
function besideBoxes(col: number, row: number, width: number, height: number): Box[] {
  const centered = col - Math.floor(width / 2);
  return [
    { left: centered, top: row + 1, width, height },
    { left: centered, top: row - height, width, height },
    { left: col + 2, top: row - Math.floor(height / 2), width, height },
    { left: col - 1 - width, top: row - Math.floor(height / 2), width, height },
  ];
}

/** A box grown by the one-cell halo: left and right of horizontal text, above and below `down`. */
const withHalo = (b: Box, mode: LabelMode): Box =>
  mode === 'down'
    ? { ...b, top: b.top - 1, height: b.height + 2 }
    : { ...b, left: b.left - 1, width: b.width + 2 };

const spaced = (b: Box, gap: number): Box =>
  gap > 0 ? { ...b, top: b.top - gap, height: b.height + 2 * gap } : b;

/**
 * Place labels in rank order. Characters the atlas lacks are drawn as `?`. Each label gets a
 * one-cell halo; a label whose text fits nowhere inside `area` (e.g. the on-screen cells)
 * without overlapping what is already placed is dropped, and so is one whose text was already
 * placed nearby (a street's other ways). `gap` keeps that many more rows clear above and below
 * each label (not drawn). Returns the labels placed, in placement order.
 */
export function placeLabels(
  overlay: Overlay,
  candidates: readonly LabelCandidate[],
  glyphIndex: (char: string) => number | undefined,
  area: LabelArea = fullArea(overlay),
  gap = 0,
): LabelCandidate[] {
  const out: LabelCandidate[] = [];
  const sorted = [...candidates].sort((a, b) => a.rank - b.rank || a.id - b.id);
  const question = glyphIndex('?') ?? 0;
  const placed = new Map<string, { col: number; row: number }[]>();
  const glyphOf = (char: string) =>
    char === ' ' ? OVERLAY_BLANK : (glyphIndex(char) ?? question) + 1;

  for (const label of sorted) {
    const mode = label.mode ?? 'beside';
    const nearby = placed.get(label.text) ?? [];
    if (nearby.some((p) => Math.hypot(p.col - label.col, p.row - label.row) < DUPLICATE_DISTANCE)) {
      continue;
    }
    // Text on a street is one line; text beside an anchor wraps.
    const { lines, width } =
      mode === 'beside'
        ? wrapOnce(label.text)
        : { lines: [label.text.trim()], width: [...label.text.trim()].length };
    if (lines.length === 0 || !lines[0]) continue;
    const boxes =
      mode === 'along'
        ? [{ left: label.col - Math.floor(width / 2), top: label.row, width, height: 1 }]
        : mode === 'down'
          ? [{ left: label.col, top: label.row - Math.floor(width / 2), width: 1, height: width }]
          : besideBoxes(label.col, label.row, width, lines.length);
    const box = boxes.find((b) => {
      const inside =
        b.left >= area.left &&
        b.top >= area.top &&
        b.left + b.width <= area.right &&
        b.top + b.height <= area.bottom;
      const clear = spaced(withHalo(b, mode), gap);
      return inside && !isTaken(overlay, clear);
    });
    if (!box) continue;
    const halo = withHalo(box, mode);
    take(overlay, halo);
    if (nearby.length === 0) placed.set(label.text, nearby);
    nearby.push({ col: label.col, row: label.row });
    out.push(label);

    // A fading label keeps only some of its cells (text and halo alike); the map shows through
    // the rest.
    const vis = label.vis ?? 1;
    const shows = (x: number, y: number) =>
      labelCellShows(label.id, (y - halo.top) * halo.width + (x - halo.left), vis);
    const put = (x: number, y: number, glyph: number) => {
      if (shows(x, y)) write(overlay, x, y, glyph);
    };
    for (let y = halo.top; y < halo.top + halo.height; y++) {
      for (let x = halo.left; x < halo.left + halo.width; x++) put(x, y, OVERLAY_BLANK);
    }
    if (mode === 'down') {
      [...lines[0]].forEach((char, j) => put(box.left, box.top + j, glyphOf(char)));
      continue;
    }
    lines.forEach((line, i) => {
      const chars = [...line];
      const start = box.left + Math.floor((width - chars.length) / 2);
      chars.forEach((char, j) => put(start + j, box.top + i, glyphOf(char)));
    });
  }
  return out;
}
