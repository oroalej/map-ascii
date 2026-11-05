/**
 * Boat wakes: two arms trailing back from a moving boat's stern, drawn into free cells of the
 * life texture as `LIFE_WAKE` texels with no agent bit, so they can't displace an agent. The glyph
 * pass draws them on water and ignores them on land (shaders/glyph.ts). Purely from the visible
 * agents: no state, no randomness, nothing the simulation sees. Runs each frame, so it allocates
 * nothing per boat.
 */
import { LIFE_WAKE, WAKE } from './config';
import { packGlyph } from '../glyphs/select';
import type { LifeGrid } from './draw';
import type { VisibleAgent } from './simulate';
import { LINE_GLYPHS, stepGlyph, VEHICLES, type LineGlyph } from './vehicles';

const ARM_COS = Math.cos((WAKE.angle * Math.PI) / 180);
const ARM_SIN = Math.sin((WAKE.angle * Math.PI) / 180);

/** Visit the cells of a boat's two wake arms, stern first; none without a pose or a wake. */
export function forEachWakeCell(
  agent: VisibleAgent,
  toCell: LifeGrid['toCell'],
  visit: (col: number, row: number, glyph: LineGlyph) => void,
): void {
  const craft = agent.vehicle;
  if (!agent.wake || !agent.ahead || !agent.side || !craft) return;
  const metres = WAKE.length[craft as keyof typeof WAKE.length];
  if (!metres) return;
  const [x, y] = toCell(agent.lng, agent.lat);
  const [ax, ay] = toCell(agent.ahead[0], agent.ahead[1]);
  const [sx, sy] = toCell(agent.side[0], agent.side[1]);
  // Cells per meter along the heading and to its right: the screen's aspect is already in them.
  const alongX = ax - x,
    alongY = ay - y,
    acrossX = sx - x,
    acrossY = sy - y;
  const half = VEHICLES[craft].length / 2;
  const sternX = x - alongX * half,
    sternY = y - alongY * half;
  const reach = metres * (WAKE.baseLength + (1 - WAKE.baseLength) * agent.wake);
  for (let side = -1; side <= 1; side += 2) {
    const dx = -ARM_COS * alongX + side * ARM_SIN * acrossX;
    const dy = -ARM_COS * alongY + side * ARM_SIN * acrossY;
    const perMeter = Math.max(Math.abs(dx), Math.abs(dy));
    if (perMeter === 0) continue;
    const cells = Math.min(WAKE.maxCells, Math.max(WAKE.minCells, reach * perMeter));
    const steps = Math.ceil(cells);
    const stepX = ((dx / perMeter) * cells) / steps,
      stepY = ((dy / perMeter) * cells) / steps;
    let col = Math.floor(sternX),
      row = Math.floor(sternY);
    for (let k = 1; k <= steps; k++) {
      const c = Math.floor(sternX + stepX * k),
        r = Math.floor(sternY + stepY * k);
      if (c === col && r === row) continue;
      // The step from the cell before it, so an arm reads as a line leaving its stern.
      visit(c, r, stepGlyph(c - col, r - row));
      col = c;
      row = r;
    }
  }
}

/**
 * Write wake texels for the first `WAKE.maxPerFrame` moving boats, only where nothing else is:
 * no agent, no shadow. Call it after every agent has been admitted.
 */
export function drawWakes(
  out: Uint8Array,
  grid: Pick<LifeGrid, 'cols' | 'rows' | 'toCell'>,
  agents: readonly VisibleAgent[],
  glyphIndex: (glyph: string) => number,
): void {
  const { cols, rows, toCell } = grid;
  let across = -1,
    upDown = -1,
    rising = -1,
    falling = -1;
  const write = (col: number, row: number, glyph: LineGlyph) => {
    if (col < 0 || row < 0 || col >= cols || row >= rows) return;
    const at = (row * cols + col) * 4;
    if (out[at] || out[at + 1] || out[at + 2] || out[at + 3]) return;
    const index =
      glyph === LINE_GLYPHS.across
        ? across
        : glyph === LINE_GLYPHS.upDown
          ? upDown
          : glyph === LINE_GLYPHS.rising
            ? rising
            : falling;
    if (index <= 0) return;
    [out[at], out[at + 1]] = packGlyph(index, 0);
    out[at + 3] = LIFE_WAKE;
  };
  let wakes = 0;
  for (let i = 0; i < agents.length; i++) {
    const agent = agents[i]!;
    if (!agent.wake) continue;
    if (wakes++ >= WAKE.maxPerFrame) return;
    if (across < 0) {
      across = glyphIndex(LINE_GLYPHS.across);
      upDown = glyphIndex(LINE_GLYPHS.upDown);
      rising = glyphIndex(LINE_GLYPHS.rising);
      falling = glyphIndex(LINE_GLYPHS.falling);
    }
    forEachWakeCell(agent, toCell, write);
  }
}
