import { PED_STOP, PED_WALK, PedestrianPart } from './pedestrian-glyphs';
import { RoadAccess, carriageways } from './terrain';
import type { BuntingProjection } from './bunting-junctions';
/** Static street hardware, independent of the life population and lighting texture. */
import {
  packUtilityFixtures,
  utilityViewportVisibility,
  UtilityPart,
  utilityOpacity,
  type UtilityFixture,
  type UtilityPackingScratch,
} from './utilities';
import { lampSupportKey, bandVisibility } from '@atlas/shared';
import { MAX_GLYPHS, packGlyph, wallGlyph } from '../glyphs/select';
import {
  EXTENT,
  MERCATOR_METERS,
  metersPerUnit,
  tileToLngLat,
  lngLatToTile,
} from '../raster/geometry';
import type { TileId } from '../tiles';
import { SIGNAL_STRIDE, type LifeGeometry } from './geometry';
import {
  LAMP_STRIDE,
  type LampState,
  lightByte,
  placeSeed,
  SIDE_CELLS,
  type LightGrid,
} from './lights';
import { pedestrianState, signalState } from './signals';
import {
  packSeasonalFixtures,
  isSeasonalFixture,
  SeasonalPart,
  type SeasonalFixture,
  type SeasonalVisibility,
} from './seasonal';

type Point = [number, number];
type FixtureBody = { base: Point; tip: Point; forward: Point; right: Point; seed: number };
export type LegacyStreetFixture = FixtureBody &
  (
    | {
        kind: 'streetlight';
        supportKey?: string;
        state: LampState;
        roadCenter: Point;
        site?: boolean;
        style?: 'streetlight' | 'lantern';
      }
    | { kind: 'signal'; group: 'a' | 'b'; midBlock: boolean }
    | {
        kind: 'pedestrian-signal';
        group: 'a' | 'b';
        midBlock: boolean;
        crossing: string;
        side: number;
      }
    | { kind: 'flagpole'; flag: 'PH' }
  );
export type StreetFixture = UtilityFixture | LegacyStreetFixture | SeasonalFixture;
// Fixture inputs are replaced when tiles/config change. Retain the seasonal slice so
// whole-row priority sorting is cached across camera repacks as well.
const seasonalInputs = new WeakMap<readonly StreetFixture[], readonly SeasonalFixture[]>();
export type FixtureVisibility = {
  streetlights: boolean;
  trafficSignals: boolean;
  pedestrianSignals?: boolean;
  utilities: boolean;
  seasonal?: SeasonalVisibility;
};
export type FixturePackingScratch = { seasonalAdmission: Int32Array };
export const createFixturePackingScratch = (): FixturePackingScratch => ({
  seasonalAdmission: new Int32Array(0),
});

export type FixtureGrid = LightGrid & {
  buntingProjection?: BuntingProjection;
  cellWidth: number;
  cellHeight: number;
  /** Only the viewport, excluding the render grid's offscreen margin. */
  visible?: (col: number, row: number) => boolean;
};

/** Low six bits of G; the high two bits retain the glyph's ten-bit index. */
export const FixturePart = {
  ...UtilityPart,
  ...SeasonalPart,
  pedestrianStop: PedestrianPart.stop,
  pedestrianWalk: PedestrianPart.walk,
  base: 1,
  arm: 2,
  housing: 3,
  lamp: 4,
  red: 5,
  amber: 6,
  green: 7,
  signal: 8,
  casing: 9,
  flagBlue: 10,
  flagRed: 11,
  flagWhite: 12,
  flagGold: 13,
  flagMast: 14,
  flagPlinth: 15,
  flagFoot: 16,
} as const;
const signalColor = { red: 0, amber: 1, green: 2 } as const;

/** Compact screen-space rays; cars retain their separate metric headlight settings. */
export const SIGNAL_LIGHT = {
  dayLength: 4,
  nightLength: 14,
  dayStrength: 0.04,
  nightStrength: 0.35,
  halfWidth: 1.2,
  spread: 0.15,
  haloRadius: 6,
  haloStrength: 0.35,
} as const;

/** Retain tile ownership and the existing curb positions, directions, and phase seeds. */
export function tileFixtures(tile: TileId, geo: LifeGeometry): LegacyStreetFixture[] {
  const out: LegacyStreetFixture[] = [];
  const perMeter = 1 / metersPerUnit(tile);
  const vehicleBases: { x: number; y: number }[] | undefined = geo.controlledCrossings?.some(
    (c) => c.sides,
  )
    ? []
    : undefined;
  const scale = MERCATOR_METERS / (EXTENT * 2 ** tile.z);
  const body = (x: number, y: number, dx: number, dy: number, reach: number): FixtureBody => {
    const length = Math.hypot(dx, dy) || 1;
    const hx = dx / length;
    const hy = dy / length;
    return {
      base: tileToLngLat(tile, { x, y }),
      tip: tileToLngLat(tile, { x: x + hx * reach, y: y + hy * reach }),
      forward: tileToLngLat(tile, { x: x + hx * perMeter, y: y + hy * perMeter }),
      right: tileToLngLat(tile, { x: x - hy * perMeter, y: y + hx * perMeter }),
      seed: placeSeed((tile.x * EXTENT + x) * scale, (tile.y * EXTENT + y) * scale),
    };
  };
  for (let i = 0; i < geo.lamps.length; i += LAMP_STRIDE) {
    const x = geo.lamps[i]!,
      y = geo.lamps[i + 1]!;
    if (x < 0 || y < 0 || x >= EXTENT || y >= EXTENT) continue;
    const dx = geo.lamps[i + 4]! - x,
      dy = geo.lamps[i + 5]! - y;
    const fixture = body(x, y, dx || dy ? dx : 0, dx || dy ? dy : -1, Math.hypot(dx, dy));
    // Lamp flicker and the staggered switch-on use the original five-bit seed.
    out.push({
      ...fixture,
      kind: 'streetlight',
      ...(geo.lampSites?.[i / LAMP_STRIDE] !== 1 ? { supportKey: lampSupportKey(tile, x, y) } : {}),
      site: geo.lampSites?.[i / LAMP_STRIDE] === 1,
      style: geo.lampStyles?.[i / LAMP_STRIDE] === 1 ? 'lantern' : 'streetlight',
      state: geo.lamps[i + 2]! as LampState,
      seed: geo.lamps[i + 3]!,
      roadCenter: tileToLngLat(tile, { x: geo.lamps[i + 6]!, y: geo.lamps[i + 7]! }),
    });
  }
  const poles = geo.flagpoles ?? [];
  for (let i = 0; i < poles.length; i += 3) {
    const x = poles[i]!,
      y = poles[i + 1]!;
    if (x < 0 || y < 0 || x >= EXTENT || y >= EXTENT || poles[i + 2] !== 1) continue;
    out.push({ ...body(x, y, 0, -1, perMeter), kind: 'flagpole', flag: 'PH' });
  }
  const signals = geo.signals ?? [];
  for (let i = 0; i < signals.length; i += SIGNAL_STRIDE) {
    const x = signals[i]!,
      y = signals[i + 1]!,
      radius = signals[i + 2]!;
    const owned = x >= 0 && y >= 0 && x < EXTENT && y < EXTENT;
    if (!owned && !vehicleBases) continue;
    const seed =
      geo.signalSeeds?.[i / SIGNAL_STRIDE] ??
      placeSeed((tile.x * EXTENT + x) * scale, (tile.y * EXTENT + y) * scale);
    const midBlock = signals[i + 3]! < 0;
    const layout = geo.signalLayouts?.[i / SIGNAL_STRIDE];
    if (layout) {
      for (const arm of layout.arms) {
        if (!arm.inbound || !arm.stop) continue;
        const junction = lngLatToTile(tile, ...arm.junction);
        // Outward bearing: the housing and its ray face the approaching driver.
        const theta = ((arm.bearing + 180) * Math.PI) / 180;
        const hx = Math.sin(theta),
          hy = -Math.cos(theta);
        const lateral = arm.width / 2 + 0.5;
        const bx = junction.x + (hx * radius - hy * lateral) * perMeter;
        const by = junction.y + (hy * radius + hx * lateral) * perMeter;
        vehicleBases?.push({ x: bx, y: by });
        if (owned)
          out.push({
            ...body(bx, by, hy, -hx, perMeter),
            kind: 'signal',
            group: arm.group,
            midBlock,
            seed,
          });
      }
      continue;
    }
    for (const [bearing, group] of [
      [midBlock ? 0 : signals[i + 3]!, 'a'],
      [signals[i + 4]!, 'b'],
    ] as const) {
      const theta = (bearing * Math.PI) / 180;
      const hx = Math.sin(theta),
        hy = -Math.cos(theta);
      for (const sign of [-1, 1]) {
        const bx = x + sign * (hx * radius - hy * (radius - 1.5)) * perMeter;
        const by = y + sign * (hy * radius + hx * (radius - 1.5)) * perMeter;
        vehicleBases?.push({ x: bx, y: by });
        // A short bracket projects from the existing curb anchor toward the road.
        if (owned)
          out.push({
            ...body(bx, by, sign * hy, -sign * hx, perMeter),
            kind: 'signal',
            group,
            midBlock,
            seed,
          });
      }
    }
  }
  if (!vehicleBases) return out;
  const access = RoadAccess.fromPrepared(carriageways(geo, perMeter), []);
  for (const crossing of geo.controlledCrossings ?? []) {
    if (!crossing.sides) continue;
    const control = lngLatToTile(tile, ...crossing.controller.at);
    const theta = (crossing.bearing * Math.PI) / 180,
      along = { x: Math.sin(theta), y: -Math.cos(theta) };
    const projection =
      (crossing.anchor.x - control.x) * along.x + (crossing.anchor.y - control.y) * along.y;
    const preferred =
      Math.abs(projection) > 0.01 ? Math.sign(projection) : crossing.controller.seed & 1 ? 1 : -1;
    for (const [sideIndex, side] of crossing.sides.entries()) {
      let anchor: { x: number; y: number } | undefined;
      for (let depth = 0; depth < 10 && !anchor; depth++)
        for (let extra = 0; extra < 12 && !anchor; extra++)
          for (const direction of [preferred, -preferred]) {
            const p = {
              x:
                side.centre.x +
                along.x * direction * (1.8 + extra * 0.5) * perMeter -
                side.inward.x * (0.3 + depth * 0.5) * perMeter,
              y:
                side.centre.y +
                along.y * direction * (1.8 + extra * 0.5) * perMeter -
                side.inward.y * (0.3 + depth * 0.5) * perMeter,
            };
            if (
              access.allows(
                [
                  {
                    ...p,
                    hx: side.inward.x,
                    hy: side.inward.y,
                    length: 0.2 * perMeter,
                    width: 0.2 * perMeter,
                  },
                ],
                false,
              ) &&
              vehicleBases.every((v) => Math.hypot(v.x - p.x, v.y - p.y) >= 1.5 * perMeter)
            ) {
              anchor = p;
              break;
            }
          }
      if (!anchor || anchor.x < 0 || anchor.y < 0 || anchor.x >= EXTENT || anchor.y >= EXTENT)
        continue;
      out.push({
        ...body(anchor.x, anchor.y, side.inward.x, side.inward.y, 1.2 * perMeter),
        kind: 'pedestrian-signal',
        crossing: crossing.id,
        side: sideIndex,
        group: crossing.controller.walk,
        midBlock: crossing.controller.midBlock,
        seed: crossing.controller.seed,
      });
    }
  }
  return out;
}

type SignalCells = {
  seed: number;
  group: 'a' | 'b';
  midBlock: boolean;
  cells: number[];
  color: number;
  /** Actual lens cells after hardware ownership resolves, including the compact dot. */
  emitters: number[];
  /** Pixel-space approach direction, one turn quantized to a byte. */
  direction: number;
};
export type FixtureMotion = { time: number; strength: number };
type FlagCloth = {
  x: number;
  top: number;
  rows: number;
  cols: number;
  seed: number;
  opacity: number;
};
export type PackedFixtures = {
  /** Successful seasonal writes, including offscreen texture margins. */
  seasonalCells?: number;
  texels: Uint8Array;
  visibility: FixtureVisibility;
  signals: SignalCells[];
  pedestrians: {
    seed: number;
    group: 'a' | 'b';
    midBlock: boolean;
    cells: number[];
    state: number;
  }[];
  utilityCells: number[];
  /** Projected cloth envelopes; hardware owns its cells throughout the animation. */
  flags: FlagCloth[];
  cloth: {
    cols: number;
    rows: number;
    owners: Int32Array;
    cells: number[];
    glyphs: { block: number; sun: number; star: number };
    frame: number;
    strength: number;
  };
};

/** Restamp only cloth cells, using renderer time even while the Life simulation is off. */
export function updateFixtureFlags(packed: PackedFixtures, motion: FixtureMotion): boolean {
  if (!packed.flags.length) return false;
  const { cloth, texels } = packed;
  const strength = Math.max(0, Math.min(1.5, Math.round(motion.strength * 10) / 10));
  const frame = strength > 0 ? Math.floor(motion.time * 15) : -1;
  if (cloth.frame === frame && cloth.strength === strength) return false;
  cloth.frame = frame;
  cloth.strength = strength;
  for (const at of cloth.cells) texels.fill(0, at, at + 4);
  cloth.cells.length = 0;
  // Earlier flags retain ownership where their envelopes meet. Gold details may replace
  // their own cloth, but no cloth can erase a lamp, a signal, or a mast.
  const occupied = new Map<number, number>();
  for (const [index, flag] of packed.flags.entries()) {
    const phase = strength > 0 ? (frame / 15) * (2.4 + strength) + (flag.seed & 31) * 0.2 : 0;
    const amplitude = (flag.rows / 3) * (0.45 + strength * 0.7);
    const lift = (c: number) => {
      const u = c / Math.max(1, flag.cols - 1);
      return Math.round(u * Math.sin(u * Math.PI * 2 - phase) * amplitude + u * 0.7);
    };
    const tone = (c: number) =>
      Math.round(155 + 100 * (0.5 + 0.5 * Math.cos((c / flag.cols) * Math.PI * 4 - phase)));
    const write = (c: number, r: number, glyph: number, part: number) => {
      const x = flag.x + 1 + c;
      const y = flag.top + r + lift(c);
      if (x < 0 || y < 0 || x >= cloth.cols || y >= cloth.rows || glyph <= 0 || glyph > MAX_GLYPHS)
        return;
      const cell = y * cloth.cols + x;
      if (cloth.owners[cell] !== -1 || (occupied.has(cell) && occupied.get(cell) !== index)) return;
      const at = cell * 4;
      if (!occupied.has(cell)) cloth.cells.push(at);
      occupied.set(cell, index);
      [texels[at], texels[at + 1]] = packGlyph(glyph, part);
      texels[at + 2] = tone(c);
      texels[at + 3] = flag.opacity;
    };
    for (let r = 0; r < flag.rows; r++) {
      for (let c = 0; c < flag.cols; c++) {
        const u = (c + 0.5) / flag.cols;
        const v = (r + 0.5) / flag.rows;
        const triangle = u < (Math.sqrt(3) / 2) * Math.min(v, 1 - v);
        write(
          c,
          r,
          cloth.glyphs.block,
          triangle
            ? FixturePart.flagWhite
            : r < flag.rows / 2
              ? FixturePart.flagBlue
              : FixturePart.flagRed,
        );
      }
    }
    if (flag.rows >= 6) {
      write(2, 2, cloth.glyphs.sun, FixturePart.flagGold);
      write(0, 0, cloth.glyphs.star, FixturePart.flagGold);
      write(0, flag.rows - 1, cloth.glyphs.star, FixturePart.flagGold);
      write(Math.floor(flag.cols * 0.32), 3, cloth.glyphs.star, FixturePart.flagGold);
    }
  }
  return true;
}

/** Bit flags returned by updateFixtureSignals. */
export const FixtureSignalChange = { vehicle: 1, pedestrian: 2 } as const;

function pedestrianTexelState(seed: number, clock: number, midBlock: boolean, group: 'a' | 'b') {
  const phase = pedestrianState(seed, clock, midBlock, group);
  return phase === 'walk' ? 1 : phase === 'flash' ? (Math.floor(clock * 2) % 2 === 0 ? 2 : 3) : 0;
}

/** Update only phase bytes, without reprojecting or stamping static hardware. */
export function updateFixtureSignals(packed: PackedFixtures, clock: number): number {
  let changed = 0;
  const phases = packed.pedestrians.length > 1 ? new Map<number, number>() : undefined;
  for (const ped of packed.pedestrians) {
    const key = ped.seed * 4 + Number(ped.midBlock) * 2 + Number(ped.group === 'b');
    let state = phases?.get(key);
    if (state === undefined) {
      state = pedestrianTexelState(ped.seed, clock, ped.midBlock, ped.group);
      phases?.set(key, state);
    }
    if (state === ped.state) continue;
    ped.state = state;
    for (const at of ped.cells) packed.texels[at + 2] = state;
    changed |= FixtureSignalChange.pedestrian;
  }
  for (const signal of packed.signals) {
    const color = signalColor[signalState(signal.seed, clock, signal.midBlock)[signal.group]];
    if (color === signal.color) continue;
    signal.color = color;
    for (const at of signal.cells) packed.texels[at + 2] = color;
    changed |= FixtureSignalChange.vehicle;
  }
  return changed;
}

export function updatePedestrianVisibility(
  packed: PackedFixtures,
  cols: number,
  visible?: (c: number, r: number) => boolean,
) {
  const shown = packed.pedestrians.some((p) =>
    p.cells.some(
      (at) =>
        packed.texels[at + 3]! > 0 &&
        (!visible || visible((at / 4) % cols, Math.floor(at / 4 / cols))),
    ),
  );
  if (shown) packed.visibility.pedestrianSignals = true;
  else delete packed.visibility.pedestrianSignals;
}

/**
 * R/G encode a ten-bit glyph and fixture part, B lamp condition/seed, signal phase or cloth shading, A opacity.
 * Geometry is in meters, with readable minimum housings. A position-seeded dissolve switches
 * whole fixtures between compact and detailed plans from z18 to z18.5.
 */
export function packFixtures(
  out: Uint8Array,
  grid: FixtureGrid,
  fixtures: readonly StreetFixture[],
  zoom: number,
  glyphIndex: (glyph: string) => number,
  clock: number,
  motion: FixtureMotion = { time: 0, strength: 0 },
  utilityScratch?: UtilityPackingScratch,
  scratch?: FixturePackingScratch,
): PackedFixtures {
  out.fill(0);
  const owners = new Int32Array(grid.cols * grid.rows).fill(-1);
  const packed: PackedFixtures = {
    seasonalCells: 0,
    texels: out,
    visibility: { streetlights: false, trafficSignals: false, utilities: false },
    signals: [],
    pedestrians: [],
    utilityCells: [],
    flags: [],
    cloth: {
      cols: grid.cols,
      rows: grid.rows,
      owners,
      cells: [],
      glyphs: { block: glyphIndex('█'), sun: glyphIndex('☼'), star: glyphIndex('★') },
      frame: NaN,
      strength: NaN,
    },
  };
  // Signal lenses own their cells before streetlight arms. Only heads on the same authored
  // lantern post share hardware ownership, so their short brackets may meet at the base.
  const ordered = [
    ...fixtures.filter((f) => f.kind === 'signal'),
    ...fixtures.filter((f) => f.kind === 'streetlight'),
    ...fixtures.filter((f) => f.kind === 'flagpole'),
  ];
  const posts = new Map<string, number>();
  for (const [index, fixture] of ordered.entries()) {
    let owner = index;
    if (fixture.kind === 'streetlight' && fixture.site && fixture.style === 'lantern') {
      const key = fixture.base.join(',');
      owner = posts.get(key) ?? index;
      posts.set(key, owner);
    }
    const min =
      fixture.kind === 'flagpole'
        ? 18
        : fixture.kind === 'streetlight'
          ? fixture.site
            ? 18
            : 15
          : 17;
    if (zoom < min) continue;
    const opacity = bandVisibility({ min }, zoom);
    if (opacity <= 0) continue;
    const base = grid.toCell(...fixture.base);
    const tip = grid.toCell(...fixture.tip);
    const forward = grid.toCell(...fixture.forward),
      right = grid.toCell(...fixture.right);
    const ax = forward[0] - base[0],
      ay = forward[1] - base[1];
    const bx = right[0] - base[0],
      by = right[1] - base[1];
    const length = Math.hypot(ax, ay),
      breadth = Math.hypot(bx, by);
    if (!Number.isFinite(length + breadth) || length < 1e-9 || breadth < 1e-9) continue;
    const detail = Math.max(0, Math.min(1, (zoom - 18) / 0.5));
    const detailed =
      detail >= 1 ||
      (detail > 0 && (placeSeed(fixture.seed, fixture.seed + 1) & 255) / 256 < detail);
    const signal: SignalCells | undefined =
      fixture.kind === 'signal'
        ? {
            seed: fixture.seed,
            group: fixture.group,
            midBlock: fixture.midBlock,
            cells: [],
            color: signalColor[signalState(fixture.seed, clock, fixture.midBlock)[fixture.group]],
            emitters: [],
            direction:
              (Math.round(
                (Math.atan2(by * grid.cellHeight, bx * grid.cellWidth) * 256) / (2 * Math.PI),
              ) +
                256) %
              256,
          }
        : undefined;
    const info =
      fixture.kind === 'streetlight'
        ? lightByte(fixture.state, fixture.seed)
        : (signal?.color ?? 0);
    const write = (x: number, y: number, glyph: string, part: number, tone = info) => {
      const c = Math.floor(x),
        r = Math.floor(y);
      if (c < 0 || r < 0 || c >= grid.cols || r >= grid.rows) return;
      const cell = r * grid.cols + c,
        at = cell * 4;
      if (owners[cell] !== -1 && owners[cell] !== owner) return;
      const code = glyphIndex(glyph);
      if (code <= 0 || code > MAX_GLYPHS) return;
      owners[cell] = owner;
      [out[at], out[at + 1]] = packGlyph(code, part);
      out[at + 2] = tone;
      out[at + 3] = Math.round(opacity * 255);
      if (signal) signal.cells.push(at);
      if (fixture.kind !== 'flagpole' && (!grid.visible || grid.visible(c, r)))
        packed.visibility[fixture.kind === 'signal' ? 'trafficSignals' : 'streetlights'] = true;
    };
    // Avoid expensive offscreen loops, including malformed geometry.
    const line = (from: Point, to: Point, part: number) => {
      const dx = to[0] - from[0],
        dy = to[1] - from[1];
      const steps = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) * 2);
      if (steps > 512) return;
      const px = dx * grid.cellWidth,
        py = dy * grid.cellHeight;
      const glyph =
        Math.abs(py) < Math.abs(px) * 0.4
          ? '─'
          : Math.abs(px) < Math.abs(py) * 0.4
            ? '│'
            : px * py < 0
              ? '╱'
              : '╲';
      for (let i = 0; i <= steps; i++) {
        const t = steps ? i / steps : 0;
        write(from[0] + dx * t, from[1] + dy * t, glyph, part);
      }
    };
    if (fixture.kind === 'flagpole') {
      // A symbolic elevation anchored to the map position. The taller shaft, stepped
      // plinth and folded cloth remain readable on the rectangular ASCII cell grid.
      const rows = zoom >= 20 ? 6 : 3;
      const cols = Math.round((rows * grid.cellHeight * 2) / grid.cellWidth);
      const x = Math.floor(base[0]),
        y = Math.floor(base[1]);
      const top = y - rows - (zoom >= 20 ? 8 : 4);
      for (let r = top - 1; r <= y - 1; r++) write(x, r, '\u2551', FixturePart.flagMast);
      write(x, top - 2, '\u2022', FixturePart.flagMast);
      // A light tapered pedestal, a broad foot, and a bright cap around the pole.
      for (let c = -2; c <= 2; c++) write(x + c, y + 1, '\u2584', FixturePart.flagFoot);
      for (let c = -1; c <= 1; c++) {
        write(x + c, y, '\u2588', FixturePart.flagPlinth);
        write(x + c, y - 1, '\u2580', FixturePart.flagMast);
      }
      // Keep off-grid poles out of the animation cache.
      if (x + cols >= 0 && x + 1 < grid.cols && top + rows + 4 >= 0 && top - 4 < grid.rows)
        packed.flags.push({
          x,
          top,
          rows,
          cols,
          seed: fixture.seed,
          opacity: Math.round(opacity * 255),
        });
      continue;
    }
    if (!detailed) {
      let [x, y] = base;
      if (fixture.kind === 'streetlight') {
        // The compact lamp remains outside the one-cell-wide road, as before.
        const [mx, my] = grid.toCell(...fixture.roadCenter);
        const side = Math.hypot(x - mx, y - my);
        if (side > 0 && side < SIDE_CELLS) {
          x = mx + ((x - mx) / side) * SIDE_CELLS;
          y = my + ((y - my) / side) * SIDE_CELLS;
        }
      }
      write(
        x,
        y,
        fixture.kind === 'streetlight' ? '*' : '•',
        fixture.kind === 'streetlight' ? FixturePart.lamp : FixturePart.signal,
      );
    } else {
      const lantern = fixture.kind === 'streetlight' && fixture.style === 'lantern';
      const long = lantern
        ? Math.max(0.45 * length, 1.1)
        : Math.max(
            fixture.kind === 'streetlight' ? 1.2 * length : 2.2 * length,
            fixture.kind === 'streetlight' ? 2 : 5,
          );
      // Leave a visible casing on either side of the lens/glass strip at close zoom.
      const wide = lantern ? Math.max(0.45 * breadth, 1.1) : Math.max(0.65 * breadth, 2.1);
      const arm: Point = [tip[0] - base[0], tip[1] - base[1]];
      const reach = Math.hypot(...arm);
      const armScale = reach > 0 ? Math.max(1, (long / 2 + (lantern ? 0.65 : 1.5)) / reach) : 0;
      const head: Point = [base[0] + arm[0] * armScale, base[1] + arm[1] * armScale];
      line(base, head, FixturePart.arm);
      write(...base, '▪', FixturePart.base);
      const a: Point = [ax / length, ay / length],
        b: Point = [bx / breadth, by / breadth];
      const det = a[0] * b[1] - a[1] * b[0];
      if (Math.abs(det) < 1e-9) continue;
      const cx = Math.floor(head[0]) + 0.5,
        cy = Math.floor(head[1]) + 0.5;
      const rx = (Math.abs(a[0]) * long + Math.abs(b[0]) * wide) / 2;
      const ry = (Math.abs(a[1]) * long + Math.abs(b[1]) * wide) / 2;
      if ((rx * 2 + 3) * (ry * 2 + 3) > 20000) continue;
      const inside = (c: number, r: number) => {
        const dx = c + 0.5 - cx,
          dy = r + 0.5 - cy;
        const u = (dx * b[1] - dy * b[0]) / det,
          v = (dy * a[0] - dx * a[1]) / det;
        return Math.abs(u) <= long / 2 && Math.abs(v) <= wide / 2;
      };
      const boundary = (c: number, r: number) =>
        inside(c, r) &&
        (!inside(c, r - 1) || !inside(c + 1, r) || !inside(c, r + 1) || !inside(c - 1, r));
      for (
        let r = Math.max(0, Math.floor(cy - ry));
        r <= Math.min(grid.rows - 1, Math.ceil(cy + ry));
        r++
      ) {
        for (
          let c = Math.max(0, Math.floor(cx - rx));
          c <= Math.min(grid.cols - 1, Math.ceil(cx + rx));
          c++
        ) {
          if (!inside(c, r)) continue;
          if (!boundary(c, r)) {
            write(c + 0.5, r + 0.5, '█', FixturePart.casing);
          } else {
            const mask =
              Number(boundary(c, r - 1)) |
              (Number(boundary(c + 1, r)) << 1) |
              (Number(boundary(c, r + 1)) << 2) |
              (Number(boundary(c - 1, r)) << 3);
            write(c + 0.5, r + 0.5, wallGlyph('single', mask), FixturePart.housing);
          }
        }
      }
      if (fixture.kind === 'streetlight') {
        if (lantern) {
          write(cx, cy, '*', FixturePart.lamp);
        } else {
          const spacing = Math.max(0.5, (long - 1) / 2);
          line(
            [cx - a[0] * spacing, cy - a[1] * spacing],
            [cx + a[0] * spacing, cy + a[1] * spacing],
            FixturePart.lamp,
          );
        }
      } else {
        // Three separate lens glyphs; darkness of the inactive lenses distinguishes the phase.
        const pitch = Math.max(1.1, (long - 2) / 3);
        for (let lens = 0; lens < 3; lens++) {
          const offset = (lens - 1) * pitch;
          write(cx + a[0] * offset, cy + a[1] * offset, '○', FixturePart.red + lens);
        }
      }
    }
    if (signal?.cells.length) {
      signal.emitters = [...new Set(signal.cells)].filter((at) => {
        const part = out[at + 1]! & 63;
        return (
          part === FixturePart.signal || (part >= FixturePart.red && part <= FixturePart.green)
        );
      });
      packed.signals.push(signal);
    }
  }
  for (const fixture of fixtures) {
    if (fixture.kind !== 'pedestrian-signal') continue;
    const detail = Math.max(0, Math.min(1, (zoom - 18) / 0.5));
    if (
      detail === 0 ||
      (detail < 1 && (placeSeed(fixture.seed, fixture.seed + 1) & 255) / 256 >= detail)
    )
      continue;
    const [bc, br] = grid.toCell(...fixture.base),
      baseC = Math.floor(bc),
      baseR = Math.floor(br);
    if (
      !Number.isFinite(baseC + baseR) ||
      baseC + 12 < 1 ||
      baseC - 12 >= grid.cols - 1 ||
      baseR + 12 < 5 ||
      baseR - 12 >= grid.rows
    )
      continue;
    const fits = (dx: number, dy: number) => {
      const c = baseC + dx,
        r = baseR + dy;
      if (c < 1 || c >= grid.cols - 1 || r < 5 || r >= grid.rows) return false;
      for (let row = r - 5; row <= r - 2; row++)
        for (let col = c - 1; col <= c + 1; col++)
          if (owners[row * grid.cols + col] !== -1) return false;
      return owners[(r - 1) * grid.cols + c] === -1 && owners[r * grid.cols + c] === -1;
    };
    const plan = (dx: number, dy: number) => {
      const c = baseC + dx,
        r = baseR + dy,
        cells: { c: number; r: number; glyph: string; part: number }[] = [];
      for (let row = 0; row < 4; row++)
        for (let col = -1; col <= 1; col++) {
          const lens = col === 0 && (row === 1 || row === 2);
          cells.push({
            c: c + col,
            r: r - 5 + row,
            glyph: lens ? (row === 1 ? PED_STOP : PED_WALK) : col === 0 ? '─' : '│',
            part: lens
              ? row === 1
                ? FixturePart.pedestrianStop
                : FixturePart.pedestrianWalk
              : FixturePart.housing,
          });
        }
      cells.push(
        { c, r: r - 1, glyph: '│', part: FixturePart.arm },
        { c, r, glyph: '▪', part: FixturePart.base },
      );
      return cells;
    };
    let chosen: ReturnType<typeof plan> | undefined;
    for (let radius = 0; radius <= 12 && !chosen; radius++)
      for (let dy = -radius; dy <= radius && !chosen; dy++)
        for (let dx = -radius; dx <= radius; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
          if (fits(dx, dy)) {
            chosen = plan(dx, dy);
            break;
          }
        }
    if (
      !chosen ||
      chosen.some((cell) => glyphIndex(cell.glyph) <= 0 || glyphIndex(cell.glyph) > MAX_GLYPHS)
    )
      continue;
    const state = pedestrianTexelState(fixture.seed, clock, fixture.midBlock, fixture.group);
    const ped = {
      seed: fixture.seed,
      group: fixture.group,
      midBlock: fixture.midBlock,
      cells: [] as number[],
      state,
    };
    for (const { c, r, glyph, part } of chosen) {
      const at = (r * grid.cols + c) * 4,
        code = glyphIndex(glyph);
      owners[r * grid.cols + c] = ordered.length + packed.pedestrians.length;
      [out[at], out[at + 1]] = packGlyph(code, part);
      out[at + 2] = state;
      out[at + 3] = Math.round(bandVisibility({ min: 17 }, zoom) * 255);
      if (part === FixturePart.pedestrianStop || part === FixturePart.pedestrianWalk)
        ped.cells.push(at);
    }
    packed.pedestrians.push(ped);
  }
  updatePedestrianVisibility(packed, grid.cols, grid.visible);
  const utilities = fixtures.filter(
    (f): f is UtilityFixture => f.kind === 'utility-pole' || f.kind === 'utility-span',
  );
  if (utilities.length && utilityOpacity(zoom) > 0) {
    const sharedBases = new Map<string, number>();
    for (const [owner, fixture] of ordered.entries()) {
      if (fixture.kind !== 'streetlight' || !fixture.supportKey) continue;
      const [x, y] = grid.toCell(...fixture.base);
      const c = Math.floor(x),
        r = Math.floor(y),
        cell = r * grid.cols + c;
      if (
        c >= 0 &&
        c < grid.cols &&
        r >= 0 &&
        r < grid.rows &&
        owners[cell] === owner &&
        (out[cell * 4 + 1]! & 63) === FixturePart.base
      )
        sharedBases.set(fixture.supportKey, cell);
    }
    packed.utilityCells = packUtilityFixtures(
      out,
      grid,
      utilities,
      zoom,
      glyphIndex,
      sharedBases,
      utilityScratch,
    );
  }
  packed.visibility.utilities = utilityViewportVisibility(
    packed.utilityCells,
    grid.cols,
    grid.visible,
  );
  // Animated cloth must retain the utility cells stamped after legacy hardware.
  for (const cell of packed.utilityCells) owners[cell] = -2;
  updateFixtureFlags(packed, motion);
  let seasonal = seasonalInputs.get(fixtures);
  if (!seasonal) {
    seasonal = fixtures.filter(isSeasonalFixture);
    seasonalInputs.set(fixtures, seasonal);
  }
  if (seasonal.length) {
    // Reserve every possible cloth position for decoration admission, while leaving
    // the real cloth owners free for subsequent animation frames.
    if (scratch && scratch.seasonalAdmission.length !== owners.length)
      scratch.seasonalAdmission = new Int32Array(owners.length);
    const admission = scratch?.seasonalAdmission ?? new Int32Array(owners.length);
    admission.set(owners);
    for (const flag of packed.flags) {
      const lift = Math.ceil(flag.rows / 2 + 1);
      for (
        let y = Math.max(0, flag.top - lift);
        y < Math.min(grid.rows, flag.top + flag.rows + lift);
        y++
      )
        for (let x = Math.max(0, flag.x + 1); x < Math.min(grid.cols, flag.x + 1 + flag.cols); x++)
          if (admission[y * grid.cols + x] === -1) admission[y * grid.cols + x] = -4;
    }
    packed.visibility.seasonal = packSeasonalFixtures(
      out,
      grid,
      seasonal,
      zoom,
      glyphIndex,
      admission,
      () => {
        packed.seasonalCells = (packed.seasonalCells ?? 0) + 1;
      },
    );
    for (let cell = 0; cell < admission.length; cell++)
      if (admission[cell] === -3 || admission[cell] === -5) owners[cell] = -3;
  }
  return packed;
}

export type SignalLightGrid = Pick<FixtureGrid, 'cols' | 'rows' | 'cellWidth' | 'cellHeight'> & {
  dpr: number;
};

/**
 * R/G point to the source cell (signed offsets biased by 128), B is direction, A occupancy.
 * Cache the maximum nighttime footprint; the shader varies length and strength with daylight.
 * One strongest active emitter owns each cell, avoiding a full-resolution neighborhood scan.
 */
export function packSignalLights(
  out: Uint8Array,
  packed: PackedFixtures,
  grid: SignalLightGrid,
  scores: Float32Array = new Float32Array(grid.cols * grid.rows),
): void {
  out.fill(0);
  scores.fill(0);
  const { cols, rows, cellWidth: cw, cellHeight: ch, dpr } = grid;
  if (!Number.isFinite(cw + ch + dpr) || cw <= 0 || ch <= 0 || dpr <= 0) return;
  const length = SIGNAL_LIGHT.nightLength * dpr;
  const radius = SIGNAL_LIGHT.haloRadius * dpr;
  const half = SIGNAL_LIGHT.halfWidth * dpr;
  const reach = Math.max(radius, Math.hypot(length, half + length * SIGNAL_LIGHT.spread));
  const padding = Math.hypot(cw, ch) / 2;
  const smooth = (t: number) => {
    const v = Math.max(0, Math.min(1, t));
    return v * v * (3 - 2 * v);
  };
  for (const signal of packed.signals) {
    const angle = (signal.direction * Math.PI * 2) / 256;
    const hx = Math.cos(angle),
      hy = Math.sin(angle);
    for (const source of signal.emitters) {
      const part = packed.texels[source + 1]! & 63;
      if (part !== FixturePart.signal && part - FixturePart.red !== signal.color) continue;
      const index = source / 4,
        sc = index % cols,
        sr = Math.floor(index / cols);
      const cx = (sc + 0.5) * cw,
        cy = (sr + 0.5) * ch;
      for (
        let r = Math.max(0, Math.floor((cy - reach) / ch));
        r <= Math.min(rows - 1, Math.floor((cy + reach) / ch));
        r++
      ) {
        for (
          let c = Math.max(0, Math.floor((cx - reach) / cw));
          c <= Math.min(cols - 1, Math.floor((cx + reach) / cw));
          c++
        ) {
          const dx = (c + 0.5) * cw - cx,
            dy = (r + 0.5) * ch - cy;
          const distance = Math.hypot(dx, dy);
          const forward = dx * hx + dy * hy,
            across = Math.abs(-dx * hy + dy * hx);
          const width = half + Math.max(0, Math.min(length, forward)) * SIGNAL_LIGHT.spread;
          // Include cells straddling the thin ray or halo; the shader clips each pixel exactly.
          const nearHalo = distance < radius + padding;
          const nearBeam =
            forward > -padding && forward < length + padding && across < width + padding;
          if (!nearHalo && !nearBeam) continue;
          const halo = (1 - smooth(distance / radius)) ** 2 * SIGNAL_LIGHT.haloStrength;
          const beam =
            forward >= 0 && forward < length
              ? (1 - smooth(forward / length)) *
                (1 - smooth(across / width)) *
                SIGNAL_LIGHT.nightStrength
              : 0;
          const score = Math.fround(((halo + beam + 1e-6) * packed.texels[source + 3]!) / 255);
          const cell = r * cols + c;
          if (score <= scores[cell]!) continue;
          const ox = sc - c,
            oy = sr - r;
          if (Math.abs(ox) > 127 || Math.abs(oy) > 127) continue;
          scores[cell] = score;
          const at = cell * 4;
          out[at] = ox + 128;
          out[at + 1] = oy + 128;
          out[at + 2] = signal.direction;
          out[at + 3] = 255;
        }
      }
    }
  }
}
