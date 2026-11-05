/**
 * Boat wakes, in the shape a hull really leaves: a V opening from the bow at the Kelvin angle, with
 * a breaking crest along each arm, churned water straight behind the stern, and a pale slick between
 * the arms crossed by faint curved waves. Everything thins out with distance.
 *
 * Each cell gets a foam strength, written to the life texture as a `LIFE_WAKE` texel with no agent
 * bit, so it can't displace an agent. Stronger cells also carry a foam glyph; weak ones only tint
 * the water and keep its own glyph. The glyph pass draws them on water and ignores them on land
 * (shaders/glyph.ts). Purely from the visible agents: no state, no clock, no randomness, nothing
 * the simulation sees. Runs each frame, so it allocates nothing per cell.
 */
import { LIFE_WAKE, WAKE } from './config';
import { cellHash, packGlyph } from '../glyphs/select';
import type { LifeGrid } from './draw';
import type { VisibleAgent } from './simulate';
import { VEHICLES } from './vehicles';

const OPEN = Math.tan((WAKE.angle * Math.PI) / 180);
/** Deep water's wavelength, m per (m/s)²: 2π/g. */
const WAVELENGTH = (Math.PI * 2) / 9.81;
/** Foam strength in the 6 bits a wake texel has for it (shaders/glyph.ts). */
const LEVELS = 63;
/** The weakest foam speckle can lift to its weakest glyph; below it no cell needs the hash. */
const SPECKLED = WAKE.glyphs[WAKE.glyphs.length - 1]!.from - WAKE.speckle / 2;

type WakeGrid = Pick<LifeGrid, 'cols' | 'rows' | 'toCell'>;

/**
 * Visit the on-grid cells of a boat's wake with their foam strength, 0–1. Returns how many cells it
 * looked at, which `drawWakes` budgets; none without a pose or a wake.
 */
export function forEachWakeCell(
  agent: VisibleAgent,
  grid: WakeGrid,
  visit: (col: number, row: number, foam: number) => void,
): number {
  const craft = agent.vehicle;
  const wake = agent.wake;
  if (!wake || !agent.ahead || !agent.side || !craft) return 0;
  const metres = WAKE.length[craft as keyof typeof WAKE.length];
  if (!metres) return 0;
  const { cols, rows, toCell } = grid;
  const [x, y] = toCell(agent.lng, agent.lat);
  const [ax, ay] = toCell(agent.ahead[0], agent.ahead[1]);
  const [sx, sy] = toCell(agent.side[0], agent.side[1]);
  // Cells per meter along the heading and to its right: the screen's aspect is already in them.
  const alongX = ax - x,
    alongY = ay - y,
    acrossX = sx - x,
    acrossY = sy - y;
  const det = alongX * acrossY - alongY * acrossX;
  const alongCells = Math.max(Math.abs(alongX), Math.abs(alongY));
  const acrossCells = Math.max(Math.abs(acrossX), Math.abs(acrossY));
  if (det === 0 || alongCells === 0 || acrossCells === 0) return 0;
  const { length, width } = VEHICLES[craft];
  const wanted = metres * (WAKE.baseLength + (1 - WAKE.baseLength) * wake);
  const reach = Math.min(WAKE.maxCells, Math.max(WAKE.minCells, wanted * alongCells)) / alongCells;
  const total = length + reach;
  const cell = 1 / acrossCells;
  const power = 0.55 + 0.45 * wake;
  // A wake a few cells long has no room for its detail: it is a tail, so it fades later and harder,
  // and its waves are left out.
  const fine = Math.min(1, (reach * alongCells) / WAKE.fineCells);
  // Waves are as long as the boat's speed sets, but never finer than the grid can draw.
  const speed = wake * WAKE.fullSpeed;
  const crest = Math.max(WAVELENGTH * speed * speed, 3 / alongCells);
  const swell = Math.max(crest, 4 / alongCells);

  // The rows of the box around the V: its bow, and its far corners with the crest's outer edge.
  const margin = Math.max(cell, 0.4 + total * WAKE.rim) / 2;
  const farHalf = total * OPEN + margin;
  const bowY = y + (alongY * length) / 2;
  const endY = bowY - alongY * total;
  const reachY = Math.abs(acrossY) * farHalf;
  const fromRow = Math.max(0, Math.floor(Math.min(bowY, endY - reachY))),
    toRow = Math.min(rows - 1, Math.floor(Math.max(bowY, endY + reachY)));

  // This cell in meters, behind the bow and off the keel line, is linear along a row.
  const behindPerCol = -acrossY / det,
    offPerCol = -alongY / det;
  const atCol0 = 0.5 - x;
  let looked = 0;
  for (let row = fromRow; row <= toRow; row++) {
    const dy = row + 0.5 - y;
    const rowBehind = length / 2 - (atCol0 * acrossY - dy * acrossX) / det,
      rowOff = (alongX * dy - alongY * atCol0) / det;
    // Only the columns inside the V: behind the bow, before its end, and within both crests.
    const edgeLeft = rowOff - OPEN * rowBehind - margin,
      edgeLeftPerCol = offPerCol - OPEN * behindPerCol,
      edgeRight = -rowOff - OPEN * rowBehind - margin,
      edgeRightPerCol = -offPerCol - OPEN * behindPerCol;
    const fromCol = firstInside(
      firstInside(
        firstInside(firstInside(0, -rowBehind, -behindPerCol), rowBehind - total, behindPerCol),
        edgeLeft,
        edgeLeftPerCol,
      ),
      edgeRight,
      edgeRightPerCol,
    );
    const toCol = lastInside(
      lastInside(
        lastInside(
          lastInside(cols - 1, -rowBehind, -behindPerCol),
          rowBehind - total,
          behindPerCol,
        ),
        edgeLeft,
        edgeLeftPerCol,
      ),
      edgeRight,
      edgeRightPerCol,
    );
    if (toCol < fromCol) continue;
    looked += toCol - fromCol + 1;
    for (let col = fromCol; col <= toCol; col++) {
      const behind = rowBehind + behindPerCol * col;
      const off = Math.abs(rowOff + offPerCol * col);
      const fromCrest = off - behind * OPEN;
      const rim = Math.max(cell, 0.4 + behind * WAKE.rim);
      if (fromCrest > rim / 2) continue;
      const astern = behind - length;
      const left = astern > 0 ? 1 - astern / reach : 1;
      let foam = 0;
      // The crest: a sharp outer edge, a softer inner one, and beads where its waves break.
      const onCrest = fromCrest > 0 ? 1 - (fromCrest * 2) / rim : 1 + fromCrest / rim;
      if (onCrest > 0) {
        const beads = fine < 1 ? 0.86 : 0.72 + 0.28 * wave(astern / crest);
        foam = onCrest * onCrest * left * beads * power;
      }
      if (astern > 0) {
        // Churn behind the stern, gone well before the arms are.
        const churn = 1 - off / Math.max(cell * 0.75, width * 0.4 + astern * 0.05);
        if (churn > 0) {
          const tail = left * (1 - fine + fine * left * left) * (2 - fine);
          foam = Math.max(foam, Math.min(1, churn * tail * power));
        }
        // The slick between the arms, with waves curving back on circles around the bow.
        if (fromCrest <= 0 && left * (fine < 1 ? 0.14 : 0.22) > foam) {
          const ring = behind + (off * off) / (2 * behind);
          const slick = left * (fine < 1 ? 0.14 : 0.14 + 0.08 * wave(ring / swell));
          if (slick > foam) foam = slick;
        }
      }
      if (foam >= WAKE.minFoam) visit(col, row, foam);
    }
  }
  return looked;
}

/** A wave, 1 at whole numbers and -1 halfway: a triangle, which cells can't tell from a sine. */
function wave(turns: number): number {
  return 4 * Math.abs(turns - Math.floor(turns) - 0.5) - 1;
}

/** Narrow `from`, the lowest column so far, to where `value + perCol * col <= 0`. */
function firstInside(from: number, value: number, perCol: number): number {
  if (perCol < 0) return Math.max(from, Math.ceil(-value / perCol));
  return perCol === 0 && value > 0 ? Infinity : from;
}

/** Narrow `to`, the highest column so far, to where `value + perCol * col <= 0`. */
function lastInside(to: number, value: number, perCol: number): number {
  return perCol > 0 ? Math.min(to, Math.floor(-value / perCol)) : to;
}

/**
 * Write wake texels for the first `WAKE.maxPerFrame` moving boats until `WAKE.maxVisits` cells have
 * been looked at, only where nothing else is: no agent, no shadow. Call it after every agent has
 * been admitted.
 */
export function drawWakes(
  out: Uint8Array,
  grid: WakeGrid,
  agents: readonly VisibleAgent[],
  glyphIndex: (glyph: string) => number,
): void {
  const { cols, toCell } = grid;
  let low: number[] = [],
    high: number[] = [];
  // Foam's speckle belongs to the water: a fixed point's cell keeps it still when the map pans.
  let originCol = 0,
    originRow = 0;
  const write = (col: number, row: number, foam: number) => {
    const at = (row * cols + col) * 4;
    if (out[at] || out[at + 1] || out[at + 2] || out[at + 3]) return;
    let lowByte = 0,
      highByte = 0;
    if (foam >= SPECKLED) {
      const speckle = cellHash(col - originCol, row - originRow) / 0x100000000;
      const rough = foam + (speckle - 0.5) * WAKE.speckle;
      for (let i = 0; i < WAKE.glyphs.length; i++) {
        if (rough >= WAKE.glyphs[i]!.from) {
          lowByte = low[i]!;
          highByte = high[i]!;
          break;
        }
      }
    }
    out[at] = lowByte;
    out[at + 1] = highByte | Math.max(1, Math.round(foam * LEVELS));
    out[at + 3] = LIFE_WAKE;
  };
  let wakes = 0;
  let visits = 0;
  for (let i = 0; i < agents.length; i++) {
    const agent = agents[i]!;
    if (!agent.wake) continue;
    if (wakes++ >= WAKE.maxPerFrame || visits >= WAKE.maxVisits) return;
    if (!low.length) {
      const packed = WAKE.glyphs.map(({ glyph }) => packGlyph(glyphIndex(glyph), 0));
      low = packed.map((bytes) => bytes[0]);
      high = packed.map((bytes) => bytes[1]);
      const [originX, originY] = toCell(0, 0);
      originCol = Math.floor(originX);
      originRow = Math.floor(originY);
    }
    visits += forEachWakeCell(agent, grid, write);
  }
}
