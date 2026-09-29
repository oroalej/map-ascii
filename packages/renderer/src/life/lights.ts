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
import { BEAM, BULB, CANDLE, DEFAULT_ROAD_WIDTH_M, FLOOD, SHOP, STREETLIGHT } from './config';
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

/**
 * Floats per lamp in a tile's `lamps`: the head's x, y (tile units), state, seed (0–31), the x, y
 * of the pool's center (out over the road, where the lamp's arm reaches), and the x, y of the
 * road's center line beside it.
 */
export const LAMP_STRIDE = 8;

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

/** A lit road line: its points (tile units) and carriageway width, m (0: unknown). */
export type LitLine = { points: readonly TilePoint[]; width: number };

/** A lamp placed along a line or at a junction, before it is kept or dropped. */
type Candidate = {
  x: number;
  y: number;
  /** Where its pool reaches toward: the road's center line beside it, or the junction. */
  cx: number;
  cy: number;
  /** The road's heading there, and the unit vector from its center line out to the lamp. */
  hx: number;
  hy: number;
  nx: number;
  ny: number;
  line: number;
  junction: boolean;
};

/** How far from a lit line's center line its lamps stand, in tile units (at the roadside). */
function roadside({ width }: LitLine, unitMeters: number): number {
  const half = (width || DEFAULT_ROAD_WIDTH_M) / 2;
  return Math.max(half - STREETLIGHT.setback, half * STREETLIGHT.minSide) / unitMeters;
}

/** Just past a lit line's edge, in tile units from its center line (a junction lamp's kerb). */
function kerb({ width }: LitLine, unitMeters: number): number {
  return ((width || DEFAULT_ROAD_WIDTH_M) / 2 + STREETLIGHT.setback) / unitMeters;
}

/**
 * Lamps along a lit road line (tile units), on a world lattice every `STREETLIGHT.spacing` m:
 * where each segment's main axis (east–west or north–south) crosses a lattice line, so a road
 * gets the same lamps whichever tile or OSM way it is drawn from. They alternate sides by the
 * lattice line's parity, at the roadside (`roadside`). `origin` is the tile's corner in world
 * tile units.
 */
function lampsAlong(
  road: LitLine,
  line: number,
  unitMeters: number,
  origin: TilePoint,
): Candidate[] {
  const out: Candidate[] = [];
  const { points } = road;
  const offset = roadside(road, unitMeters);
  const step = STREETLIGHT.spacing / unitMeters;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length === 0) continue;
    const hx = (b.x - a.x) / length;
    const hy = (b.y - a.y) / length;
    const across = Math.abs(hx) >= Math.abs(hy);
    // Along the main axis, in world tile units, from a to b.
    const from = across ? origin.x + a.x : origin.y + a.y;
    const to = across ? origin.x + b.x : origin.y + b.y;
    const rate = across ? hx : hy;
    // The same side of the road whichever way the line runs: south of an east–west road, east
    // of a north–south one (tile y points down).
    const flip = (across ? hx : -hy) >= 0 ? 1 : -1;
    const first = Math.ceil(Math.min(from, to) / step);
    const last = Math.floor(Math.max(from, to) / step);
    for (let n = first; n <= last; n++) {
      const t = (n * step - from) / rate;
      // Include the segment's start but not its end, which the next segment starts at.
      if (t < 0 || t >= length) continue;
      const side = (n & 1) === 0 ? flip : -flip;
      const nx = -hy * side;
      const ny = hx * side;
      const cx = a.x + hx * t;
      const cy = a.y + hy * t;
      out.push({
        x: cx + nx * offset,
        y: cy + ny * offset,
        cx,
        cy,
        hx,
        hy,
        nx,
        ny,
        line,
        junction: false,
      });
    }
  }
  return out;
}

/**
 * Lamps at junctions of lit roads: where a vertex is shared by two or more lit lines, other than
 * one simply carrying on as the next (two line ends meeting), a lamp stands on the kerb at a
 * corner (`kerb`), outside both roads, its pool reaching over the junction.
 */
function junctionLamps(lines: readonly LitLine[], unitMeters: number): Candidate[] {
  type Touch = { line: number; index: number; end: boolean };
  const touches = new Map<string, Touch[]>();
  lines.forEach(({ points }, line) => {
    points.forEach((p, index) => {
      const key = `${Math.round(p.x * 4)},${Math.round(p.y * 4)}`;
      const end = index === 0 || index === points.length - 1;
      const list = touches.get(key);
      if (list) list.push({ line, index, end });
      else touches.set(key, [{ line, index, end }]);
    });
  });
  const out: Candidate[] = [];
  for (const list of touches.values()) {
    const roads = new Set(list.map((t) => t.line));
    if (roads.size < 2) continue;
    if (list.length === 2 && list.every((t) => t.end)) continue;
    const [one, two] = [list[0]!, list.find((t) => t.line !== list[0]!.line)!];
    const heading = (t: Touch) => {
      const pts = lines[t.line]!.points;
      const next = pts[t.index + 1] ?? pts[t.index]!;
      const prev = pts[t.index - 1] ?? pts[t.index]!;
      const dx = next.x - prev.x;
      const dy = next.y - prev.y;
      const length = Math.hypot(dx, dy) || 1;
      return [dx / length, dy / length] as const;
    };
    const [hx, hy] = heading(one);
    const [kx, ky] = heading(two);
    const p = lines[one.line]!.points[one.index]!;
    // On the kerb at the corner: past the first road's edge along the second road, and past the
    // second's along the first, so it stands outside both.
    const a = kerb(lines[one.line]!, unitMeters);
    const b = kerb(lines[two.line]!, unitMeters);
    const x = p.x + kx * a + hx * b;
    const y = p.y + ky * a + hy * b;
    const toLamp = Math.hypot(x - p.x, y - p.y) || 1;
    out.push({
      x,
      y,
      cx: p.x,
      cy: p.y,
      hx,
      hy,
      nx: (x - p.x) / toLamp,
      ny: (y - p.y) / toLamp,
      line: one.line,
      junction: true,
    });
  }
  return out;
}

/**
 * Whether a lamp stands in a divided road's median: another lit line runs alongside its own
 * (nearly parallel), `STREETLIGHT.minMedian`–`STREETLIGHT.median` m off on the lamp's side, so
 * the lamp would be in the middle of the whole road. Crossing streets aren't parallel, so lamps
 * by junctions stay.
 */
function inMedian(lamp: Candidate, lines: readonly LitLine[], unitMeters: number): boolean {
  const reach = STREETLIGHT.median / unitMeters;
  const apart = STREETLIGHT.minMedian / unitMeters;
  for (let l = 0; l < lines.length; l++) {
    if (l === lamp.line) continue;
    const { points } = lines[l]!;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!;
      const b = points[i]!;
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      if (length === 0) continue;
      const dx = (b.x - a.x) / length;
      const dy = (b.y - a.y) / length;
      if (Math.abs(dx * lamp.hx + dy * lamp.hy) < 0.9) continue;
      const t = Math.max(0, Math.min(length, (lamp.cx - a.x) * dx + (lamp.cy - a.y) * dy));
      const vx = a.x + dx * t - lamp.cx;
      const vy = a.y + dy * t - lamp.cy;
      const distance = Math.hypot(vx, vy);
      // Off to the lamp's side, not the same carriageway carrying on as another way.
      const sideways = vx * lamp.nx + vy * lamp.ny;
      if (distance < reach && sideways > apart && sideways > distance * 0.7) return true;
    }
  }
  return false;
}

/**
 * A tile's streetlights along its lit road `lines`: at their junctions first (`junctionLamps`),
 * then along them (`lampsAlong`), less those in a divided road's median (`inMedian`), those
 * within `STREETLIGHT.minGap` m of one already placed, and those outside the tile (0–`extent`;
 * tiles overlap in their buffers). `origin` is the tile's corner in world tile units. Each lights
 * a pool centered `STREETLIGHT.reach` m in over the road, no further than its center line.
 * Returns `LAMP_STRIDE` floats per lamp.
 */
export function placeTileLamps(
  lines: readonly LitLine[],
  unitMeters: number,
  extent: number,
  origin: TilePoint = { x: 0, y: 0 },
): number[] {
  const out: number[] = [];
  const inward = STREETLIGHT.reach / unitMeters;
  const gap = STREETLIGHT.minGap / unitMeters;
  const kept: Candidate[] = [];
  const candidates = [
    ...junctionLamps(lines, unitMeters),
    ...lines.flatMap((line, l) => lampsAlong(line, l, unitMeters, origin)),
  ];
  for (const lamp of candidates) {
    const { x, y, cx, cy } = lamp;
    if (x < 0 || x >= extent || y < 0 || y >= extent) continue;
    if (kept.some((k) => Math.hypot(k.x - x, k.y - y) < gap)) continue;
    if (!lamp.junction && inMedian(lamp, lines, unitMeters)) continue;
    kept.push(lamp);
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
 * no pool; a floodlight has no head. Pools are ellipses on screen, so a tilted view's perspective
 * squashes them. Returns how many heads landed on the grid.
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
      pool(out, grid, cx, cy, r, r, CANDLE.strength, lightByte(LampState.candle, i));
    } else {
      pool(out, grid, cx, cy, r, r, BULB.strength, lightByte(LampState.bulb, i));
    }
    lit++;
  });
  return lit;
}
