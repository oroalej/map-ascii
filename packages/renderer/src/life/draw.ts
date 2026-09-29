/**
 * Agents → the life layer's texels (RGBA8 per cell: glyph index, life class id, agent kind bits,
 * and for vehicles their paint and part), which the glyph pass draws over the map
 * (shaders/glyph.ts). Pure, so it can be unit-tested.
 */
import { classId } from '../classes';
import type { Theme } from '../theme';
import { agentBit, CellBit, lifeClassFor, type AgentKind } from './config';
import type { VisibleAgent } from './simulate';
import {
  PART_GLYPHS,
  planPart,
  STAMP_MIN_CELLS,
  VehiclePart,
  VEHICLES,
  type VehicleSpec,
} from './vehicles';

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
 * A vehicle's or boat's paint (bits 0–3), part (4–6), and whether it is parked (bit 7: lamps
 * off), in the texel's last byte.
 */
export const vehicleByte = (paint: number, part: VehiclePart, parked = false) =>
  (paint & 15) | (part << 4) | (parked ? 128 : 0);

/** A person holding a candle, in the texel's last byte (the glyph shader lights it at dusk). */
export const CANDLE_BYTE = 1;

/**
 * A vehicle drawn from its plan may hang over open ground at a narrow road's edge, but never
 * over roofs or water; a boat never leaves the water (config.ts `cellBits`).
 */
const STAMP_BITS: Readonly<Partial<Record<AgentKind, number>>> = {
  vehicle: CellBit.vehicle | CellBit.person,
  boat: CellBit.boat,
};

/** At most this many cells per vehicle (a bus at the closest zoom is well under). */
const MAX_STAMP_CELLS = 20_000;

/**
 * Pack `agents` into `out` (cols × rows × 4 bytes, cleared first). A vehicle that covers fewer
 * than `STAMP_MIN_CELLS` along its length is one glyph that follows its heading on screen (the
 * first glyph across, the second up or down); a bigger one is drawn at its real size from its
 * plan. A bird's glyph follows its wing beat. Later agents win a shared cell. Returns how many
 * agents landed on the grid.
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
  const partGlyphs = Object.fromEntries(
    Object.entries(PART_GLYPHS).map(([part, glyph]) => [part, glyphIndex(glyph)]),
  ) as Record<number, number>;
  // Boats are drawn solid, so the water doesn't show through them.
  const solid = glyphIndex(PART_GLYPHS[VehiclePart.body]);
  let drawn = 0;
  for (const agent of agents) {
    const [col, row] = toCell(agent.lng, agent.lat);
    const spec = agent.vehicle ? VEHICLES[agent.vehicle] : undefined;
    if (spec && agent.ahead && agent.side) {
      const [aheadCol, aheadRow] = toCell(agent.ahead[0], agent.ahead[1]);
      const [sideCol, sideRow] = toCell(agent.side[0], agent.side[1]);
      const along: [number, number] = [aheadCol - col, aheadRow - row];
      const across: [number, number] = [sideCol - col, sideRow - row];
      if (Math.hypot(...along) * spec.length >= STAMP_MIN_CELLS) {
        const cls = classId(lifeClassFor[agent.kind]);
        const bits = STAMP_BITS[agent.kind] ?? agentBit[agent.kind];
        const stamped = stamp(out, grid, [col, row], along, across, spec, (part) => [
          agent.kind === 'boat' ? solid : partGlyphs[part]!,
          cls,
          bits,
          vehicleByte(agent.paint ?? 0, part, agent.parked),
        ]);
        if (stamped) drawn++;
        continue;
      }
    }
    const c = Math.floor(col);
    const r = Math.floor(row);
    if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
    const cls = lifeClassFor[agent.kind];
    const glyphs = spec?.mini ?? theme.styles[cls]?.glyphs;
    if (!glyphs || glyphs.length === 0) continue;
    let variant = 0;
    if (agent.kind === 'bird') {
      variant = agent.flap;
    } else if (agent.ahead) {
      const [aheadCol, aheadRow] = toCell(agent.ahead[0], agent.ahead[1]);
      const x = Math.abs((aheadCol - col) * grid.cellWidth);
      const y = Math.abs((aheadRow - row) * grid.cellHeight);
      variant = x >= y ? 0 : 1;
    }
    const index = glyphIndex(glyphs[Math.min(variant, glyphs.length - 1)]!);
    if (index <= 0 || index > 255) continue;
    const at = (r * cols + c) * 4;
    out[at] = index;
    out[at + 1] = classId(cls);
    out[at + 2] = agentBit[agent.kind];
    out[at + 3] = spec
      ? vehicleByte(agent.paint ?? 0, VehiclePart.mini, agent.parked)
      : agent.candle
        ? CANDLE_BYTE
        : 255;
    drawn++;
  }
  return drawn;
}

/**
 * Draw a vehicle from its plan: every cell whose center falls inside its footprint, which is
 * centered on `center` with `along` and `across` the screen vectors (in cells) of a meter
 * forward and a meter to the right. A tilted view's perspective is taken as even over one
 * vehicle. Returns whether any cell landed on the grid.
 */
function stamp(
  out: Uint8Array,
  grid: LifeGrid,
  center: [number, number],
  along: [number, number],
  across: [number, number],
  spec: VehicleSpec,
  texel: (part: VehiclePart) => [number, number, number, number],
): boolean {
  const { cols, rows } = grid;
  const [ax, ay] = along;
  const [sx, sy] = across;
  const det = ax * sy - ay * sx;
  if (Math.abs(det) < 1e-9) return false;
  const length = spec.length;
  // At least a cell wide, so thin vehicles don't break up into gaps.
  const width = Math.max(spec.width, 1 / Math.max(1e-9, Math.hypot(sx, sy)));
  const hl = length / 2;
  const hw = width / 2;
  const [cx, cy] = center;
  const extentX = Math.abs(ax) * hl + Math.abs(sx) * hw;
  const extentY = Math.abs(ay) * hl + Math.abs(sy) * hw;
  const c0 = Math.max(0, Math.floor(cx - extentX));
  const c1 = Math.min(cols - 1, Math.floor(cx + extentX));
  const r0 = Math.max(0, Math.floor(cy - extentY));
  const r1 = Math.min(rows - 1, Math.floor(cy + extentY));
  if (c1 < c0 || r1 < r0 || (c1 - c0 + 1) * (r1 - r0 + 1) > MAX_STAMP_CELLS) return false;
  let any = false;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      // The cell's center in meters forward and to the right of the vehicle's center.
      const px = c + 0.5 - cx;
      const py = r + 0.5 - cy;
      const forward = (px * sy - py * sx) / det;
      const right = (ax * py - ay * px) / det;
      if (Math.abs(forward) >= hl || Math.abs(right) >= hw) continue;
      const part = planPart(spec, forward / length + 0.5, right / width + 0.5);
      if (part === null) continue;
      const [glyph, cls, bits, byte] = texel(part);
      if (glyph <= 0 || glyph > 255) continue;
      const at = (r * cols + c) * 4;
      out[at] = glyph;
      out[at + 1] = cls;
      out[at + 2] = bits;
      out[at + 3] = byte;
      any = true;
    }
  }
  return any;
}
