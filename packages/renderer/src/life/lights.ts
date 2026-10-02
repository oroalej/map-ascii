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
import { VEHICLES } from './vehicles';

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
  clocks?: Float32Array | ((cell: number, token: number) => void),
  clock = -1,
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
          out[at + 1] = g;
          if (typeof clocks === 'function') clocks(at / 4, clock);
          else if (clocks) clocks[(at / 4) * 2 + 1] = clock;
          out[at + 3] = 255;
        }
        continue;
      }
      const value = Math.round(255 * strength * (1 - d) ** 1.5);
      if (value <= out[at]!) continue;
      // Under a head the pool still shines, but the cell keeps the head's light.
      out[at] = value;
      if (head) continue;
      out[at + 1] = g;
      if (typeof clocks === 'function') clocks(at / 4, clock);
      else if (clocks) clocks[(at / 4) * 2 + 1] = clock;
      out[at + 3] = 255;
    }
  }
}

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
    if (lamp.state === LampState.flood || lamp.state === LampState.shop) continue;
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
  for (const lamp of lamps) {
    if (lamp.state === LampState.dead) continue;
    const [cx, cy] = toCell(...lamp.pool);
    const [ex, ey] = toCell(...lamp.east);
    const [nx, ny] = toCell(...lamp.north);
    // At least a cell, so the pool still shows when zoomed out.
    const rx = Math.max(1, Math.hypot(ex - cx, ey - cy));
    const ry = Math.max(1, Math.hypot(nx - cx, ny - cy));
    const strength =
      lamp.state === LampState.flood
        ? FLOOD.strength
        : lamp.state === LampState.shop
          ? SHOP.strength
          : 1;
    pool(out, grid, cx, cy, rx, ry, strength, lightByte(lamp.state, lamp.seed));
  }
  return drawn;
}

/** A beam shorter than this many cells (zoomed out) isn't cast. */
const MIN_BEAM_CELLS = 2;

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
): number {
  const { cols, rows, toCell } = grid;
  const g = lightByte(LampState.beam, 0);
  let cast = 0;
  for (const agent of agents) {
    if (agent.kind !== 'vehicle' || agent.parked || !agent.vehicle) continue;
    if (!agent.ahead || !agent.side) continue;
    const spec = VEHICLES[agent.vehicle];
    const [px, py] = toCell(agent.lng, agent.lat);
    const [qx, qy] = toCell(...agent.ahead);
    const [rx, ry] = toCell(...agent.side);
    // A meter forward and a meter to the right, in cells.
    const ax = qx - px;
    const ay = qy - py;
    const sx = rx - px;
    const sy = ry - py;
    const det = ax * sy - ay * sx;
    if (Math.abs(det) < 1e-9 || Math.hypot(ax, ay) * BEAM.length < MIN_BEAM_CELLS) continue;
    const half = spec.width / 2;
    const wide = half + BEAM.length * BEAM.spread;
    // The vehicle's front, where the beam starts.
    const fx = px + (ax * spec.length) / 2;
    const fy = py + (ay * spec.length) / 2;
    const ex = fx + ax * BEAM.length;
    const ey = fy + ay * BEAM.length;
    const xs = [fx + sx * half, fx - sx * half, ex + sx * wide, ex - sx * wide];
    const ys = [fy + sy * half, fy - sy * half, ey + sy * wide, ey - sy * wide];
    const c0 = Math.max(0, Math.floor(Math.min(...xs)));
    const c1 = Math.min(cols - 1, Math.floor(Math.max(...xs)));
    const r0 = Math.max(0, Math.floor(Math.min(...ys)));
    const r1 = Math.min(rows - 1, Math.floor(Math.max(...ys)));
    if (c1 < c0 || r1 < r0 || (c1 - c0 + 1) * (r1 - r0 + 1) > MAX_POOL_CELLS) continue;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        // The cell's center in meters ahead of the front and to the right of the center line.
        const dx = c + 0.5 - fx;
        const dy = r + 0.5 - fy;
        const forward = (dx * sy - dy * sx) / det;
        const right = (ax * dy - ay * dx) / det;
        if (forward <= 0 || forward >= BEAM.length) continue;
        const limit = half + forward * BEAM.spread;
        if (Math.abs(right) >= limit) continue;
        const strength =
          BEAM.strength * (1 - forward / BEAM.length) ** 1.2 * (1 - (right / limit) ** 2);
        const at = (r * cols + c) * 4;
        const value = Math.round(255 * strength);
        if (out[at + 2] !== 0 || value <= out[at]!) continue;
        out[at] = value;
        out[at + 1] = g;
        out[at + 3] = 255;
      }
    }
    cast++;
  }
  return cast;
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
  clocks?: Float32Array | ((cell: number, token: number) => void),
): number {
  // At least a cell and a half, so a crowd's candles still read zoomed out.
  const radius = Math.max(1.5, CANDLE.radius * cellsPerMeter);
  let lit = 0;
  const bulb = Math.max(1, BULB.radius * cellsPerMeter);
  agents.forEach((agent, i) => {
    const cart = agent.kind === 'person' && agent.vehicle === 'cart';
    if (!agent.candle && !cart) return;
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
        agent.effectClock ?? -1,
      );
    } else {
      pool(out, grid, cx, cy, r, r, BULB.strength, lightByte(LampState.bulb, i), clocks);
    }
    lit++;
  });
  return lit;
}
