/**
 * Agents → the life layer's texels (RGBA8 per cell: glyph index, life class id, agent kind bit),
 * which the glyph pass draws over the map (shaders/glyph.ts). Pure, so it can be unit-tested.
 */
import { classId } from '../classes';
import type { Theme } from '../theme';
import { agentBit, lifeClassFor } from './config';
import type { VisibleAgent } from './simulate';

export type LifeGrid = {
  cols: number;
  rows: number;
  /** Cell size in device pixels, for the heading's direction on screen. */
  cellWidth: number;
  cellHeight: number;
  /** A point's position on the grid, in fractional cells (passes.ts `GridPlacement.toCell`). */
  toCell: (lng: number, lat: number) => [number, number];
};

/**
 * Pack `agents` into `out` (cols × rows × 4 bytes, cleared first). A vehicle's glyph follows its
 * heading on screen (the style's first glyph across, the second up or down), a bird's its wing
 * beat. Later agents win a shared cell. Returns how many agents landed on the grid.
 */
export function packLife(
  out: Uint8Array,
  grid: LifeGrid,
  agents: readonly VisibleAgent[],
  theme: Theme,
  glyphIndex: (glyph: string) => number,
): number {
  out.fill(0);
  const { cols, rows, toCell } = grid;
  let drawn = 0;
  for (const agent of agents) {
    const [col, row] = toCell(agent.lng, agent.lat);
    const c = Math.floor(col);
    const r = Math.floor(row);
    if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
    const cls = lifeClassFor[agent.kind];
    const glyphs = theme.styles[cls]?.glyphs;
    if (!glyphs || glyphs.length === 0) continue;
    let variant = 0;
    if (agent.kind === 'bird') {
      variant = agent.flap;
    } else if (agent.ahead) {
      const [aheadCol, aheadRow] = toCell(agent.ahead[0], agent.ahead[1]);
      const across = Math.abs((aheadCol - col) * grid.cellWidth);
      const down = Math.abs((aheadRow - row) * grid.cellHeight);
      variant = across >= down ? 0 : 1;
    }
    const index = glyphIndex(glyphs[Math.min(variant, glyphs.length - 1)]!);
    if (index <= 0 || index > 255) continue;
    const at = (r * cols + c) * 4;
    out[at] = index;
    out[at + 1] = classId(cls);
    out[at + 2] = agentBit[agent.kind];
    out[at + 3] = 255;
    drawn++;
  }
  return drawn;
}
