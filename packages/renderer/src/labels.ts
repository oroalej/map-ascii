/**
 * The overlay: labels placed on the cell grid over the map (ARCHITECTURE.md §3 step 6),
 * greedily in priority order, with collision so they never overlap: place names (provinces,
 * cities, subdivisions, smaller places), landmarks, and monuments.
 */
import { bandVisibility, type ZoomBand } from '@atlas/shared';
import { layoutLabels, ROTATED_HALO_HEIGHT, TAKEN_PAD, type Box } from './label-layout';
import { STREET_REPEAT, type PlaceStability } from './label-stability';

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

/** Hard label blackout over district zooms, including fractional levels. */
export const LABEL_GAP = { min: 15, max: 17 } as const satisfies ZoomBand;

/**
 * How much of a label shows at `zoom`, 0–1. Labels fade in and out over the same half level as
 * the classes (`bandVisibility`): a partly shown label keeps that share of its cells.
 */
export const labelVisibility = (band: ZoomBand, zoom: number) =>
  zoom >= LABEL_GAP.min && zoom < LABEL_GAP.max ? 0 : bandVisibility(band, zoom);

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

/** Overlay glyph codes: 0 = nothing (the map shows), 1 = blank (hides the map), else index + 1. */
export const OVERLAY_NONE = 0;
export const OVERLAY_BLANK = 1;

/** The overlay grid (the same size as the cell grid) and what has been placed on it. */
export type Overlay = {
  /** Street names placed whole and rotated with their street (`rotatedLabelVertices`). */
  rotated: RotatedLabel[];
  cols: number;
  rows: number;
  glyphs: Uint16Array;
  /** Boxes taken so far, which later placements avoid. */
  taken: Box[];
  /** Accepted text bounds, excluding halos, for visible-label reporting. */
  placements?: Map<number, Box>;
  /**
   * The same boxes by cell, 1 where taken, over the grid and `TAKEN_PAD` cells around it, so a
   * placement checks its own cells instead of every box placed.
   */
  takenCells?: Uint8Array;
};

export const createOverlay = (cols: number, rows: number): Overlay => ({
  rotated: [],
  cols,
  rows,
  glyphs: new Uint16Array(cols * rows),
  taken: [],
  placements: new Map(),
  takenCells: new Uint8Array((cols + 2 * TAKEN_PAD) * (rows + 2 * TAKEN_PAD)),
});

/** Start another placement without allocating grids or keeping old collision boxes. */
export function resetOverlay(overlay: Overlay) {
  overlay.rotated.length = 0;
  overlay.glyphs.fill(0);
  overlay.takenCells?.fill(0);
  overlay.taken.length = 0;
  overlay.placements?.clear();
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

/** Includes blank label halos, and the rotated quads actually retained by the dissolve. */
export function overlayCoversPoint(
  overlay: Overlay,
  x: number,
  y: number,
  cellWidth: number,
  cellHeight: number,
): boolean {
  const col = Math.floor(x / cellWidth),
    row = Math.floor(y / cellHeight);
  if (
    col >= 0 &&
    row >= 0 &&
    col < overlay.cols &&
    row < overlay.rows &&
    overlay.glyphs[row * overlay.cols + col]
  )
    return true;
  for (const label of overlay.rotated) {
    const dx = x - (label.col + 0.5) * cellWidth,
      dy = y - (label.row + 0.5) * cellHeight;
    const c = Math.cos(label.angle),
      s = Math.sin(label.angle);
    const localX = c * dx + s * dy,
      localY = -s * dx + c * dy;
    if (Math.abs(localY) >= (cellHeight * ROTATED_HALO_HEIGHT) / 2) continue;
    const index = Math.floor(localX / cellWidth + label.codes.length / 2);
    if (
      index >= -1 &&
      index <= label.codes.length &&
      labelCellShows(label.id, index + 1, label.vis)
    )
      return true;
  }
  return false;
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
      quad(x0, cellHeight * ROTATED_HALO_HEIGHT, 0);
      if (label.codes[i]) quad(x0, cellHeight, label.codes[i]!);
    }
  }
  return Float32Array.from(data);
}

/** Visible streets repeat by screen distance; other names appear once on screen. */
export const repeatDistance = (rank: number): number =>
  rank === LabelRank.roadMajor || rank === LabelRank.street || rank === LabelRank.streetMinor
    ? STREET_REPEAT
    : Infinity;

/** Place collision-free layouts, retaining slots and prioritizing selected/hovered names. */
export function placeLabels(
  overlay: Overlay,
  candidates: readonly LabelCandidate[],
  glyphIndex: (char: string) => number | undefined,
  area: LabelArea = fullArea(overlay),
  aspect = 1.8,
  stability: PlaceStability = {},
): LabelCandidate[] {
  const layouts = layoutLabels(overlay, candidates, area, aspect, stability, repeatDistance);
  const question = glyphIndex('?') ?? 0;
  const glyphOf = (char: string) =>
    char === ' ' ? OVERLAY_BLANK : (glyphIndex(char) ?? question) + 1;
  for (const layout of layouts) {
    const { label } = layout;
    overlay.placements?.set(label.id, layout.textBounds);
    if (layout.slot === -1) {
      overlay.rotated.push({
        id: label.id,
        col: label.col,
        row: label.row,
        angle: layout.angle,
        codes: layout.chars.map((c) => (c === ' ' ? 0 : (glyphIndex(c) ?? question))),
        vis: label.vis ?? 1,
      });
      continue;
    }
    const { box, collision: halo, lines, width } = layout;
    const vis = label.vis ?? 1;
    const put = (x: number, y: number, glyph: number) => {
      if (labelCellShows(label.id, (y - halo.top) * halo.width + (x - halo.left), vis))
        write(overlay, x, y, glyph);
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
  return layouts.map(({ label }) => label);
}
