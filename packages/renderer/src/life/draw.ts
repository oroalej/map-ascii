/**
 * Agents → the life layer's texels (RGBA8 per cell: low glyph byte, packed glyph/class byte, agent kind bits,
 * and for vehicles their paint and part, for people their paint, part, and candle), which the
 * glyph pass draws over the map (shaders/glyph.ts). Pure, so it can be unit-tested.
 */
import { classId } from '../classes';
import { PackingOutcome } from './diagnostics';
import { LIFE_FOCUS_BIT, lifeFocusOf, type LifeFocus } from '../focus';
import { MAX_GLYPHS, packGlyph } from '../glyphs/select';
import { drawProcedural, sextantSplits } from '../glyphs/atlas';
import { sextantGlyphs, type Theme } from '../theme';
import { birdByte, birdFit, birdGlyph, birdInk, BirdPose, BIRD_SPECIES } from './birds';
import {
  agentBit,
  BIRD_SHADOW,
  CellBit,
  EVENT_PERSON_BITS,
  LIFE_SHADOW,
  lifeClassFor,
  isWalker,
  UMBRELLA_MOTION,
  type AgentKind,
} from './config';
import { DOG_LENGTH_M, dogFit, dogGlyph, dogInk } from './dogs';
import { CAT_LENGTH_M, catGlyph, catInk } from './cats';
import { headingOf, type Heading } from './masters';
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
import type { Sun } from './sun';
import { hasTurnSignals, TURN_SIGNAL_BIT, type TurnSide } from './turn-signals';
import { BEACON_BIT, type Beacon } from './emergency';
import { BRAKE_LAMP } from './lamps';
import { puffGlyph, EMPTY_PUFFS, PUFF_STRIDE } from './exhaust';
import { PUFF_AGE_MASK, PUFF_KIND_BIT } from './puff-style';
import {
  placeCoarseGroup,
  placeCoarseLone,
  placeFirstRingGroup,
  type GroupPlacement,
  type LonePlacement,
} from './group-placement';
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
  /** Reject a complete ground agent when any of its ASCII cells crosses forbidden terrain. */
  allowsGroundCell?: (agent: VisibleAgent, col: number, row: number) => boolean;
  /** Final painted agent index + 1; zero means no owner (including bird shadows). */
  owners?: Uint32Array;
  speakers?: SpeakerGrid;
  /** Diagnostic-only final outcome, one byte per supplied agent. */
  outcomes?: Uint8Array;
  /** Diagnostic attempt denial flags: collision 1, terrain 2 (both may be set). */
  denials?: Uint8Array;
  /** Successful detailed vehicle stamps, indexed by this frame's final agent array. */
  stampedVehicles?: Uint8Array;
};
/** Per-person packing, independent of cart and group owner identity. */
export type SpeakerGrid = { members: Uint8Array; points: Map<number, [number, number]> };

/**
 * A vehicle's or boat's paint (bits 0–3), part (4–6), and whether it is parked (bit 7: lamps
 * off), in the texel's last byte.
 */
export const vehicleByte = (paint: number, part: VehiclePart, parked = false, brake = false) =>
  ((part === VehiclePart.taillight
    ? (paint & ~BRAKE_LAMP) | (brake && !parked ? BRAKE_LAMP : 0)
    : paint) &
    15) |
  (part << 4) |
  (parked ? 128 : 0);

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
const COVERED_CART: VehicleSpec = {
  ...VEHICLES.cart,
  plan: VEHICLES.cart.plan.map((row) => row.replace(/[A-Z]/g, 'R')),
};

/** Each vehicle part's glyph index (`PART_GLYPHS`). */
export type LifeGlyphs = { parts: Uint16Array };

/**
 * The ground agent `packLife` is drawing (a vehicle or person): the cells it overwrote, and
 * whether one of them was already another ground agent's. A whole ground agent is omitted if
 * coarse ASCII cells would merge it with another. Drawing is synchronous, so one is enough.
 */
type MemberRaster = {
  expected: number;
  cells: { col: number; row: number; bytes: readonly number[] }[];
  point?: [number, number];
};
// Coarse draws capture into fixed scratch; rejected draws alone materialize payload objects.
const memberCells = new Float64Array(4 * 4 * 6);
const memberCounts = new Uint8Array(4);
const memberExpected = new Uint8Array(4);
const memberPoints = new Float64Array(8);
function capturedMembers(count: number): MemberRaster[] {
  return Array.from({ length: count }, (_, member) => ({
    expected: memberExpected[member]!,
    cells: Array.from({ length: memberCounts[member]! }, (_, cell) => {
      const at = (member * 4 + cell) * 6;
      return {
        col: memberCells[at]!,
        row: memberCells[at + 1]!,
        bytes: Array.from(memberCells.subarray(at + 2, at + 6)),
      };
    }),
    point: Number.isNaN(memberPoints[member * 2]!)
      ? undefined
      : ([memberPoints[member * 2]!, memberPoints[member * 2 + 1]!] as [number, number]),
  }));
}
function commitMembers(
  out: Uint8Array,
  cols: number,
  members: readonly MemberRaster[],
  offsets: readonly (readonly [number, number])[],
) {
  members.forEach((member, i) => {
    const [dx, dy] = offsets[i]!;
    for (const { col, row, bytes } of member.cells) {
      const cell = (row + dy) * cols + col + dx;
      out.set(bytes, cell * 4);
      groundCells[cell] = 1;
      if (drawingOwners) drawingOwners[cell] = drawingOwner;
      if (drawingSpeakers) drawingSpeakers.members[cell] = i + 1;
      drawingClockCells?.push(cell);
    }
    if (member.point)
      drawingSpeakers?.points.set(drawingOwner, [member.point[0] + dx, member.point[1] + dy]);
  });
}
const adjacentCells = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
] as const;
let journal:
  | {
      before: Map<number, [number, number, number, number, number, number?]>;
      denied: boolean;
      incomplete?: boolean;
      memberCount?: number;
      members?: MemberRaster[];
    }
  | undefined;
let fallbackStampedVehicles = new Uint8Array(0);
let detailedStamp = false;
let detailedPeopleStamp = false;
let drawingOwners: Uint32Array | undefined;
let drawingOwner = 0;
let drawingFocus = 0;
let drawingClockCells: number[] | undefined;
let clockCells: number[] | undefined;

export type LifePackMetadata = {
  /** Observe only the new rejection tier; never used to select a placement. */
  groupRetry?: (result: GroupPlacement) => void;
  loneRetry?: (result: LonePlacement) => void;
  owners?: Uint32Array;
  focus?: ReadonlySet<LifeFocus>;
  /** Only clocked candle writes; callers resolve final owners after all occlusion/rollback. */
  clockCells?: number[];
};

/** Every complete texel write also replaces its frame-local owner. */
function writeCell(
  out: Uint8Array,
  at: number,
  glyph: number,
  cls: number,
  bits: number,
  byte: number,
) {
  [out[at], out[at + 1]] = packGlyph(glyph, cls);
  out[at + 2] = bits | drawingFocus;
  out[at + 3] = byte;
  if (drawingOwners) drawingOwners[at / 4] = drawingOwner;
  drawingClockCells?.push(at / 4);
}
/** Cells (texel offset / 4) held by ground agents already drawn this frame. */
let groundCells = new Uint8Array(0);
let drawingSpeakers: SpeakerGrid | undefined;
let drawingMember = 0;
let drawingMini = false;
/** Reused while one transitioning person's underlying figure is drawn synchronously. */
const figureCoverage = new Map<number, number>();
const figureMasks = new Map<string, number>();
let coverageWidth = 0;
let coverageHeight = 0;
let coveragePixels = new Uint8Array(0);

/** Conservative sixths of the actual procedural glyph, cached at the current atlas size. */
function figureCellMask(glyph: string, w: number, h: number): number {
  if (w !== coverageWidth || h !== coverageHeight) {
    coverageWidth = w;
    coverageHeight = h;
    coveragePixels = new Uint8Array(w * h);
    figureMasks.clear();
  }
  const cached = figureMasks.get(glyph);
  if (cached !== undefined) return cached;
  coveragePixels.fill(0);
  drawProcedural({ data: coveragePixels, stride: w, x0: 0, y0: 0, w, h }, glyph);
  let mask = 0;
  const { xs, ys } = sextantSplits(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!coveragePixels[y * w + x]) continue;
      const row = y < ys[1] ? 0 : y < ys[2] ? 1 : 2;
      mask |= 1 << (row * 2 + Number(x >= xs[1]));
    }
  figureMasks.set(glyph, mask);
  return mask;
}

function rememberGroundCell(out: Uint8Array, at: number) {
  if (journal && !journal.before.has(at)) {
    if (groundCells[at / 4]) journal.denied = true;
    // Preserve the ordinary five-value owner journal; speech adds its member
    // only when enabled, avoiding an unused slot in every painted-cell array.
    journal.before.set(
      at,
      drawingSpeakers
        ? [
            out[at]!,
            out[at + 1]!,
            out[at + 2]!,
            out[at + 3]!,
            drawingOwners?.[at / 4] ?? 0,
            drawingSpeakers.members[at / 4]!,
          ]
        : [out[at]!, out[at + 1]!, out[at + 2]!, out[at + 3]!, drawingOwners?.[at / 4] ?? 0],
    );
  }
  if (drawingSpeakers) drawingSpeakers.members[at / 4] = drawingMember;
}
/** Glyph indices belong to this atlas; density, DPR, and theme changes build another set. */
export function buildLifeGlyphs(glyphIndex: (glyph: string) => number): LifeGlyphs {
  const parts = new Uint16Array(VehiclePart.accent + 1);
  for (const [part, glyph] of Object.entries(PART_GLYPHS)) parts[Number(part)] = glyphIndex(glyph);
  return { parts };
}

/**
 * Pack `agents` into `out` (cols × rows × 4 bytes, cleared first). A vehicle that covers fewer
 * than `STAMP_MIN_CELLS` along its length is one glyph that follows its heading on screen (the
 * first glyph across, the second up or down); a bigger one is drawn at its real size from its
 * plan. People are figures (`drawPeople`); a vendor's cart is drawn like a vehicle, but stands
 * only where people may. Birds and dogs are drawn at their real size too (`drawBird`,
 * `drawDog`); a bird without a species takes the theme's glyph for its wing beat. With the `sun`
 * up, each flying bird first casts a
 * shadow on the ground away from it (`LIFE_SHADOW` texels, config.ts `BIRD_SHADOW`). Later
 * ground agents keep separate cells. Returns how many agents (each person in a group) landed on the grid.
 */
export function packLife(
  out: Uint8Array,
  grid: LifeGrid,
  agents: readonly VisibleAgent[],
  theme: Theme,
  glyphIndex: (glyph: string) => number,
  sun?: Sun | null,
  glyphs: LifeGlyphs = buildLifeGlyphs(glyphIndex),
  metadata: LifePackMetadata = {},
  puffs: Float64Array = EMPTY_PUFFS,
): number {
  const cells = grid.cols * grid.rows;
  if (grid.outcomes && grid.outcomes.length !== agents.length)
    throw new RangeError('Packing outcomes must match agents');
  grid.outcomes?.fill(PackingOutcome.outside);
  if (grid.denials && grid.denials.length !== agents.length)
    throw new RangeError('Packing denials must match agents');
  grid.denials?.fill(0);
  drawingOwners = metadata.owners ?? grid.owners;
  if (drawingOwners && drawingOwners.length !== cells)
    throw new RangeError('Life owners must match the cell grid');
  out.fill(0);
  if (grid.stampedVehicles && grid.stampedVehicles.length < agents.length)
    throw new RangeError('Wrong stamped vehicle mask size');
  if (!grid.stampedVehicles && fallbackStampedVehicles.length < agents.length)
    fallbackStampedVehicles = new Uint8Array(agents.length);
  const stampedVehicles = grid.stampedVehicles ?? fallbackStampedVehicles;
  stampedVehicles.fill(0);
  drawingOwners?.fill(0);
  drawingOwner = 0;
  drawingFocus = 0;
  clockCells = metadata.clockCells;
  if (clockCells) clockCells.length = 0;
  drawingClockCells = undefined;
  journal = undefined;
  drawingSpeakers = grid.speakers;
  if (drawingSpeakers && (!drawingOwners || drawingSpeakers.members.length !== cells))
    throw new RangeError('Speaker packing requires matching owner and member grids');
  drawingSpeakers?.members.fill(0);
  drawingSpeakers?.points.clear();
  try {
    if (sun && sun.altitude > 0) drawShadows(out, grid, agents, sun, theme, glyphIndex);
    if (groundCells.length < cells) groundCells = new Uint8Array(cells);
    else groundCells.fill(0, 0, cells);
    let drawn = 0;
    // Fixed obstacles keep their cells as movers pass: parked cars, then vendors.
    // Owner indices still refer to the caller's original array.
    for (const priority of [0, 1, 2])
      for (let index = 0; index < agents.length; index++) {
        const agent = agents[index]!;
        if ((agent.parked ? 0 : agent.vehicle === 'cart' ? 1 : 2) !== priority) continue;
        drawingOwner = index + 1;
        drawingClockCells =
          agent.candle && agent.effectClock !== undefined ? clockCells : undefined;
        drawingFocus = metadata.focus?.has(lifeFocusOf(agent)) ? LIFE_FOCUS_BIT : 0;
        drawingMember = 0;
        drawingMini = false;
        const clockStart = clockCells?.length ?? 0;
        const ground = !agent.aboard && (agent.kind === 'vehicle' || isWalker(agent.kind));
        journal = ground ? { before: new Map(), denied: false } : undefined;
        detailedStamp = false;
        detailedPeopleStamp = false;
        const n = drawAgent(out, grid, agent, theme, glyphIndex, glyphs);
        const collision = journal?.denied ?? false;
        let cellDenied = false;
        if (journal && grid.allowsGroundCell)
          for (const at of journal.before.keys())
            if (
              !grid.allowsGroundCell(agent, (at / 4) % grid.cols, Math.floor(at / 4 / grid.cols))
            ) {
              journal.denied = true;
              cellDenied = true;
              break;
            }
        if (grid.outcomes)
          grid.outcomes[index] = collision
            ? PackingOutcome.collision
            : cellDenied
              ? PackingOutcome.cellGuard
              : n > 0
                ? PackingOutcome.drawn
                : PackingOutcome.outside;
        if (grid.denials) grid.denials[index] = (collision ? 1 : 0) | (cellDenied ? 2 : 0);
        if (!journal) drawn += n;
        else if (journal.denied) {
          if (journal.memberCount !== undefined)
            journal.members = capturedMembers(journal.memberCount);
          const eligible =
            (n > 0 || !!journal.members?.length) &&
            !detailedPeopleStamp &&
            !agent.parked &&
            !agent.aboard &&
            agent.vehicle !== 'cart' &&
            !agent.prop &&
            !agent.line &&
            !agent.people?.some((look) => look.figure === 'seated') &&
            ((agent.kind === 'vehicle' && drawingMini) ||
              (agent.kind === 'person' && !agent.vehicle) ||
              agent.kind === 'cat' ||
              agent.kind === 'dog');
          const retry =
            eligible &&
            !journal.incomplete &&
            journal.before.size <= (agent.kind === 'person' ? 16 : 4);
          // Save the already projected raster; retrying drawAgent would change its scale
          // and heading under an anisotropic projection.
          const payload = retry
            ? [...journal.before.keys()].map((at) => ({
                at,
                bytes: out.slice(at, at + 4),
                member: drawingSpeakers?.members[at / 4] ?? 0,
              }))
            : undefined;
          const point = drawingSpeakers?.points.get(drawingOwner);
          const clocked = retry ? clockCells?.slice(clockStart) : undefined;
          if (clockCells) clockCells.length = clockStart;
          drawingSpeakers?.points.delete(drawingOwner);
          for (const [at, previous] of journal.before) {
            // The fifth journal value is CPU ownership, never a fifth texture byte.
            for (let byte = 0; byte < 4; byte++) out[at + byte] = previous[byte]!;
            if (drawingOwners) drawingOwners[at / 4] = previous[4]!;
            if (drawingSpeakers) drawingSpeakers.members[at / 4] = previous[5]!;
          }
          let placed = false;
          if (payload) {
            const [col, row] = grid.toCell(agent.lng, agent.lat);
            const distance = ([dx, dy]: readonly [number, number]) =>
              (Math.floor(col) + dx + 0.5 - col) ** 2 + (Math.floor(row) + dy + 0.5 - row) ** 2;
            for (const [dx, dy] of [...adjacentCells].sort((a, b) => distance(a) - distance(b))) {
              if (
                !payload.every(({ at }) => {
                  const c = ((at / 4) % grid.cols) + dx,
                    r = Math.floor(at / 4 / grid.cols) + dy;
                  return (
                    c >= 0 &&
                    r >= 0 &&
                    c < grid.cols &&
                    r < grid.rows &&
                    !groundCells[r * grid.cols + c] &&
                    (!grid.allowsGroundCell || grid.allowsGroundCell(agent, c, r))
                  );
                })
              )
                continue;
              for (const { at, bytes, member } of payload) {
                const shifted = at + (dy * grid.cols + dx) * 4;
                out.set(bytes, shifted);
                groundCells[shifted / 4] = 1;
                if (drawingOwners) drawingOwners[shifted / 4] = drawingOwner;
                if (drawingSpeakers) drawingSpeakers.members[shifted / 4] = member;
              }
              if (point) drawingSpeakers?.points.set(drawingOwner, [point[0] + dx, point[1] + dy]);
              if (clocked) for (const cell of clocked) clockCells!.push(cell + dy * grid.cols + dx);
              if (grid.outcomes) grid.outcomes[index] = PackingOutcome.drawn;
              drawn += n;
              placed = true;
              break;
            }
          }
          const completeLonePayload =
            payload &&
            journal.members?.length === 1 &&
            journal.members[0]!.cells.length === journal.members[0]!.expected &&
            payload.length === journal.members[0]!.cells.length &&
            journal.members[0]!.cells.every((cell) =>
              payload.some(
                ({ at, bytes }) =>
                  at === (cell.row * grid.cols + cell.col) * 4 &&
                  cell.bytes.every((byte, i) => byte === bytes[i]),
              ),
            );
          if (
            !placed &&
            eligible &&
            !completeLonePayload &&
            journal.members &&
            journal.members.length <= 4 &&
            journal.members.reduce((sum, m) => sum + m.cells.length, 0) <= 16
          ) {
            // Reconstruct from each original member, never from overwritten texels.
            // Search only on rejection; every member stays within one cell of its anchor.
            const members = journal.members;
            const offsets = [[0, 0], ...adjacentCells] as const;
            const selected = placeFirstRingGroup(
              members,
              grid,
              offsets,
              (col, row) =>
                !groundCells[row * grid.cols + col] &&
                (!grid.allowsGroundCell || grid.allowsGroundCell(agent, col, row)),
            );
            if (selected) {
              commitMembers(out, grid.cols, members, selected);
              if (grid.outcomes) grid.outcomes[index] = PackingOutcome.drawn;
              drawn += members.length;
              placed = true;
            }
          }
          if (
            !placed &&
            eligible &&
            agent.kind === 'person' &&
            agent.mappedPersonMover === true &&
            (agent.people?.length ?? 1) === 1 &&
            !agent.people?.some((look) => look.figure === 'rower') &&
            journal.members?.length === 1
          ) {
            const member = journal.members[0]!;
            const result = placeCoarseLone(
              member,
              grid,
              (col, row) =>
                !groundCells[row * grid.cols + col] &&
                (!grid.allowsGroundCell || grid.allowsGroundCell(agent, col, row)),
            );
            if (result.offset) {
              commitMembers(out, grid.cols, [member], [result.offset]);
              if (grid.outcomes) grid.outcomes[index] = PackingOutcome.drawn;
              drawn++;
              placed = true;
            }
            if (result.rigidAttempts) metadata.loneRetry?.(result);
          }
          if (!placed && eligible && journal.members && journal.members.length >= 2) {
            const members = journal.members;
            const result = placeCoarseGroup(
              members,
              grid,
              (col, row) =>
                !groundCells[row * grid.cols + col] &&
                (!grid.allowsGroundCell || grid.allowsGroundCell(agent, col, row)),
            );
            if (result.offsets) {
              commitMembers(out, grid.cols, members, result.offsets);
              if (grid.outcomes) grid.outcomes[index] = PackingOutcome.drawn;
              drawn += members.length;
            }
            metadata.groupRetry?.(result);
          }
        } else {
          drawn += n;
          for (const at of journal.before.keys()) groundCells[at / 4] = 1;
          if (n && detailedStamp && agent.kind === 'vehicle') stampedVehicles[index] = 1;
        }
      }
    journal = undefined;
    drawingOwner = 0;
    drawPuffs(out, grid, puffs, glyphIndex, stampedVehicles);
    return drawn;
  } finally {
    journal = undefined;
    drawingOwners = undefined;
    drawingClockCells = clockCells = undefined;
    drawingOwner = 0;
    drawingFocus = 0;
    drawingSpeakers = undefined;
    drawingMember = 0;
    drawingMini = false;
  }
}

/** Decorative ink fills empty cells only after its detailed source was successfully admitted. */
function drawPuffs(
  out: Uint8Array,
  grid: LifeGrid,
  puffs: Float64Array,
  glyphIndex: (g: string) => number,
  stampedVehicles: Uint8Array,
) {
  for (let i = 0; i + PUFF_STRIDE <= puffs.length; i += PUFF_STRIDE) {
    if (!stampedVehicles[puffs[i]!]) continue;
    const [x, y] = grid.toCell(puffs[i + 1]!, puffs[i + 2]!);
    const col = Math.floor(x),
      row = Math.floor(y);
    if (col < 0 || row < 0 || col >= grid.cols || row >= grid.rows) continue;
    const at = (row * grid.cols + col) * 4;
    if (out[at + 2] !== 0) continue;
    const age = Math.max(0, Math.min(1, puffs[i + 3]!));
    const glyph = glyphIndex(puffGlyph(age));
    if (glyph <= 0 || glyph > MAX_GLYPHS) continue;
    [out[at], out[at + 1]] = packGlyph(glyph, classId('life_person'));
    out[at + 2] = CellBit.vehicle | CellBit.person;
    out[at + 3] = personByte(
      Math.min(PUFF_AGE_MASK, Math.floor(age * (PUFF_AGE_MASK + 1))) |
        (puffs[i + 4] === 1 ? PUFF_KIND_BIT : 0),
      PersonPart.puff,
    );
  }
}

/** Draw one agent for `packLife`; returns how many landed on the grid (each person in a group). */
function drawAgent(
  out: Uint8Array,
  grid: LifeGrid,
  agent: VisibleAgent,
  theme: Theme,
  glyphIndex: (glyph: string) => number,
  { parts }: LifeGlyphs,
): number {
  const { cols, rows, toCell } = grid;
  if (agent.line) return drawLine(out, grid, agent.line, glyphIndex) ? 1 : 0;
  const [col, row] = toCell(agent.lng, agent.lat);
  if (agent.prop === 'ball' || agent.prop === 'event') {
    const c = Math.floor(col),
      r = Math.floor(row),
      index = glyphIndex(agent.prop === 'event' ? agent.glyph! : '•');
    if (c < 0 || r < 0 || c >= cols || r >= rows || index <= 0 || index > MAX_GLYPHS) return 0;
    const at = (r * cols + c) * 4;
    rememberGroundCell(out, at);
    writeCell(
      out,
      at,
      index,
      classId(lifeClassFor.person),
      agent.eventGround ? EVENT_PERSON_BITS : CellBit.person,
      personByte(agent.paint ?? PAINT_NONE, PersonPart.figure),
    );
    return 1;
  }
  const baseSpec = agent.vehicle ? VEHICLES[agent.vehicle] : undefined;
  const spec = agent.covered && agent.vehicle === 'cart' && baseSpec ? COVERED_CART : baseSpec;
  if (agent.kind === 'person' && !spec) return drawPeople(out, grid, agent, [col, row], glyphIndex);
  if ((agent.kind === 'dog' || agent.kind === 'cat') && agent.ahead) {
    const drawn = drawPet(out, grid, agent, [col, row], glyphIndex);
    if (drawn && agent.emoji) drawingSpeakers?.points.set(drawingOwner, [col, row]);
    return drawn ? 1 : 0;
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
      const indicator =
        agent.kind === 'vehicle' &&
        !agent.parked &&
        hasTurnSignals(agent.vehicle) &&
        (agent.lamps?.kind === 'hazard' ? agent.lamps.on : agent.turnSignal?.on) &&
        Math.hypot(...across) * spec.width >= 2
          ? {
              sides:
                agent.lamps?.kind === 'hazard'
                  ? (['left', 'right'] as const)
                  : [agent.turnSignal!.side],
              glyph: parts[VehiclePart.headlight]!,
            }
          : undefined;
      const brake =
        agent.kind === 'vehicle' && hasTurnSignals(agent.vehicle) && agent.lamps?.kind === 'brake';
      const stamped = stamp(
        out,
        grid,
        [col, row],
        along,
        across,
        spec,
        (part) => [
          // Boats are drawn solid, so the water doesn't show through them.
          parts[agent.kind === 'boat' ? VehiclePart.body : part]!,
          classId(cls),
          bits,
          vehicleByte(agent.paint ?? 0, part, agent.parked, brake),
        ],
        indicator,
        agent.kind === 'vehicle' && (!agent.parked || agent.vehicle === 'firetruck') && agent.beacon
          ? { ...agent.beacon, glyph: parts[VehiclePart.headlight]! }
          : undefined,
      );
      detailedStamp = stamped;
      if (stamped && agent.emoji && agent.kind === 'vehicle')
        drawingSpeakers?.points.set(drawingOwner, [
          col + 0.25 * spec.length * along[0],
          row + 0.25 * spec.length * along[1],
        ]);
      // The vendor stands clear of the cart's side.
      const vendor = agent.people
        ? drawPeople(out, grid, agent, [col, row], glyphIndex, spec.width / 2)
        : 0;
      drawingMember = 0;
      return (stamped ? 1 : 0) + vendor;
    }
  }
  if (agent.bird && agent.ahead)
    return drawBird(out, grid, agent, [col, row], theme, glyphIndex) ? 1 : 0;
  const people = agent.people ? drawPeople(out, grid, agent, [col, row], glyphIndex) : 0;
  drawingMember = 0;
  const c = Math.floor(col);
  const r = Math.floor(row);
  if (c < 0 || r < 0 || c >= cols || r >= rows) return people;
  const mini = agent.glyph ? [agent.glyph] : (spec?.mini ?? theme.styles[cls]?.glyphs);
  if (!mini || mini.length === 0) return people;
  let variant = 0;
  if (agent.kind === 'bird') {
    variant = agent.flap;
  } else if (agent.ahead) {
    const [aheadCol, aheadRow] = toCell(agent.ahead[0], agent.ahead[1]);
    const x = Math.abs((aheadCol - col) * grid.cellWidth);
    const y = Math.abs((aheadRow - row) * grid.cellHeight);
    variant = x >= y ? 0 : 1;
  }
  const index = glyphIndex(mini[Math.min(variant, mini.length - 1)]!);
  if (index <= 0 || index > MAX_GLYPHS) return people;
  const at = (r * cols + c) * 4;
  drawingMini = agent.kind === 'vehicle';
  rememberGroundCell(out, at);
  writeCell(
    out,
    at,
    index,
    classId(cls),
    agent.kind === 'vehicle' ? STAMP_BITS.vehicle! : agentBit[agent.kind],
    spec ? vehicleByte(agent.paint ?? 0, VehiclePart.mini, agent.parked) : 255,
  );
  if (
    agent.kind === 'vehicle' &&
    (!agent.parked || agent.vehicle === 'firetruck') &&
    agent.beacon?.half === 0
  ) {
    out[at + 2] = out[at + 2]! | BEACON_BIT;
    out[at + 3] = (out[at + 3]! & ~3) | agent.beacon.colors[0];
  }
  if (agent.emoji && agent.kind !== 'person')
    drawingSpeakers?.points.set(drawingOwner, [c + 0.5, r + 0.5]);
  return people + 1;
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
  let cellsPerMeter = 1;
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
    cellsPerMeter = Math.hypot(x, y) / cellWidth;
    fits = looks.map((look) => figureFit(look.figure, FIGURE_SIZE_M[look.figure] * cellsPerMeter));
  }
  const across = fx !== 0;
  const cls = classId(lifeClassFor.person);
  // People in a boat stand over the water; others where people may.
  const bits = agent.aboard ? CellBit.boat : agent.eventGround ? EVENT_PERSON_BITS : CellBit.person;
  const stroke = agent.stroke ?? 0;
  // A paddler's glyphs head up or right; turned half round, they are the other side's paddler at
  // the other end of the stroke (life/people.ts `ROWER`).
  const turned = fx < 0 || fy > 0;
  const stageOf = (look: PersonLook): 0 | 1 | undefined =>
    look.canopy ? (look.canopy.open < UMBRELLA_MOTION.stageCutoff ? 0 : 1) : undefined;
  let coverage: Map<number, number> | undefined;
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
  let captured = -1;
  const put = (c: number, r: number, glyph: string, byte: number) => {
    const index = glyphIndex(glyph);
    if (!Number.isInteger(c) || !Number.isInteger(r) || index <= 0 || index > MAX_GLYPHS) {
      if (captured >= 0 && journal) journal.denied = journal.incomplete = true;
      return false;
    }
    if (captured >= 0) {
      const cell = memberCounts[captured]!;
      if (cell >= 4) journal!.denied = journal!.incomplete = true;
      else {
        const at = (captured * 4 + cell) * 6;
        memberCells[at] = c;
        memberCells[at + 1] = r;
        memberCells[at + 2] = index & 255;
        memberCells[at + 3] = (cls & 63) | ((index >> 8) << 6);
        memberCells[at + 4] = bits | drawingFocus;
        memberCells[at + 5] = byte;
        memberCounts[captured] = cell + 1;
      }
    }
    if (c < 0 || r < 0 || c >= cols || r >= rows) {
      if (captured >= 0 && journal) journal.incomplete = true;
      return false;
    }
    const at = (r * cols + c) * 4;
    if (captured >= 0 && journal?.before.has(at)) journal.denied = journal.incomplete = true;
    rememberGroundCell(out, at);
    writeCell(out, at, index, cls, bits, byte);
    coverage?.set(at, figureCellMask(glyph, cellWidth, cellHeight));
    return true;
  };
  /** A 2×2 figure with its top left cell at (`c`, `r`). */
  const putBig = (look: PersonLook, c: number, r: number) => {
    const swap = look.figure === 'rower' && turned ? 1 : 0;
    const frame = ((look.flap === 1 ? 1 : 0) ^ swap) as 0 | 1;
    const pull = (stroke ^ swap) as 0 | 1;
    let any = false;
    for (const slice of [0, 1, 2, 3] as const) {
      const glyph = figureGlyph(
        look.figure,
        across,
        frame,
        { slice },
        pull,
        headingOf(fx, fy),
        look.pose,
        stageOf(look),
      );
      if (put(c + (slice & 1), r + (slice >> 1), glyph, byteOf(look))) any = true;
    }
    return any;
  };
  const drawFit = (look: PersonLook, fit: ReturnType<typeof figureFit>, cx: number, cy: number) => {
    if (fit === 'stamp')
      return stampFigure(
        out,
        grid,
        [cx, cy],
        along,
        right,
        look,
        stroke,
        glyphIndex,
        (tone) => [cls, bits, byteOf(look, tone)],
        coverage ? { coverage } : undefined,
      );
    if (fit === 'big') return putBig(look, Math.round(cx) - 1, Math.round(cy) - 1);
    const glyph = figureGlyph(
      look.figure,
      across,
      look.flap === 1 ? 1 : 0,
      { scale: fit },
      0,
      headingOf(fx, fy),
      look.pose,
      stageOf(look),
    );
    return put(Math.floor(cx), Math.floor(cy), glyph, byteOf(look));
  };
  let drawn = 0;

  if (fits.includes('stamp')) {
    detailedPeopleStamp = true;
    // Laid out in meters, around the agent's own point.
    const spacing = Math.max(...looks.map((look) => FIGURE_SIZE_M[look.figure]));
    looks.forEach((look, i) => {
      drawingMember = i + 1;
      const beside =
        clearance > 0 && look.lateral !== 0
          ? Math.sign(look.lateral) * (clearance + FIGURE_SIZE_M[look.figure] / 2 + 0.1)
          : look.lateral * spacing;
      const back = look.back * spacing;
      const cx = col + right[0] * beside - along[0] * back;
      const cy = row + right[1] * beside - along[1] * back;
      if ((agent.speech || agent.emoji) && (agent.speech?.member ?? 0) === i)
        drawingSpeakers?.points.set(drawingOwner, [cx, cy]);
      const fit = fits[i]!;
      let any: boolean;
      if (fit === 'stamp' && look.canopy) {
        const under = {
          ...look,
          figure: look.canopy.figure,
          paint: look.canopy.paint,
          canopy: undefined,
        };
        const underFit = figureFit(under.figure, FIGURE_SIZE_M[under.figure] * cellsPerMeter);
        figureCoverage.clear();
        coverage = figureCoverage;
        any = drawFit(under, underFit, cx, cy);
        coverage = undefined;
        const canopy = stampFigure(
          out,
          grid,
          [cx, cy],
          along,
          right,
          look,
          stroke,
          glyphIndex,
          (tone) => [cls, bits, byteOf(look, tone)],
          {
            size:
              (UMBRELLA_MOTION.folded + (1 - UMBRELLA_MOTION.folded) * look.canopy.open) *
              FIGURE_SIZE_M.umbrella,
            underneath: figureCoverage,
          },
        );
        any = canopy || any;
      } else {
        any = drawFit(look, fit, cx, cy);
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
  if (
    journal &&
    !agent.vehicle &&
    looks.length <= 4 &&
    c0 >= 0 &&
    r0 >= 0 &&
    c0 < cols &&
    r0 < rows
  ) {
    journal.memberCount = looks.length;
    memberCounts.fill(0);
    memberPoints.fill(NaN);
  }
  looks.forEach((look, i) => {
    drawingMember = i + 1;
    captured = journal?.memberCount !== undefined ? i : -1;
    if (captured >= 0) memberExpected[captured] = fits[i] === 'big' ? 4 : 1;
    const lateral =
      clearance > 0 && look.lateral !== 0
        ? Math.sign(look.lateral) * Math.max(size, Math.ceil(clear + size / 2))
        : look.lateral * size;
    const back = look.back * size;
    // Physical group rotations leave fractional slots (including tiny roundoff).
    // Typed-array addresses must be integer cells; keep those physical slots intact.
    const c = c0 + Math.round(rx * lateral - fx * back);
    const r = r0 + Math.round(ry * lateral - fy * back);
    const fit = fits[i]!;
    const [dc, dr] = fit !== 'big' && size === 2 ? [c0 < c ? 0 : 1, r0 < r ? 0 : 1] : [0, 0];
    if ((agent.speech || agent.emoji) && (agent.speech?.member ?? 0) === i) {
      const point: [number, number] = fit === 'big' ? [c + 1, r + 1] : [c + dc + 0.5, r + dr + 0.5];
      drawingSpeakers?.points.set(drawingOwner, point);
      if (captured >= 0) {
        memberPoints[captured * 2] = point[0];
        memberPoints[captured * 2 + 1] = point[1];
      }
    }
    let any: boolean;
    if (fit === 'big') {
      any = putBig(look, c, r);
    } else {
      const glyph = figureGlyph(
        look.figure,
        across,
        look.flap === 1 ? 1 : 0,
        { scale: fit === 'stamp' ? 2 : fit },
        0,
        headingOf(fx, fy),
        look.pose,
        stageOf(look),
      );
      // In a 2×2 slot: its cell nearest the first of the group.
      any = put(c + dc, r + dr, glyph, byteOf(look));
    }
    if (any) drawn++;
  });
  return drawn;
}

type StampOptions = {
  size?: number;
  underneath?: ReadonlyMap<number, number>;
  coverage?: Map<number, number>;
};

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
  center: [number, number],
  along: [number, number],
  right: [number, number],
  look: PersonLook,
  stroke: 0 | 1,
  glyphIndex: (glyph: string) => number,
  texel: (tone: boolean) => [number, number, number],
  options?: StampOptions,
): boolean {
  const frame = look.flap === 1 ? 1 : 0;
  // A canopy's thin ribs show in a cell where they are a third of its ink.
  const toneShare = look.figure === 'umbrella' ? 1 / 3 : 1 / 2;
  return stampMaster(
    out,
    grid,
    center,
    along,
    right,
    options?.size ?? FIGURE_SIZE_M[look.figure],
    (u, v, detail) => figureInk(look.figure, frame, u, v, detail, stroke, look.pose),
    toneShare,
    glyphIndex,
    texel,
    options,
  );
}

/**
 * Stamp a square master `size` m across, centered on `center` with `along` and `right` the
 * screen vectors (in cells) of a meter forward and a meter to the right: each cell it covers
 * shows the sixths of it `ink` marks (`ink(u forward, v right, detail)`, both 0–1 across the
 * square, `detail` how many sixths it spans the fewer way; '.' is empty, 'o' tone), as a
 * sextant glyph, in tone where more than `toneShare` of its ink is. Returns whether any cell
 * landed on the grid.
 */
function stampMaster(
  out: Uint8Array,
  grid: LifeGrid,
  [cx, cy]: [number, number],
  [ax, ay]: [number, number],
  [sx, sy]: [number, number],
  size: number,
  ink: (u: number, v: number, detail: number) => string,
  toneShare: number,
  glyphIndex: (glyph: string) => number,
  texel: (tone: boolean) => [number, number, number],
  options?: Pick<StampOptions, 'underneath' | 'coverage'>,
): boolean {
  const { cols, rows } = grid;
  const det = ax * sy - ay * sx;
  if (Math.abs(det) < 1e-9) return false;
  const half = size / 2;
  const c0 = Math.max(0, Math.floor(cx - (Math.abs(ax) + Math.abs(sx)) * half));
  const c1 = Math.min(cols - 1, Math.floor(cx + (Math.abs(ax) + Math.abs(sx)) * half));
  const r0 = Math.max(0, Math.floor(cy - (Math.abs(ay) + Math.abs(sy)) * half));
  const r1 = Math.min(rows - 1, Math.floor(cy + (Math.abs(ay) + Math.abs(sy)) * half));
  if (c1 < c0 || r1 < r0 || (c1 - c0 + 1) * (r1 - r0 + 1) > MAX_STAMP_CELLS) return false;
  // How many sixths (2 across a cell, 3 down it) the master spans, the fewer way.
  const detail = 2 * half * Math.min(Math.hypot(2 * ax, 3 * ay), Math.hypot(2 * sx, 3 * sy));
  let any = false;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      let mask = 0;
      let inked = 0;
      let tone = 0;
      for (let bit = 0; bit < 6; bit++) {
        // The sixth's center, in meters forward and to the right of the master's center.
        const px = c + ((bit & 1) + 0.5) / 2 - cx;
        const py = r + ((bit >> 1) + 0.5) / 3 - cy;
        const forward = (px * sy - py * sx) / det;
        const side = (ax * py - ay * px) / det;
        if (Math.abs(forward) >= half || Math.abs(side) >= half) continue;
        const mark = ink(forward / half / 2 + 0.5, side / half / 2 + 0.5, detail);
        if (mark === '.') continue;
        mask |= 1 << bit;
        inked++;
        if (mark === 'o') tone++;
      }
      if (mask === 0) continue;
      const at = (r * cols + c) * 4;
      const underMask = options?.underneath?.get(at) ?? 0;
      // Count only newly covered sixths; retain the canopy's actual rib samples.
      let added = underMask & ~mask;
      while (added) {
        inked++;
        added &= added - 1;
      }
      mask |= underMask;
      const [cls, bits, byte] = texel(tone > inked * toneShare);
      const index = glyphIndex(sextantGlyphs[mask]!);
      if (index <= 0 || index > MAX_GLYPHS) continue;
      rememberGroundCell(out, at);
      writeCell(out, at, index, cls, bits, byte);
      options?.coverage?.set(at, mask);
      any = true;
    }
  }
  return any;
}

/**
 * Draw a bird at its real size (life/birds.ts `birdFit`, its wingspan on screen): far out the
 * theme's glyph for its pose, then a silhouette filling its cell turned to its heading on screen,
 * and closest up stamped over the cells it covers (`stampMaster`), in its species' colors.
 * Returns whether it landed on the grid.
 */
function drawBird(
  out: Uint8Array,
  grid: LifeGrid,
  agent: VisibleAgent,
  [col, row]: [number, number],
  theme: Theme,
  glyphIndex: (glyph: string) => number,
  shadow = false,
): boolean {
  const { cols, rows, toCell, cellWidth, cellHeight } = grid;
  const { species, pose } = agent.bird!;
  // Its shadow: the cells it covers, marked for the shader to darken, with no agent in them.
  const cls = shadow ? 0 : classId(lifeClassFor.bird);
  const bits = shadow ? 0 : agentBit.bird;
  const [aheadCol, aheadRow] = toCell(agent.ahead![0], agent.ahead![1]);
  const along: [number, number] = [aheadCol - col, aheadRow - row];
  const x = along[0] * cellWidth;
  const y = along[1] * cellHeight;
  const fit = birdFit((BIRD_SPECIES[species].wingspan * Math.hypot(x, y)) / cellWidth);
  if (fit === 'stamp') {
    // A quarter turn clockwise on screen, in pixels (rows run down the screen).
    const right: [number, number] = [-y / cellWidth, x / cellHeight];
    return stampMaster(
      out,
      grid,
      [col, row],
      along,
      right,
      BIRD_SPECIES[species].wingspan,
      (u, v, detail) => birdInk(species, pose, u, v, detail),
      1 / 2,
      glyphIndex,
      (tone) => [cls, bits, shadow ? LIFE_SHADOW : birdByte(species, tone)],
    );
  }
  const c = Math.floor(col);
  const r = Math.floor(row);
  if (c < 0 || r < 0 || c >= cols || r >= rows) return false;
  if (shadow) {
    const at = (r * cols + c) * 4;
    // Never over an agent (shadows are drawn first, but a stamped shadow may reach another's).
    if (out[at + 2] === 0) out[at + 3] = LIFE_SHADOW;
    return true;
  }
  let glyph: string | undefined;
  if (fit === 'cell') {
    glyph = birdGlyph(pose, headingOf(x, y));
  } else {
    // The theme's: wings spread, raised, and sitting.
    const glyphs = theme.styles[lifeClassFor.bird]?.glyphs ?? [];
    glyph = glyphs[Math.min(pose === BirdPose.perched ? 2 : pose, glyphs.length - 1)];
  }
  const index = glyph ? glyphIndex(glyph) : 0;
  if (index <= 0 || index > MAX_GLYPHS) return false;
  const at = (r * cols + c) * 4;
  rememberGroundCell(out, at);
  writeCell(out, at, index, cls, bits, birdByte(species, false, fit === 'cell'));
  return true;
}

/**
 * The flying birds' shadows (config.ts `BIRD_SHADOW`): each bird's shape, as big as it is drawn,
 * on the ground `altitude` over the tangent of the sun's altitude away from it (at most
 * `reach`), in `LIFE_SHADOW` texels the glyph shader darkens the map under (shaders/glyph.ts).
 */
function drawShadows(
  out: Uint8Array,
  grid: LifeGrid,
  agents: readonly VisibleAgent[],
  sun: Sun,
  theme: Theme,
  glyphIndex: (glyph: string) => number,
) {
  const tan = Math.tan((Math.max(sun.altitude, 1) * Math.PI) / 180);
  const meters = Math.min(BIRD_SHADOW.reach, BIRD_SHADOW.altitude / tan);
  const az = (sun.azimuth * Math.PI) / 180;
  // Away from the sun: east and north, m.
  const east = -Math.sin(az) * meters;
  const north = -Math.cos(az) * meters;
  const metersPerDegree = 111_320;
  for (const agent of agents) {
    if (!agent.bird || !agent.ahead || agent.bird.pose === BirdPose.perched) continue;
    const dLat = north / metersPerDegree;
    const dLng = east / (metersPerDegree * Math.cos((agent.lat * Math.PI) / 180));
    const moved: VisibleAgent = {
      ...agent,
      lng: agent.lng + dLng,
      lat: agent.lat + dLat,
      ahead: [agent.ahead[0] + dLng, agent.ahead[1] + dLat],
    };
    const at = grid.toCell(moved.lng, moved.lat);
    drawBird(out, grid, moved, at, theme, glyphIndex, true);
  }
}

/**
 * Draw a dog (life/dogs.ts) or cat (life/cats.ts) at its real size, like a bird: in one cell
 * turned to its heading on screen and stepping with `flap`, and closest up stamped over the
 * cells it covers, in its coat's paint (the people's class, `personColor`; its nose and ears
 * the darker ink). Returns whether it landed on the grid.
 */
function drawPet(
  out: Uint8Array,
  grid: LifeGrid,
  agent: VisibleAgent,
  [col, row]: [number, number],
  glyphIndex: (glyph: string) => number,
): boolean {
  const { cols, rows, toCell, cellWidth, cellHeight } = grid;
  const cls = classId(lifeClassFor.dog);
  const bits = agentBit.dog;
  const paint = agent.paint ?? PAINT_NONE;
  const catFrame = Math.min(3, agent.flap);
  const dogFrame = agent.flap === 2 ? 2 : agent.flap === 1 ? 1 : 0;
  const art =
    agent.kind === 'cat'
      ? {
          size: CAT_LENGTH_M,
          ink: (u: number, v: number, detail: number) => catInk(catFrame, u, v, detail),
          glyph: (heading: Heading) => catGlyph(catFrame, heading),
        }
      : {
          size: DOG_LENGTH_M,
          ink: (u: number, v: number, detail: number) => dogInk(dogFrame, u, v, detail),
          glyph: (heading: Heading) => dogGlyph(dogFrame, heading),
        };
  const [aheadCol, aheadRow] = toCell(agent.ahead![0], agent.ahead![1]);
  const along: [number, number] = [aheadCol - col, aheadRow - row];
  const x = along[0] * cellWidth;
  const y = along[1] * cellHeight;
  if (dogFit((art.size * Math.hypot(x, y)) / cellWidth) === 'stamp') {
    const right: [number, number] = [-y / cellWidth, x / cellHeight];
    return stampMaster(
      out,
      grid,
      [col, row],
      along,
      right,
      art.size,
      art.ink,
      1 / 2,
      glyphIndex,
      (tone) => [cls, bits, personByte(paint, tone ? PersonPart.rib : PersonPart.canopy)],
    );
  }
  const c = Math.floor(col);
  const r = Math.floor(row);
  if (c < 0 || r < 0 || c >= cols || r >= rows) return false;
  const index = glyphIndex(art.glyph(headingOf(x, y)));
  if (index <= 0 || index > MAX_GLYPHS) return false;
  const at = (r * cols + c) * 4;
  rememberGroundCell(out, at);
  // Drawn like a canopy: the full ink its paint, the tone ink darker (shaders/glyph.ts).
  writeCell(out, at, index, cls, bits, personByte(paint, PersonPart.canopy));
  return true;
}

/**
 * Draw a vehicle from its plan: every cell whose center falls inside its footprint, which is
 * centered on `center` with `along` and `across` the screen vectors (in cells) of a meter
 * forward and a meter to the right. Returns whether any cell landed on the grid.
 */
function stamp(
  out: Uint8Array,
  grid: LifeGrid,
  center: [number, number],
  along: [number, number],
  across: [number, number],
  spec: VehicleSpec,
  texel: (part: VehiclePart) => [number, number, number, number],
  indicator?: { sides: readonly TurnSide[]; glyph: number },
  beacon?: Beacon & { glyph: number },
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
  const barCells: { at: number; forward: number; right: number }[] | undefined = beacon
    ? []
    : undefined;
  // Nearest existing cells to front/rear corners: never enlarge the vehicle's footprint.
  const lamps = indicator
    ? indicator.sides.flatMap((side) => [
        {
          at: -1,
          score: Infinity,
          forward: -length * 0.4,
          side,
          right: (side === 'left' ? -1 : 1) * spec.width * 0.4,
        },
        {
          at: -1,
          score: Infinity,
          forward: length * 0.4,
          side,
          right: (side === 'left' ? -1 : 1) * spec.width * 0.4,
        },
      ])
    : undefined;
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
      if (glyph <= 0 || glyph > MAX_GLYPHS) continue;
      const at = (r * cols + c) * 4;
      rememberGroundCell(out, at);
      writeCell(out, at, glyph, cls, bits, byte);
      barCells?.push({ at, forward, right });
      if (lamps)
        for (const lamp of lamps) {
          if (lamp.side === 'left' ? right >= 0 : right <= 0) continue;
          // Keep front and rear lamps on their own half, even when viewport clipping hides one.
          if (forward * lamp.forward <= 0) continue;
          const score = (forward - lamp.forward) ** 2 + (right - lamp.right) ** 2;
          if (score < lamp.score) {
            lamp.at = at;
            lamp.score = score;
          }
        }
      any = true;
    }
  }
  if (lamps && indicator && indicator.glyph > 0 && indicator.glyph <= MAX_GLYPHS)
    for (const lamp of lamps) {
      if (lamp.at < 0) continue;
      const cls = out[lamp.at + 1]! & 63;
      [out[lamp.at], out[lamp.at + 1]] = packGlyph(indicator.glyph, cls);
      out[lamp.at + 2] = out[lamp.at + 2]! | TURN_SIGNAL_BIT;
    }
  if (beacon && barCells?.length && beacon.glyph > 0 && beacon.glyph <= MAX_GLYPHS) {
    const available = barCells.filter((cell) => !(out[cell.at + 2]! & TURN_SIGNAL_BIT));
    const selected: number[] = [];
    for (const half of [0, 1] as const) {
      const candidates = available.filter(
        (cell) => available.length === 1 || !selected.includes(cell.at),
      );
      const right = (half === 0 ? -1 : 1) * spec.width * 0.25;
      candidates.sort(
        (a, b) =>
          (a.forward - length * 0.1) ** 2 +
            (a.right - right) ** 2 -
            ((b.forward - length * 0.1) ** 2 + (b.right - right) ** 2) || a.at - b.at,
      );
      if (candidates[0]) selected.push(candidates[0].at);
    }
    const at = selected[beacon.half] ?? selected[0];
    if (at !== undefined) {
      [out[at], out[at + 1]] = packGlyph(beacon.glyph, out[at + 1]! & 63);
      out[at + 2] = out[at + 2]! | BEACON_BIT;
      out[at + 3] = (out[at + 3]! & ~3) | beacon.colors[beacon.half];
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
    if (index <= 0 || index > MAX_GLYPHS) return;
    rememberGroundCell(out, at);
    writeCell(
      out,
      at,
      index,
      cls,
      CellBit.boat,
      vehicleByte(tip?.paint ?? line.paints[k % line.paints.length]!, VehiclePart.body),
    );
  });
  return marks.length > 0;
}
