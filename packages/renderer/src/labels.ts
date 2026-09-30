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

/** Longest line before a label wraps, in cells. */
export const LABEL_WIDTH = 18;

/** Overlay glyph codes: 0 = nothing (the map shows), 1 = blank (hides the map), else index + 1. */
export const OVERLAY_NONE = 0;
export const OVERLAY_BLANK = 1;

type Box = { left: number; top: number; width: number; height: number };

/** The overlay grid (the same size as the cell grid) and what has been placed on it. */
export type Overlay = {
  /** Street names placed whole and rotated with their street (`rotatedLabelVertices`). */
  rotated: RotatedLabel[];
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

/** How far past the grid's edges `takenCells` reaches (at least a label's halo). */
const TAKEN_PAD = 4;

export const createOverlay = (cols: number, rows: number): Overlay => ({
  rotated: [],
  cols,
  rows,
  glyphs: new Uint16Array(cols * rows),
  taken: [],
  takenCells: new Uint8Array((cols + 2 * TAKEN_PAD) * (rows + 2 * TAKEN_PAD)),
});

/** Start another placement without allocating grids or keeping old collision boxes. */
export function resetOverlay(overlay: Overlay) {
  overlay.rotated.length = 0;
  overlay.glyphs.fill(0);
  overlay.takenCells?.fill(0);
  overlay.taken.length = 0;
}

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
export function packOverlay(
  overlay: Overlay,
  out: Uint8Array = new Uint8Array(overlay.glyphs.length * 4),
): Uint8Array {
  if (out.length !== overlay.glyphs.length * 4)
    throw new RangeError('Overlay output has the wrong size');
  out.fill(0);
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
   * `rotated` to the street's `angle` (radians, y down), over the street itself.
   */
  mode?: LabelMode;
  angle?: number;
  /** Straight-run length in horizontal label-cell widths. */
  runCells?: number;
};

export type LabelMode = 'beside' | 'rotated';
export type RotatedLabel = {
  id: number;
  col: number;
  row: number;
  angle: number;
  codes: number[];
  vis: number;
};

/** The whole word rotates; its baseline never points upside down. */
export function uprightStreetAngle(angle: number): number {
  return ((((angle + Math.PI / 2) % Math.PI) + Math.PI) % Math.PI) - Math.PI / 2;
}

export function rotatedLabelBox(
  col: number,
  row: number,
  width: number,
  angle: number,
  aspect = 1.8,
): Box {
  const c = Math.abs(Math.cos(angle)),
    s = Math.abs(Math.sin(angle));
  const w = c * (width + 2) + s * aspect * 1.4;
  const h = (s * (width + 2)) / aspect + c * 1.4;
  const left = Math.floor(col + 0.5 - w / 2),
    top = Math.floor(row + 0.5 - h / 2);
  return {
    left,
    top,
    width: Math.ceil(col + 0.5 + w / 2) - left,
    height: Math.ceil(row + 0.5 + h / 2) - top,
  };
}

/** A quad's two triangles, as (u, v) corners. */
const QUAD_UV = [0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1] as const;

/**
 * Two triangles per glyph cell, each vertex its position, UV, and glyph index (0: the halo),
 * for the street text pass; rebuilt only when label placement changes.
 */
export function rotatedLabelVertices(
  labels: readonly RotatedLabel[],
  cellWidth: number,
  cellHeight: number,
): Float32Array {
  const data: number[] = [];
  for (const label of labels) {
    const c = Math.cos(label.angle),
      s = Math.sin(label.angle);
    const centerX = (label.col + 0.5) * cellWidth,
      centerY = (label.row + 0.5) * cellHeight;
    const quad = (x0: number, height: number, code: number) => {
      for (let k = 0; k < QUAD_UV.length; k += 2) {
        const u = QUAD_UV[k]!,
          v = QUAD_UV[k + 1]!;
        const x = x0 + u * cellWidth,
          y = (v - 0.5) * height;
        data.push(centerX + c * x - s * y, centerY + s * x + c * y, u, v, code);
      }
    };
    // One cell of halo before and after the text.
    for (let i = -1; i <= label.codes.length; i++) {
      if (!labelCellShows(label.id, i + 1, label.vis)) continue;
      const x0 = (i - label.codes.length / 2) * cellWidth;
      quad(x0, cellHeight * 1.4, 0);
      if (label.codes[i]) quad(x0, cellHeight, label.codes[i]!);
    }
  }
  return Float32Array.from(data);
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

/** A box grown by the one-cell halo, left and right of the text. */
const withHalo = (b: Box): Box => ({ ...b, left: b.left - 1, width: b.width + 2 });

/**
 * Place labels in rank order. Characters the atlas lacks are drawn as `?`. Each label gets a
 * one-cell halo; a label whose text fits nowhere inside `area` (e.g. the on-screen cells)
 * without overlapping what is already placed is dropped, and so is one whose text was already
 * placed nearby (a street's other ways). Returns the labels placed, in placement order.
 */
export function placeLabels(
  overlay: Overlay,
  candidates: readonly LabelCandidate[],
  glyphIndex: (char: string) => number | undefined,
  area: LabelArea = fullArea(overlay),
  aspect = 1.8,
): LabelCandidate[] {
  const out: LabelCandidate[] = [];
  const sorted = [...candidates].sort((a, b) => a.rank - b.rank || a.id - b.id);
  const question = glyphIndex('?') ?? 0;
  const placed = new Map<string, { col: number; row: number }[]>();
  const glyphOf = (char: string) =>
    char === ' ' ? OVERLAY_BLANK : (glyphIndex(char) ?? question) + 1;

  const inArea = (b: Box) =>
    b.left >= area.left &&
    b.top >= area.top &&
    b.left + b.width <= area.right &&
    b.top + b.height <= area.bottom;

  for (const label of sorted) {
    const nearby = placed.get(label.text) ?? [];
    if (nearby.some((p) => Math.hypot(p.col - label.col, p.row - label.row) < DUPLICATE_DISTANCE)) {
      continue;
    }
    const accept = (box: Box) => {
      take(overlay, box);
      if (nearby.length === 0) placed.set(label.text, nearby);
      nearby.push({ col: label.col, row: label.row });
      out.push(label);
    };
    if (label.mode === 'rotated') {
      const chars = [...label.text.trim()];
      const angle = uprightStreetAngle(label.angle ?? 0);
      const box = rotatedLabelBox(label.col, label.row, chars.length, angle, aspect);
      const fitsRun = label.runCells === undefined || chars.length + 2 <= label.runCells;
      if (chars.length && fitsRun && inArea(box) && !isTaken(overlay, box)) {
        accept(box);
        overlay.rotated.push({
          id: label.id,
          col: label.col,
          row: label.row,
          angle,
          codes: chars.map((c) => (c === ' ' ? 0 : (glyphIndex(c) ?? question))),
          vis: label.vis ?? 1,
        });
        continue;
      }
      // Short runs, screen edges and collisions get a readable horizontal fallback.
    }
    const { lines, width } = wrapOnce(label.text);
    if (lines.length === 0 || !lines[0]) continue;
    const box = besideBoxes(label.col, label.row, width, lines.length).find(
      (b) => inArea(b) && !isTaken(overlay, withHalo(b)),
    );
    if (!box) continue;
    const halo = withHalo(box);
    accept(halo);

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
    lines.forEach((line, i) => {
      const chars = [...line];
      const start = box.left + Math.floor((width - chars.length) / 2);
      chars.forEach((char, j) => put(start + j, box.top + i, glyphOf(char)));
    });
  }
  return out;
}
