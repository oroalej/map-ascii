/**
 * The glyph atlas: every glyph a theme uses, rasterized once at the device-pixel cell size into
 * a single-channel coverage texture. Box-drawing and block characters are drawn as shapes so
 * lines join exactly across cells whatever the font's metrics; everything else uses the font.
 */

export const DEFAULT_FONT =
  "ui-monospace, 'Cascadia Mono', 'SFMono-Regular', Menlo, Consolas, monospace";

/** Arm weights [N, E, S, W]: 0 none, 1 single line, 2 double line. */
type Arms = readonly [number, number, number, number];

// prettier-ignore
const boxArms: Record<string, Arms> = {
  '─': [0, 1, 0, 1], '│': [1, 0, 1, 0], '┌': [0, 1, 1, 0], '┐': [0, 0, 1, 1],
  '└': [1, 1, 0, 0], '┘': [1, 0, 0, 1], '├': [1, 1, 1, 0], '┤': [1, 0, 1, 1],
  '┬': [0, 1, 1, 1], '┴': [1, 1, 0, 1], '┼': [1, 1, 1, 1],
  // Rounded corners (landmark art) are drawn square, so they join the lines around them.
  '╭': [0, 1, 1, 0], '╮': [0, 0, 1, 1], '╰': [1, 1, 0, 0], '╯': [1, 0, 0, 1],
  '═': [0, 2, 0, 2], '║': [2, 0, 2, 0], '╔': [0, 2, 2, 0], '╗': [0, 0, 2, 2],
  '╚': [2, 2, 0, 0], '╝': [2, 0, 0, 2], '╠': [2, 2, 2, 0], '╣': [2, 0, 2, 2],
  '╦': [0, 2, 2, 2], '╩': [2, 2, 0, 2], '╬': [2, 2, 2, 2],
};

/** Coverage bitmap for one glyph slot inside a larger buffer. */
type Slot = { data: Uint8Array; stride: number; x0: number; y0: number; w: number; h: number };

function fill(slot: Slot, x0: number, y0: number, x1: number, y1: number) {
  const { data, stride, w, h } = slot;
  for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) {
      data[(slot.y0 + y) * stride + slot.x0 + x] = 255;
    }
  }
}

function drawBox(slot: Slot, [n, e, s, w]: Arms) {
  const { w: cw, h: ch } = slot;
  const t = Math.max(1, Math.floor(cw / 8));
  const cx = Math.floor(cw / 2) - Math.floor(t / 2);
  const cy = Math.floor(ch / 2) - Math.floor(t / 2);
  if (Math.max(n, e, s, w) === 1) {
    if (n) fill(slot, cx, 0, cx + t, cy + t);
    if (s) fill(slot, cx, cy, cx + t, ch);
    if (e) fill(slot, cx, cy, cw, cy + t);
    if (w) fill(slot, 0, cy, cx + t, cy + t);
    return;
  }
  // Double lines: each arm is two parallel strokes. Where an arm turns into a neighboring arm,
  // the stroke on that side stops at the inner line so corners and junctions join cleanly.
  const d = Math.max(t + 1, Math.round(cw * 0.18));
  const [xl, xr, yt, yb] = [cx - d, cx + d, cy - d, cy + d];
  if (n) {
    fill(slot, xl, 0, xl + t, (w ? yt : yb) + t);
    fill(slot, xr, 0, xr + t, (e ? yt : yb) + t);
  }
  if (s) {
    fill(slot, xl, w ? yb : yt, xl + t, ch);
    fill(slot, xr, e ? yb : yt, xr + t, ch);
  }
  if (e) {
    fill(slot, n ? xr : xl, yt, cw, yt + t);
    fill(slot, s ? xr : xl, yb, cw, yb + t);
  }
  if (w) {
    fill(slot, 0, yt, (n ? xl : xr) + t, yt + t);
    fill(slot, 0, yb, (s ? xl : xr) + t, yb + t);
  }
}

/** Dashed lines by number of dashes per cell: `┄ ┆` (fences) and `╌ ╎` (city boundary). */
const dashes: Record<string, { vertical: boolean; count: number }> = {
  '┄': { vertical: false, count: 3 },
  '┆': { vertical: true, count: 3 },
  '╌': { vertical: false, count: 2 },
  '╎': { vertical: true, count: 2 },
};

/**
 * A dashed line through the cell's middle, on the same axis as `─`/`│`. Each dash is centered
 * in its share of the cell, so dashes keep an even rhythm across neighboring cells.
 */
function drawDashes(slot: Slot, { vertical, count }: { vertical: boolean; count: number }) {
  const { w, h } = slot;
  const t = Math.max(1, Math.floor(w / 8));
  const cx = Math.floor(w / 2) - Math.floor(t / 2);
  const cy = Math.floor(h / 2) - Math.floor(t / 2);
  const length = vertical ? h : w;
  const share = length / count;
  for (let i = 0; i < count; i++) {
    const a = Math.round(i * share + share * 0.2);
    const b = Math.round((i + 1) * share - share * 0.2);
    if (vertical) fill(slot, cx, a, cx + t, b);
    else fill(slot, a, cy, b, cy + t);
  }
}

/** Corner-to-corner diagonal, so steps join their diagonal neighbors. */
function drawDiagonal(slot: Slot, rising: boolean) {
  const { w, h } = slot;
  const t = Math.max(1, Math.floor(w / 8));
  for (let y = 0; y < h; y++) {
    const along = (y + 0.5) / h; // 0 at the top
    const x = Math.round((rising ? 1 - along : along) * w - t / 2);
    fill(slot, x, y, x + t, y + 1);
  }
}

/** A small square outline centered in the cell: a building that fits in one cell. */
function drawSquare(slot: Slot) {
  const { w, h } = slot;
  const t = Math.max(1, Math.floor(w / 8));
  const size = Math.max(3, Math.round(w * 0.7));
  const x0 = Math.floor((w - size) / 2);
  const y0 = Math.floor((h - size) / 2);
  fill(slot, x0, y0, x0 + size, y0 + t);
  fill(slot, x0, y0 + size - t, x0 + size, y0 + size);
  fill(slot, x0, y0, x0 + t, y0 + size);
  fill(slot, x0 + size - t, y0, x0 + size, y0 + size);
}

/** Coverage of the shade blocks (0–255). */
export const shadeCoverage: Readonly<Record<string, number>> = { '░': 80, '▒': 130, '▓': 185 };

/**
 * Block glyphs. Shades are flat fills at partial coverage, with a one-pixel gap on the right and
 * bottom so shaded areas still read as a grid of characters; `█` fills the whole cell.
 */
function drawBlock(slot: Slot, glyph: string) {
  const { data, stride, w, h } = slot;
  const shade = shadeCoverage[glyph];
  const gap = shade !== undefined && w > 4 ? 1 : 0;
  const bottom = glyph === '▀' ? Math.ceil(h / 2) : h - gap;
  const value = shade ?? 255;
  for (let y = 0; y < bottom; y++) {
    for (let x = 0; x < w - gap; x++) data[(slot.y0 + y) * stride + slot.x0 + x] = value;
  }
}

/** Draw a glyph as shapes into `slot` if it is a box-drawing or block character. */
export function drawProcedural(slot: Slot, glyph: string): boolean {
  const arms = boxArms[glyph];
  if (arms) drawBox(slot, arms);
  else if (dashes[glyph]) drawDashes(slot, dashes[glyph]);
  else if (glyph === '╱' || glyph === '╲') drawDiagonal(slot, glyph === '╱');
  else if (glyph === '□') drawSquare(slot);
  else if ('█▓▒░▀'.includes(glyph)) drawBlock(slot, glyph);
  else return false;
  return true;
}

export type GlyphAtlas = {
  /** R8 coverage, `width × height`. */
  data: Uint8Array;
  width: number;
  height: number;
  /** Glyph slots per atlas row. */
  columns: number;
  /** Atlas index of a glyph; index 0 is blank. */
  index: (glyph: string) => number;
};

const ATLAS_COLUMNS = 16;

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function context2d(width: number, height: number): Context2D {
  const canvas =
    typeof OffscreenCanvas === 'undefined'
      ? Object.assign(document.createElement('canvas'), { width, height })
      : new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as Context2D | null;
  if (!ctx) throw new Error('ASCII Atlas could not create a 2D canvas for its glyph atlas.');
  return ctx;
}

/** Rasterize `glyphs` into an atlas of `cellWidth × cellHeight` device-pixel slots. */
export function buildGlyphAtlas(
  glyphs: readonly string[],
  cellWidth: number,
  cellHeight: number,
  font = DEFAULT_FONT,
): GlyphAtlas {
  const all = [' ', ...glyphs.filter((g) => g !== ' ')];
  // The overlay stores glyph index + 1 in 16 bits.
  if (all.length >= 0xffff) throw new Error(`too many glyphs for the atlas: ${all.length}`);
  const indices = new Map(all.map((g, i) => [g, i]));
  const rows = Math.ceil(all.length / ATLAS_COLUMNS);
  const width = ATLAS_COLUMNS * cellWidth;
  const height = rows * cellHeight;

  const ctx = context2d(width, height);
  const size = Math.floor(Math.min(cellHeight * 0.8, cellWidth / 0.6));
  ctx.font = `${size}px ${font}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff';
  const data = new Uint8Array(width * height);
  all.forEach((glyph, i) => {
    const x0 = (i % ATLAS_COLUMNS) * cellWidth;
    const y0 = Math.floor(i / ATLAS_COLUMNS) * cellHeight;
    const slot = { data, stride: width, x0, y0, w: cellWidth, h: cellHeight };
    if (!drawProcedural(slot, glyph) && glyph !== ' ')
      ctx.fillText(glyph, x0 + cellWidth / 2, y0 + cellHeight / 2 + 1);
  });

  // Merge the font-drawn glyphs (alpha channel) under the procedural ones.
  const pixels = ctx.getImageData(0, 0, width, height).data;
  for (let i = 0; i < data.length; i++) data[i] = Math.max(data[i]!, pixels[i * 4 + 3]!);

  return { data, width, height, columns: ATLAS_COLUMNS, index: (g) => indices.get(g) ?? 0 };
}
