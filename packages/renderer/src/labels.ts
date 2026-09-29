/**
 * The overlay: labels placed on the cell grid over the map (ARCHITECTURE.md §3 step 6),
 * greedily in priority order, with collision so they never overlap. Phase 1.5 places landmark
 * and monument names; street and subdivision names join in Phase 2.
 */

/** Label priority: lower ranks are placed first. */
export const LabelRank = { landmark: 0, monument: 1 } as const;

/** Zoom from which each rank's labels show (index = rank). */
export const LABEL_MIN_ZOOM: readonly number[] = [16, 18];

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
};

export const createOverlay = (cols: number, rows: number): Overlay => ({
  cols,
  rows,
  glyphs: new Uint16Array(cols * rows),
  taken: [],
});

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
};

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
function positions(col: number, row: number, width: number, height: number): Box[] {
  const centered = col - Math.floor(width / 2);
  return [
    { left: centered, top: row + 1, width, height },
    { left: centered, top: row - height, width, height },
    { left: col + 2, top: row - Math.floor(height / 2), width, height },
    { left: col - 1 - width, top: row - Math.floor(height / 2), width, height },
  ];
}

/**
 * Place labels. Characters the atlas lacks are drawn as `?`. Each label
 * gets a one-cell halo left and right; a label whose text fits nowhere inside `area` (e.g. the
 * on-screen cells) without overlapping what is already placed is dropped.
 */
export function placeLabels(
  overlay: Overlay,
  candidates: readonly LabelCandidate[],
  glyphIndex: (char: string) => number | undefined,
  area: LabelArea = fullArea(overlay),
) {
  const sorted = [...candidates].sort((a, b) => a.rank - b.rank || a.id - b.id);
  const question = glyphIndex('?') ?? 0;

  for (const label of sorted) {
    const lines = wrapText(label.text);
    if (lines.length === 0) continue;
    const width = Math.max(...lines.map((l) => [...l].length));
    const box = positions(label.col, label.row, width, lines.length).find((b) => {
      const inside =
        b.left >= area.left &&
        b.top >= area.top &&
        b.left + b.width <= area.right &&
        b.top + b.height <= area.bottom;
      const halo = { ...b, left: b.left - 1, width: b.width + 2 };
      return inside && !overlay.taken.some((p) => overlaps(p, halo));
    });
    if (!box) continue;
    overlay.taken.push({ ...box, left: box.left - 1, width: box.width + 2 });

    lines.forEach((line, i) => {
      const y = box.top + i;
      for (let x = box.left - 1; x < box.left + box.width + 1; x++) {
        write(overlay, x, y, OVERLAY_BLANK);
      }
      const chars = [...line];
      const start = box.left + Math.floor((width - chars.length) / 2);
      chars.forEach((char, j) => {
        const glyph = char === ' ' ? OVERLAY_BLANK : (glyphIndex(char) ?? question) + 1;
        write(overlay, start + j, y, glyph);
      });
    });
  }
}
