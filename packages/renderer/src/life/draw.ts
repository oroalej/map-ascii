/**
 * Agents → the life layer's texels (RGBA8 per cell: glyph index, life class id, agent kind bits,
 * and for vehicles their paint and part, for people their paint, part, and candle), which the
 * glyph pass draws over the map (shaders/glyph.ts). Pure, so it can be unit-tested.
 */
import { classId } from '../classes';
import { sextantGlyphs, type Theme } from '../theme';
import { agentBit, CellBit, lifeClassFor, type AgentKind } from './config';
import {
  FIGURE_SIZE_M,
  figureFit,
  figureGlyph,
  figureInk,
  PAINT_NONE,
  PersonPart,
  personByte,
  type PersonLook,
} from './people';
import type { LifeLineShape, VisibleAgent } from './simulate';
import {
  LINE_GLYPHS,
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

/**
 * A vehicle drawn from its plan may hang over open ground at a narrow road's edge, but never
 * over roofs or water; a boat never leaves the water (config.ts `cellBits`).
 */
const STAMP_BITS: Readonly<Partial<Record<AgentKind, number>>> = {
  vehicle: CellBit.vehicle | CellBit.person,
  boat: CellBit.boat,
  // A train is wider than its 1-cell track: it may cover the open ground beside it.
  train: CellBit.train | CellBit.person,
};

/** At most this many cells per vehicle (a bus at the closest zoom is well under). */
const MAX_STAMP_CELLS = 20_000;

/**
 * Pack `agents` into `out` (cols × rows × 4 bytes, cleared first). A vehicle that covers fewer
 * than `STAMP_MIN_CELLS` along its length is one glyph that follows its heading on screen (the
 * first glyph across, the second up or down); a bigger one is drawn at its real size from its
 * plan. People are figures (`drawPeople`); a vendor's cart is drawn like a vehicle, but stands
 * only where people may. A bird's glyph follows its wing beat. Later agents win a shared cell.
 * Returns how many agents (each person in a group) landed on the grid.
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
    if (agent.line) {
      if (drawLine(out, grid, agent.line, glyphIndex)) drawn++;
      continue;
    }
    const [col, row] = toCell(agent.lng, agent.lat);
    const spec = agent.vehicle ? VEHICLES[agent.vehicle] : undefined;
    if (agent.kind === 'person' && !spec) {
      drawn += drawPeople(out, grid, agent, [col, row], glyphIndex);
      continue;
    }
    // A vendor's cart is painted as a vehicle.
    const cls = spec && agent.kind === 'person' ? 'life_vehicle' : lifeClassFor[agent.kind];
    if (spec && agent.ahead && agent.side) {
      const [aheadCol, aheadRow] = toCell(agent.ahead[0], agent.ahead[1]);
      const [sideCol, sideRow] = toCell(agent.side[0], agent.side[1]);
      const along: [number, number] = [aheadCol - col, aheadRow - row];
      const across: [number, number] = [sideCol - col, sideRow - row];
      if (Math.hypot(...along) * spec.length >= STAMP_MIN_CELLS) {
        const bits = STAMP_BITS[agent.kind] ?? agentBit[agent.kind];
        const stamped = stamp(out, grid, [col, row], along, across, spec, (part) => [
          agent.kind === 'boat' ? solid : partGlyphs[part]!,
          classId(cls),
          bits,
          vehicleByte(agent.paint ?? 0, part, agent.parked),
        ]);
        if (stamped) drawn++;
        // The vendor stands clear of the cart's side.
        if (agent.people) {
          drawn += drawPeople(out, grid, agent, [col, row], glyphIndex, spec.width / 2);
        }
        continue;
      }
    }
    if (agent.people) drawn += drawPeople(out, grid, agent, [col, row], glyphIndex);
    const c = Math.floor(col);
    const r = Math.floor(row);
    if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
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
    out[at + 3] = spec ? vehicleByte(agent.paint ?? 0, VehiclePart.mini, agent.parked) : 255;
    drawn++;
  }
  return drawn;
}

/**
 * Draw a person, a group walking together, or a vendor beside their cart (`clearance`: the
 * cart's half-width, m, which the vendor stands beyond; 0 for a one-glyph cart, which the vendor
 * stands in the next cell from). Each is a figure (life/people.ts) turned with the heading on
 * screen and stepping with `flap`, at its real size like a vehicle (`figureFit`): part of a cell
 * or a whole one, 2×2 cells, or stamped over as many as it covers (`stampFigure`). The members
 * of a group stand in slots beside (`lateral`, to the right) and behind (`back`) the first: a
 * slot's width apart on the grid (2 cells once any of them covers 2×2; the others then take the
 * cell of their slot nearest the first), or once any is stamped, the widest one's width apart.
 * Without `people`, the agent is one adult. Returns how many figures landed on the grid.
 */
function drawPeople(
  out: Uint8Array,
  grid: LifeGrid,
  agent: VisibleAgent,
  [col, row]: [number, number],
  glyphIndex: (glyph: string) => number,
  clearance = 0,
): number {
  const { cols, rows, toCell, cellWidth, cellHeight } = grid;
  const looks: readonly PersonLook[] = agent.people ?? [
    { figure: 'adult', paint: agent.paint ?? PAINT_NONE, lateral: 0, back: 0, flap: agent.flap },
  ];
  // The heading on the grid, snapped to its axis on screen (up, if it has none); a meter
  // forward and a meter to the right, in cells; and how big each figure is on screen (a whole
  // cell, without a heading).
  let [fx, fy] = [0, -1];
  let along: [number, number] = [0, 0];
  let right: [number, number] = [0, 0];
  let fits = looks.map(() => figureFit('adult', 1));
  if (agent.ahead) {
    const [aheadCol, aheadRow] = toCell(agent.ahead[0], agent.ahead[1]);
    along = [aheadCol - col, aheadRow - row];
    const x = along[0] * cellWidth;
    const y = along[1] * cellHeight;
    [fx, fy] = Math.abs(x) >= Math.abs(y) ? [Math.sign(x) || 1, 0] : [0, Math.sign(y)];
    // Its own point to the right (a cart's), else a quarter turn clockwise on screen, in pixels
    // (rows run down the screen).
    if (agent.side) {
      const [sideCol, sideRow] = toCell(agent.side[0], agent.side[1]);
      right = [sideCol - col, sideRow - row];
    } else {
      right = [-y / cellWidth, x / cellHeight];
    }
    const cellsPerMeter = Math.hypot(x, y) / cellWidth;
    fits = looks.map((look) => figureFit(look.figure, FIGURE_SIZE_M[look.figure] * cellsPerMeter));
  }
  const across = fx !== 0;
  const cls = classId(lifeClassFor.person);
  // People in a boat stand over the water; others where people may.
  const bits = agent.aboard ? CellBit.boat : CellBit.person;
  const stroke = agent.stroke ?? 0;
  // A paddler's glyphs head up or right; turned half round, they are the other side's paddler at
  // the other end of the stroke (life/people.ts `ROWER`).
  const turned = fx < 0 || fy > 0;
  const byteOf = (look: PersonLook, tone = false) => {
    const umbrella = look.figure === 'umbrella';
    const part = tone
      ? umbrella
        ? PersonPart.rib
        : PersonPart.skin
      : umbrella
        ? PersonPart.canopy
        : PersonPart.figure;
    return personByte(look.paint, part, agent.candle);
  };
  const put = (c: number, r: number, glyph: string, byte: number) => {
    const index = glyphIndex(glyph);
    if (c < 0 || r < 0 || c >= cols || r >= rows || index <= 0 || index > 255) return false;
    const at = (r * cols + c) * 4;
    out[at] = index;
    out[at + 1] = cls;
    out[at + 2] = bits;
    out[at + 3] = byte;
    return true;
  };
  /** A 2×2 figure with its top left cell at (`c`, `r`). */
  const putBig = (look: PersonLook, c: number, r: number) => {
    const swap = look.figure === 'rower' && turned ? 1 : 0;
    const frame = ((look.flap === 1 ? 1 : 0) ^ swap) as 0 | 1;
    const pull = (stroke ^ swap) as 0 | 1;
    let any = false;
    for (const slice of [0, 1, 2, 3] as const) {
      const glyph = figureGlyph(look.figure, across, frame, { slice }, pull);
      if (put(c + (slice & 1), r + (slice >> 1), glyph, byteOf(look))) any = true;
    }
    return any;
  };
  let drawn = 0;

  if (fits.includes('stamp')) {
    // Laid out in meters, around the agent's own point.
    const spacing = Math.max(...looks.map((look) => FIGURE_SIZE_M[look.figure]));
    looks.forEach((look, i) => {
      const beside =
        clearance > 0 && look.lateral !== 0
          ? Math.sign(look.lateral) * (clearance + FIGURE_SIZE_M[look.figure] / 2 + 0.1)
          : look.lateral * spacing;
      const back = look.back * spacing;
      const cx = col + right[0] * beside - along[0] * back;
      const cy = row + right[1] * beside - along[1] * back;
      const fit = fits[i]!;
      const frame = look.flap === 1 ? 1 : 0;
      let any: boolean;
      if (fit === 'stamp') {
        any = stampFigure(out, grid, [cx, cy], along, right, look, stroke, glyphIndex, (tone) => [
          cls,
          bits,
          byteOf(look, tone),
        ]);
      } else if (fit === 'big') {
        any = putBig(look, Math.round(cx) - 1, Math.round(cy) - 1);
      } else {
        const glyph = figureGlyph(look.figure, across, frame, { scale: fit });
        any = put(Math.floor(cx), Math.floor(cy), glyph, byteOf(look));
      }
      if (any) drawn++;
    });
    return drawn;
  }

  // Laid out on the grid, a slot's width apart.
  const [rx, ry] = [-fy, fx];
  const size = fits.includes('big') ? 2 : 1;
  const [c0, r0] =
    size === 2 ? [Math.round(col) - 1, Math.round(row) - 1] : [Math.floor(col), Math.floor(row)];
  // The cart's half-width in cells, across its heading.
  const clear = clearance * Math.hypot(...right);
  looks.forEach((look, i) => {
    const lateral =
      clearance > 0 && look.lateral !== 0
        ? Math.sign(look.lateral) * Math.max(size, Math.ceil(clear + size / 2))
        : look.lateral * size;
    const back = look.back * size;
    const c = c0 + rx * lateral - fx * back;
    const r = r0 + ry * lateral - fy * back;
    const fit = fits[i]!;
    let any: boolean;
    if (fit === 'big') {
      any = putBig(look, c, r);
    } else {
      const glyph = figureGlyph(look.figure, across, look.flap === 1 ? 1 : 0, {
        scale: fit === 'stamp' ? 2 : fit,
      });
      // In a 2×2 slot: its cell nearest the first of the group.
      const [dc, dr] = size === 2 ? [c0 < c ? 0 : 1, r0 < r ? 0 : 1] : [0, 0];
      any = put(c + dc, r + dr, glyph, byteOf(look));
    }
    if (any) drawn++;
  });
  return drawn;
}

/**
 * Stamp a figure at its real size (life/people.ts `FIGURE_SIZE_M`), like a vehicle from its plan
 * (`stamp`), centered on `center` with `along` and `right` the screen vectors (in cells) of a
 * meter forward and a meter to the right. Each cell it covers shows the sixths of it the figure
 * inks (a sextant glyph), in the ink most of them show: paint, or tone (skin, a canopy’s ribs).
 * Returns whether any cell landed on the grid.
 */
function stampFigure(
  out: Uint8Array,
  grid: LifeGrid,
  [cx, cy]: [number, number],
  [ax, ay]: [number, number],
  [sx, sy]: [number, number],
  look: PersonLook,
  stroke: 0 | 1,
  glyphIndex: (glyph: string) => number,
  texel: (tone: boolean) => [number, number, number],
): boolean {
  const { cols, rows } = grid;
  const det = ax * sy - ay * sx;
  if (Math.abs(det) < 1e-9) return false;
  const half = FIGURE_SIZE_M[look.figure] / 2;
  const c0 = Math.max(0, Math.floor(cx - (Math.abs(ax) + Math.abs(sx)) * half));
  const c1 = Math.min(cols - 1, Math.floor(cx + (Math.abs(ax) + Math.abs(sx)) * half));
  const r0 = Math.max(0, Math.floor(cy - (Math.abs(ay) + Math.abs(sy)) * half));
  const r1 = Math.min(rows - 1, Math.floor(cy + (Math.abs(ay) + Math.abs(sy)) * half));
  if (c1 < c0 || r1 < r0 || (c1 - c0 + 1) * (r1 - r0 + 1) > MAX_STAMP_CELLS) return false;
  const frame = look.flap === 1 ? 1 : 0;
  // How many sixths (2 across a cell, 3 down it) the figure spans, the fewer way.
  const detail = 2 * half * Math.min(Math.hypot(2 * ax, 3 * ay), Math.hypot(2 * sx, 3 * sy));
  let any = false;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      let mask = 0;
      let inked = 0;
      let tone = 0;
      for (let bit = 0; bit < 6; bit++) {
        // The sixth's center, in meters forward and to the right of the figure's center.
        const px = c + ((bit & 1) + 0.5) / 2 - cx;
        const py = r + ((bit >> 1) + 0.5) / 3 - cy;
        const forward = (px * sy - py * sx) / det;
        const side = (ax * py - ay * px) / det;
        if (Math.abs(forward) >= half || Math.abs(side) >= half) continue;
        const u = forward / half / 2 + 0.5;
        const ink = figureInk(look.figure, frame, u, side / half / 2 + 0.5, detail, stroke);
        if (ink === '.') continue;
        mask |= 1 << bit;
        inked++;
        if (ink === 'o') tone++;
      }
      if (mask === 0) continue;
      // A canopy's thin ribs show in a cell where they are a third of its ink.
      const [cls, bits, byte] = texel(tone * (look.figure === 'umbrella' ? 3 : 2) > inked);
      const index = glyphIndex(sextantGlyphs[mask]!);
      if (index <= 0 || index > 255) continue;
      const at = (r * cols + c) * 4;
      out[at] = index;
      out[at + 1] = cls;
      out[at + 2] = bits;
      out[at + 3] = byte;
      any = true;
    }
  }
  return any;
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

/**
 * Draw a line (a rope or a pole) over the water, one cell thick: one cell per step along its
 * longer axis on the grid. A cell takes `─` or `│` where the line runs straight on to the next
 * cell, and `╱` or `╲` where it steps across a row and a column at once, so a slanted line reads
 * as a staircase rather than a band. Cells are painted in turn from its `paints`, and its tip
 * glyph goes in the last cell. A line shorter than a cell on screen isn't drawn. Returns
 * whether any cell landed on the grid.
 */
function drawLine(
  out: Uint8Array,
  grid: LifeGrid,
  line: LifeLineShape,
  glyphIndex: (glyph: string) => number,
): boolean {
  const { cols, rows, toCell } = grid;
  const points = line.points.map(([lng, lat]) => toCell(lng, lat));
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]);
  }
  if (total < 1) return false;
  // The cells it passes through, one per step along each stretch's longer axis.
  const path: [number, number][] = [];
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1]!;
    const [bx, by] = points[i]!;
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(by - ay))));
    for (let k = i === 1 ? 0 : 1; k <= steps; k++) {
      const cell: [number, number] = [
        Math.floor(ax + ((bx - ax) * k) / steps),
        Math.floor(ay + ((by - ay) * k) / steps),
      ];
      const last = path.at(-1);
      if (!last || last[0] !== cell[0] || last[1] !== cell[1]) path.push(cell);
    }
  }
  const cls = classId(lifeClassFor.boat);
  const seen = new Set<number>();
  const marks: { at: number; glyph: number }[] = [];
  path.forEach(([c, r], k) => {
    if (c < 0 || r < 0 || c >= cols || r >= rows) return;
    const at = (r * cols + c) * 4;
    if (seen.has(at)) return;
    seen.add(at);
    // The step on to the next cell (from the one before, at the end); rows count down.
    const [nc, nr] = path[k + 1] ?? [2 * c - path[k - 1]![0], 2 * r - path[k - 1]![1]];
    const [dc, dr] = [nc - c, nr - r];
    const glyph =
      dr === 0
        ? LINE_GLYPHS.across
        : dc === 0
          ? LINE_GLYPHS.upDown
          : dc * dr < 0
            ? LINE_GLYPHS.rising
            : LINE_GLYPHS.falling;
    marks.push({ at, glyph: glyphIndex(glyph) });
  });
  marks.forEach(({ at, glyph }, k) => {
    const tip = line.tip && k === marks.length - 1 ? line.tip : undefined;
    const index = tip ? glyphIndex(tip.glyph) : glyph;
    if (index <= 0 || index > 255) return;
    out[at] = index;
    out[at + 1] = cls;
    out[at + 2] = CellBit.boat;
    out[at + 3] = vehicleByte(tip?.paint ?? line.paints[k % line.paints.length]!, VehiclePart.body);
  });
  return marks.length > 0;
}
