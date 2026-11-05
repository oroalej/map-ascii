/**
 * Boat wakes: two arms trailing back from a moving boat's stern, drawn into free cells of the
 * life texture as `LIFE_WAKE` texels with no agent bit, so they can't displace an agent. The glyph
 * pass draws them on water and ignores them on land (shaders/glyph.ts). Purely from the visible
 * agents: no state, no randomness, nothing the simulation sees.
 */
import { LIFE_WAKE, WAKE } from './config';
import { packGlyph } from '../glyphs/select';
import type { LifeGrid } from './draw';
import type { VisibleAgent } from './simulate';
import { stepGlyph, VEHICLES, type LineGlyph } from './vehicles';

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
  const [ax, ay] = toCell(...agent.ahead);
  const [sx, sy] = toCell(...agent.side);
  // Cells per meter along the heading and to its right: the screen's aspect is already in them.
  const along = [ax - x, ay - y] as const;
  const across = [sx - x, sy - y] as const;
  const half = VEHICLES[craft].length / 2;
  const stern = [x - along[0] * half, y - along[1] * half] as const;
  const reach = metres * (WAKE.baseLength + (1 - WAKE.baseLength) * agent.wake);
  for (const side of [-1, 1]) {
    const dx = -ARM_COS * along[0] + side * ARM_SIN * across[0];
    const dy = -ARM_COS * along[1] + side * ARM_SIN * across[1];
    const perMeter = Math.max(Math.abs(dx), Math.abs(dy));
    if (perMeter === 0) continue;
    const cells = Math.min(WAKE.maxCells, Math.max(WAKE.minCells, reach * perMeter));
    const steps = Math.ceil(cells);
    const path: [number, number][] = [[Math.floor(stern[0]), Math.floor(stern[1])]];
    for (let k = 1; k <= steps; k++) {
      const c = Math.floor(stern[0] + (dx / perMeter) * ((cells * k) / steps));
      const r = Math.floor(stern[1] + (dy / perMeter) * ((cells * k) / steps));
      const last = path.at(-1)!;
      if (last[0] !== c || last[1] !== r) path.push([c, r]);
    }
    for (let k = 1; k < path.length; k++) {
      const [c, r] = path[k]!;
      const [pc, pr] = path[k - 1]!;
      // The step from the cell before it, so an arm reads as a line leaving its stern.
      visit(c, r, stepGlyph(c - pc, r - pr));
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
  let wakes = 0;
  for (const agent of agents) {
    if (!agent.wake) continue;
    if (wakes++ >= WAKE.maxPerFrame) return;
    forEachWakeCell(agent, toCell, (col, row, glyph) => {
      if (col < 0 || row < 0 || col >= cols || row >= rows) return;
      const at = (row * cols + col) * 4;
      if (out[at] || out[at + 1] || out[at + 2] || out[at + 3]) return;
      const index = glyphIndex(glyph);
      if (index <= 0) return;
      [out[at], out[at + 1]] = packGlyph(index, 0);
      out[at + 3] = LIFE_WAKE;
    });
  }
}
