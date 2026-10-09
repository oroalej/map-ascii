import { placeLampSupports, type LitLine } from '@atlas/shared';
/**
 * Night lights (SPEC.md §4 "Life layer"), packed into the light texture the glyph pass lights for
 * the time of day (shaders/glyph.ts):
 * - streetlights: lamp posts along major and secondary roads and at their junctions, always at
 *   the roadside, evenly spaced on a world lattice. Placed in the tile worker (`placeTileLamps`)
 *   and put on the cell grid as pools of light and lamp heads (`packLights`). Some are out and
 *   some flicker.
 * - floodlights on landmarks (`packLights`, no head);
 * - moving vehicles' headlight beams (`packBeams`) and the candles people carry (`packCandles`).
 * Pure, so it can be unit-tested.
 */
import type { TilePoint } from '../raster/geometry';
import { BEAM, BULB, CANDLE, FLOOD, SHOP, STREETLIGHT } from './config';
import { random } from './random';
import type { VisibleAgent } from './simulate';
import { VEHICLES, type CraftType } from './vehicles';
import { BRAKE_GLOW } from './lamps';
import { hasTurnSignals } from './turn-signals';
import { ORDINARY_CLOCK } from './effect-clocks';

/**
 * What lights a cell: a streetlight lit, out, or flickering; a vehicle's headlight `beam`, a
 * `candle`, or a vendor cart's `bulb`, lit with the vehicles' own lamps; a landmark's
 * `flood`light; or an open `shop`.
 */
export const LampState = {
  working: 0,
  dead: 1,
  flicker: 2,
  beam: 3,
  candle: 4,
  flood: 5,
  shop: 6,
  bulb: 7,
} as const;
export type LampState = (typeof LampState)[keyof typeof LampState];

/** A light's byte in the texture's G channel: its state (bits 0–2) and seed (3–7, 0–31). */
export const lightByte = (state: LampState, seed: number) => (state & 7) | ((seed & 31) << 3);

export { LAMP_STRIDE } from './geometry';

/** Floats per floodlight in a tile's `floods`: its center x, y and radius (tile units). */
export const FLOOD_STRIDE = 3;

/** Floats per shop in a tile's `shops`: its center x, y and radius (tile units). */
export const SHOP_STRIDE = 3;

/** A seed for a place in the world (`x`, `y`, m), the same in every tile and at every zoom. */
export const placeSeed = (x: number, y: number): number =>
  (Math.imul(Math.round(x) | 0, 0x8da6b343) ^ Math.imul(Math.round(y) | 0, 0xd8163841)) >>> 0;

/**
 * A lamp's condition and flicker seed, from its place in the world (`x`, `y`, m), so it stays
 * the same on every visit, in every tile and at every zoom.
 */
export function lampCondition(x: number, y: number): { state: LampState; seed: number } {
  const h = placeSeed(x, y);
  const r = random(h)();
  const state =
    r < STREETLIGHT.dead
      ? LampState.dead
      : r < STREETLIGHT.dead + STREETLIGHT.flicker
        ? LampState.flicker
        : LampState.working;
  return { state, seed: (h >>> 8) & 31 };
}

export type { LitLine } from '@atlas/shared';

/** Legacy lamp packing; shared placement retains the original ordering and arithmetic. */
export function placeTileLamps(
  lines: readonly LitLine[],
  unitMeters: number,
  extent: number,
  origin: TilePoint = { x: 0, y: 0 },
): number[] {
  const out: number[] = [];
  const inward = STREETLIGHT.reach / unitMeters;
  for (const { x, y, cx, cy } of placeLampSupports(lines, unitMeters, extent, origin)) {
    const toCenter = Math.hypot(cx - x, cy - y);
    const k = toCenter > 0 ? Math.min(1, inward / toCenter) : 0;
    const { state, seed } = lampCondition((origin.x + x) * unitMeters, (origin.y + y) * unitMeters);
    out.push(x, y, state, seed, x + (cx - x) * k, y + (cy - y) * k, cx, cy);
  }
  return out;
}

/**
 * A light to draw: where its head is (none for a floodlight), the road's center line beside it,
 * the center of its pool and points its radius east and north of that, and how it is.
 */
export type VisibleLamp = {
  /** Immutable zoom-zero pool centre and axis offsets for compact seasonal pools. */
  worldPool?: readonly [number, number, number, number];
  /** Seasonal fixtures provide their own glyph and need only the compact pool. */
  headless?: boolean;
  lng: number;
  lat: number;
  center: [number, number];
  pool: [number, number];
  east: [number, number];
  north: [number, number];
  state: LampState;
  seed: number;
};

export type LightGrid = {
  cols: number;
  rows: number;
  world?: readonly [number, number, number, number];
  /** A point's position on the grid, in fractional cells (passes.ts `GridPlacement.toCell`). */
  toCell: (lng: number, lat: number) => [number, number];
};

/**
 * A lamp's head stands at least this many cells from its road's center line, so zoomed out, where
 * the road is a line of cells, it shows beside the road rather than on it.
 */
export const SIDE_CELLS = 1.5;

/** At most this many cells per pool (a lamp at the closest zoom is well under). */
const MAX_POOL_CELLS = 20_000;

/**
 * A pool of light centered at (`cx`, `cy`) (cells), `rx` by `ry` cells across, `strength` at its
 * brightest (0–1), over `out`. It takes a cell where it is brighter than what is there, and
 * claims the ring just outside it (A) if nothing else has, so the filtered pool's rim takes its
 * light's state. Lamp heads keep theirs.
 */
function pool(
  out: Uint8Array,
  grid: LightGrid,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  strength: number,
  g: number,
  clocks?: (cell: number, token: number) => void,
  clock = ORDINARY_CLOCK,
  touched?: (cell: number) => void,
) {
  const { cols, rows } = grid;
  const c0 = Math.max(0, Math.floor(cx - rx) - 1);
  const c1 = Math.min(cols - 1, Math.floor(cx + rx) + 1);
  const r0 = Math.max(0, Math.floor(cy - ry) - 1);
  const r1 = Math.min(rows - 1, Math.floor(cy + ry) + 1);
  if (c1 < c0 || r1 < r0 || (c1 - c0 + 1) * (r1 - r0 + 1) > MAX_POOL_CELLS) return;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const d = Math.hypot((c + 0.5 - cx) / rx, (r + 0.5 - cy) / ry);
      const at = (r * cols + c) * 4;
      const head = out[at + 2] !== 0;
      if (d >= 1) {
        if (!head && out[at + 3] === 0) {
          touched?.(at / 4);
          out[at + 1] = g;
          clocks?.(at / 4, clock);
          out[at + 3] = 255;
        }
        continue;
      }
      const value = Math.round(255 * strength * (1 - d) ** 1.5);
      if (value <= out[at]!) continue;
      // Under a head the pool still shines, but the cell keeps the head's light.
      out[at] = value;
      if (head) continue;
      if (out[at + 3] === 0) touched?.(at / 4);
      out[at + 1] = g;
      clocks?.(at / 4, clock);
      out[at + 3] = 255;
    }
  }
}

const candleBatches = new WeakMap<
  Uint8Array,
  {
    texels: Uint8Array;
    cells: number[];
    touch: (cell: number) => void;
  }
>();

/**
 * Pack `lamps` into `out` (cols × rows × 4 bytes, cleared first): per cell, the pool of light
 * (R, 0–255, brightest at its center), the light whose pool is strongest there (G,
 * `lightByte`), 255 in B under a streetlight's head, which stands at least `SIDE_CELLS` from its
 * road's center line, and 255 in A where a light claims the cell (its pool, a cell's ring around
 * it, since the glyph pass filters the pool across cells, and its head). A lamp that is out casts
 * no pool; a floodlight has no head. Returns how many heads landed on the grid.
 */
export function packLights(
  out: Uint8Array,
  grid: LightGrid,
  lamps: readonly VisibleLamp[],
): number {
  out.fill(0);
  const { cols, rows, toCell } = grid;
  // Heads first, so pools leave them be.
  let drawn = 0;
  for (const lamp of lamps) {
    if (lamp.headless || lamp.state === LampState.flood || lamp.state === LampState.shop) continue;
    let [hx, hy] = toCell(lamp.lng, lamp.lat);
    const [mx, my] = toCell(...lamp.center);
    const side = Math.hypot(hx - mx, hy - my);
    if (side > 0 && side < SIDE_CELLS) {
      hx = mx + ((hx - mx) / side) * SIDE_CELLS;
      hy = my + ((hy - my) / side) * SIDE_CELLS;
    }
    const col = Math.floor(hx);
    const row = Math.floor(hy);
    if (col < 0 || row < 0 || col >= cols || row >= rows) continue;
    const at = (row * cols + col) * 4;
    out[at + 1] = lightByte(lamp.state, lamp.seed);
    out[at + 2] = 255;
    out[at + 3] = 255;
    drawn++;
  }
  let batch: ReturnType<typeof candleBatches.get>;
  const flush = () => {
    if (!batch?.cells.length) return;
    for (const cell of batch.cells) {
      const at = cell * 4;
      if (batch.texels[at]! > out[at]!) {
        out[at] = batch.texels[at]!;
        if (!out[at + 2]) {
          out[at + 1] = batch.texels[at + 1]!;
          out[at + 3] = 255;
        }
      } else if (!out[at + 2] && !out[at + 3]) {
        out[at + 1] = batch.texels[at + 1]!;
        out[at + 3] = 255;
      }
      batch.texels.fill(0, at, at + 4);
    }
    batch.cells.length = 0;
  };
  for (const lamp of lamps) {
    if (lamp.state === LampState.dead) continue;
    const candle = lamp.headless && lamp.state === LampState.candle;
    if (!candle) flush();
    let cx: number, cy: number, rx: number, ry: number;
    if (candle && lamp.worldPool && grid.world) {
      const [sx, sy, ox, oy] = grid.world;
      cx = lamp.worldPool[0] * sx - ox;
      cy = lamp.worldPool[1] * sy - oy;
      rx = Math.max(1, lamp.worldPool[2] * sx);
      ry = Math.max(1, lamp.worldPool[3] * sy);
    } else {
      [cx, cy] = toCell(...lamp.pool);
      const [ex, ey] = toCell(...lamp.east);
      const [nx, ny] = toCell(...lamp.north);
      rx = Math.max(1, Math.hypot(ex - cx, ey - cy));
      ry = Math.max(1, Math.hypot(nx - cx, ny - cy));
    }
    // At least a cell, so the pool still shows when zoomed out.
    if (cx + rx + 2 < 0 || cy + ry + 2 < 0 || cx - rx - 2 >= cols || cy - ry - 2 >= rows) continue;
    const strength =
      lamp.state === LampState.flood
        ? FLOOD.strength
        : lamp.state === LampState.shop
          ? SHOP.strength
          : 1;
    if (candle) {
      if (!batch) {
        batch = candleBatches.get(out);
        if (!batch) {
          const cells: number[] = [];
          batch = { texels: new Uint8Array(out.length), cells, touch: (cell) => cells.push(cell) };
          candleBatches.set(out, batch);
        }
      }
      pool(
        batch.texels,
        grid,
        cx,
        cy,
        rx,
        ry,
        strength,
        lightByte(lamp.state, lamp.seed),
        undefined,
        ORDINARY_CLOCK,
        batch.touch,
      );
    } else pool(out, grid, cx, cy, rx, ry, strength, lightByte(lamp.state, lamp.seed));
  }
  flush();
  return drawn;
}

/** A beam shorter than this many cells (zoomed out) isn't cast. */
const MIN_BEAM_CELLS = 2;

type CachedCone = {
  revision: number;
  vehicle?: CraftType;
  lng: number;
  lat: number;
  aheadLng: number;
  aheadLat: number;
  sideLng: number;
  sideLat: number;
  cast: boolean;
  ready: boolean;
  count: number;
  offsets: Int32Array;
  values: Uint8Array;
};
/** Bounded by the current actor array; retains only numbers, never workers or mover graphs. */
export type ConePackingScratch = {
  revision: number;
  toCell?: LightGrid['toCell'];
  /**
   * The projection the cones were cast in: the window's scale and origin (`LightGrid.world`)
   * when known, so an in-margin pan's new placement wrapper keeps them.
   */
  world?: readonly [number, number, number, number];
  cols: number;
  rows: number;
  direction?: 1 | -1;
  cone?: Readonly<{ length: number; spread: number; strength: number }>;
  entries: (CachedCone | undefined)[];
};
export const createConePackingScratch = (): ConePackingScratch => ({
  revision: 0,
  cols: 0,
  rows: 0,
  entries: [],
});

function prepareCones(
  scratch: ConePackingScratch | undefined,
  grid: LightGrid,
  count: number,
  direction: 1 | -1,
  cone: Readonly<{ length: number; spread: number; strength: number }>,
) {
  if (!scratch) return;
  const world = grid.world;
  const sameProjection = world
    ? !!scratch.world && world.every((value, i) => value === scratch.world![i])
    : scratch.toCell === grid.toCell && !scratch.world;
  if (
    !sameProjection ||
    scratch.cols !== grid.cols ||
    scratch.rows !== grid.rows ||
    scratch.direction !== direction ||
    scratch.cone !== cone
  ) {
    scratch.revision++;
    scratch.toCell = grid.toCell;
    scratch.world = world && [...world];
    scratch.cols = grid.cols;
    scratch.rows = grid.rows;
    scratch.direction = direction;
    scratch.cone = cone;
  }
  if (scratch.entries.length > count) scratch.entries.length = count;
}

function cachedCone(
  out: Uint8Array,
  grid: LightGrid,
  agent: VisibleAgent,
  direction: 1 | -1,
  cone: Readonly<{ length: number; spread: number; strength: number }>,
  minCells: number,
  g: number,
  scratch: ConePackingScratch | undefined,
  index: number,
): boolean {
  if (!scratch || !agent.ahead || !agent.side)
    return packCone(out, grid, agent, direction, cone, minCells, g);
  let cached = scratch.entries[index];
  if (
    cached &&
    cached.revision === scratch.revision &&
    cached.vehicle === agent.vehicle &&
    cached.lng === agent.lng &&
    cached.lat === agent.lat &&
    cached.aheadLng === agent.ahead[0] &&
    cached.aheadLat === agent.ahead[1] &&
    cached.sideLng === agent.side[0] &&
    cached.sideLat === agent.side[1]
  ) {
    if (!cached.ready) {
      cached.count = 0;
      cached.cast = packCone(out, grid, agent, direction, cone, minCells, g, cached);
      cached.ready = true;
      return cached.cast;
    }
    for (let i = 0; i < cached.count; i++) {
      const at = cached.offsets[i]!,
        value = cached.values[i]!;
      if (out[at + 2] !== 0 || value <= out[at]!) continue;
      out[at] = value;
      out[at + 1] = g;
      out[at + 3] = 255;
    }
    return cached.cast;
  }
  if (!cached)
    scratch.entries[index] = cached = {
      revision: -1,
      lng: 0,
      lat: 0,
      aheadLng: 0,
      aheadLat: 0,
      sideLng: 0,
      sideLat: 0,
      cast: false,
      ready: false,
      count: 0,
      offsets: new Int32Array(0),
      values: new Uint8Array(0),
    };
  cached.revision = scratch.revision;
  cached.vehicle = agent.vehicle;
  cached.lng = agent.lng;
  cached.lat = agent.lat;
  cached.aheadLng = agent.ahead[0];
  cached.aheadLat = agent.ahead[1];
  cached.sideLng = agent.side[0];
  cached.sideLat = agent.side[1];
  cached.ready = false;
  cached.count = 0;
  // Moving poses retain their metadata, but use the cheap competing-light early-out.
  cached.cast = packCone(out, grid, agent, direction, cone, minCells, g);
  return cached.cast;
}

/**
 * Headlight beams (config.ts `BEAM`) over the light texels `packLights` wrote: from the front of
 * each moving vehicle, a cone `BEAM.length` m ahead that widens from the vehicle's width, fading
 * along and across it. A beam takes a cell where it is brighter than the pool there, marked
 * `LampState.beam`; lamp heads keep theirs. Parked vehicles cast none. Returns how many beams
 * were cast.
 */
export function packBeams(
  out: Uint8Array,
  grid: LightGrid,
  agents: readonly VisibleAgent[],
  scratch?: ConePackingScratch,
): number {
  prepareCones(scratch, grid, agents.length, 1, BEAM);
  const g = lightByte(LampState.beam, 0);
  let cast = 0;
  for (let i = 0; i < agents.length; i++) {
    const agent = agents[i]!;
    if (agent.kind !== 'vehicle' || agent.parked || !agent.vehicle) continue;
    if (cachedCone(out, grid, agent, 1, BEAM, MIN_BEAM_CELLS, g, scratch, i)) cast++;
  }
  return cast;
}

/** Rear light only from braking vehicles admitted as detailed stamps in this same frame. */
export function packBrakeGlow(
  out: Uint8Array,
  grid: LightGrid,
  agents: readonly VisibleAgent[],
  stampedVehicles: Uint8Array,
  scratch?: ConePackingScratch,
): number {
  prepareCones(scratch, grid, agents.length, -1, BRAKE_GLOW);
  const g = lightByte(LampState.beam, BRAKE_GLOW.seed);
  let cast = 0;
  for (let i = 0; i < agents.length; i++) {
    const agent = agents[i]!;
    if (
      !stampedVehicles[i] ||
      agent.kind !== 'vehicle' ||
      agent.parked ||
      !hasTurnSignals(agent.vehicle) ||
      agent.lamps?.kind !== 'brake'
    )
      continue;
    if (cachedCone(out, grid, agent, -1, BRAKE_GLOW, BRAKE_GLOW.minCells, g, scratch, i)) cast++;
  }
  return cast;
}

/** The same bounded, world-metre cone geometry for headlights and rear brake glow. */
function packCone(
  out: Uint8Array,
  grid: LightGrid,
  agent: VisibleAgent,
  direction: 1 | -1,
  cone: Readonly<{ length: number; spread: number; strength: number }>,
  minCells: number,
  g: number,
  cached?: CachedCone,
): boolean {
  const { cols, rows, toCell } = grid;
  if (!agent.vehicle || !agent.ahead || !agent.side) return false;
  const spec = VEHICLES[agent.vehicle];
  const [px, py] = toCell(agent.lng, agent.lat);
  const [qx, qy] = toCell(...agent.ahead);
  const [rx, ry] = toCell(...agent.side);
  // A meter forward and a meter to the right, in cells.
  const ax = direction * (qx - px);
  const ay = direction * (qy - py);
  const sx = rx - px;
  const sy = ry - py;
  const det = ax * sy - ay * sx;
  if (Math.abs(det) < 1e-9 || Math.hypot(ax, ay) * cone.length < minCells) return false;
  const half = spec.width / 2;
  const wide = half + cone.length * cone.spread;
  // The front (direction 1) or rear (-1), where the cone starts.
  const fx = px + (ax * spec.length) / 2;
  const fy = py + (ay * spec.length) / 2;
  const ex = fx + ax * cone.length;
  const ey = fy + ay * cone.length;
  const xs = [fx + sx * half, fx - sx * half, ex + sx * wide, ex - sx * wide];
  const ys = [fy + sy * half, fy - sy * half, ey + sy * wide, ey - sy * wide];
  const c0 = Math.max(0, Math.floor(Math.min(...xs)));
  const c1 = Math.min(cols - 1, Math.floor(Math.max(...xs)));
  const r0 = Math.max(0, Math.floor(Math.min(...ys)));
  const r1 = Math.min(rows - 1, Math.floor(Math.max(...ys)));
  if (c1 < c0 || r1 < r0 || (c1 - c0 + 1) * (r1 - r0 + 1) > MAX_POOL_CELLS) return false;
  const peakValue = Math.round(255 * cone.strength);
  // Walk perpendicular to the axis along which depth changes. Cardinal cones reuse their
  // exact depth/width/falloff; diagonal cones still evaluate the original metre arithmetic.
  const columnsFirst = sx === 0;
  const outer0 = columnsFirst ? c0 : r0,
    outer1 = columnsFirst ? c1 : r1;
  const inner0 = columnsFirst ? r0 : c0,
    inner1 = columnsFirst ? r1 : c1;
  const outerPoints = columnsFirst ? xs : ys,
    innerPoints = columnsFirst ? ys : xs;
  let previousForward = NaN,
    limit = 0,
    intensity = 0;
  const length = cone.length,
    spread = cone.spread,
    peak = cone.strength;
  for (let outer = outer0; outer <= outer1; outer++) {
    // Clip each scanline to the convex cone, with a one-cell safety margin. The original
    // inverse-metre checks below remain authoritative, including at boundaries and clips.
    const scan = outer + 0.5;
    let low = Infinity,
      high = -Infinity;
    for (let edge = 0; edge < 4; edge++) {
      const end = edge === 0 ? 1 : edge === 1 ? 3 : edge === 2 ? 0 : 2;
      const a = outerPoints[edge]!,
        b = outerPoints[end]!;
      if (scan < Math.min(a, b) - 1e-7 || scan > Math.max(a, b) + 1e-7) continue;
      if (a === b) {
        low = Math.min(low, innerPoints[edge]!, innerPoints[end]!);
        high = Math.max(high, innerPoints[edge]!, innerPoints[end]!);
      } else {
        const crossing =
          innerPoints[edge]! + ((scan - a) * (innerPoints[end]! - innerPoints[edge]!)) / (b - a);
        low = Math.min(low, crossing);
        high = Math.max(high, crossing);
      }
    }
    const first = Math.max(inner0, Math.floor(low) - 1);
    const last = Math.min(inner1, Math.ceil(high) + 1);
    for (let inner = first; inner <= last; inner++) {
      const c = columnsFirst ? outer : inner,
        r = columnsFirst ? inner : outer;
      const at = (r * cols + c) * 4;
      // A brighter pool cannot lose to this cone, even at its peak. Avoid its geometry/falloff.
      if (!cached && (out[at + 2] !== 0 || out[at]! >= peakValue)) continue;
      // The cell's center in meters ahead of the front and to the right of the center line.
      const dx = c + 0.5 - fx;
      const dy = r + 0.5 - fy;
      const forward = (dx * sy - dy * sx) / det;
      const right = (ax * dy - ay * dx) / det;
      if (forward <= 0 || forward >= length) continue;
      if (forward !== previousForward) {
        previousForward = forward;
        limit = half + forward * spread;
        const fade = 1 - forward / length;
        intensity = peak * (direction === 1 ? fade ** 1.2 : fade * fade);
      }
      if (Math.abs(right) >= limit) continue;
      const strength = intensity * (1 - (right / limit) ** 2);
      const value = Math.round(255 * strength);
      if (cached && value > 0) {
        if (cached.count === cached.offsets.length) {
          const capacity = Math.min(MAX_POOL_CELLS, Math.max(32, cached.count * 2));
          const offsets = new Int32Array(capacity),
            values = new Uint8Array(capacity);
          offsets.set(cached.offsets);
          values.set(cached.values);
          cached.offsets = offsets;
          cached.values = values;
        }
        cached.offsets[cached.count] = at;
        cached.values[cached.count++] = value;
      }
      if (out[at + 2] !== 0 || value <= out[at]!) continue;
      out[at] = value;
      out[at + 1] = g;
      out[at + 3] = 255;
    }
  }
  return true;
}

/**
 * The candles people carry (config.ts `CANDLE`), each a small flickering pool, over the light
 * texels: a crowd of them runs together into a river of light. Vendors' carts carry a bulb
 * (config.ts `BULB`). `cellsPerMeter` sizes them (the view's scale at its center). Returns how
 * many were lit.
 */
export function packCandles(
  out: Uint8Array,
  grid: LightGrid,
  agents: readonly VisibleAgent[],
  cellsPerMeter: number,
  clocks?: (cell: number, token: number) => void,
): number {
  // At least a cell and a half, so a crowd's candles still read zoomed out.
  const radius = Math.max(1.5, CANDLE.radius * cellsPerMeter);
  let lit = 0;
  const bulb = Math.max(1, BULB.radius * cellsPerMeter);
  agents.forEach((agent, i) => {
    const cart = agent.kind === 'person' && agent.vehicle === 'cart';
    const peddler = agent.kind === 'person' ? (agent.peddler?.lamp ?? 0) : 0;
    if (!agent.candle && !cart && !peddler) return;
    const r = agent.candle ? radius : bulb;
    const [cx, cy] = grid.toCell(agent.lng, agent.lat);
    if (cx < -r || cy < -r || cx > grid.cols + r || cy > grid.rows + r) return;
    if (agent.candle) {
      pool(
        out,
        grid,
        cx,
        cy,
        r,
        r,
        CANDLE.strength,
        lightByte(LampState.candle, agent.candleSeed ?? i),
        clocks,
        agent.effectClock ?? ORDINARY_CLOCK,
      );
    } else {
      pool(
        out,
        grid,
        cx,
        cy,
        r,
        r,
        BULB.strength * (peddler || 1),
        lightByte(LampState.bulb, i),
        clocks,
      );
    }
    lit++;
  });
  return lit;
}
