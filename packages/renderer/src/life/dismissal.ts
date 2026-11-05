/**
 * School letting out (SPEC.md §4): students streaming along the road shoulders from each school's
 * gate, thinning with distance, and tricycles waiting at the curb. Like the harvest's actors
 * (life/field-life.ts), they are stateless functions of a shared time and a world-anchored hash: no
 * random stream advances for them, and nothing here can move an existing agent. Most schools have
 * no mapped path but do have a road, so students keep to the road's edge, not the walking lines.
 */
import {
  DISMISSAL,
  metersPerUnit,
  TILE_EXTENT,
  tileToLngLat,
  utilitySeed,
  type TileAddress,
} from '@atlas/shared';
import type { TilePoint } from '../raster/geometry';
import { ROAD_MARGIN_M } from './config';
import { sample } from './exhaust';
import { LifeLine, placeCode, PLACE_STRIDE, type LifeGeometry } from './geometry';
import type { PersonLook } from './people';
import type { VisibleAgent } from './simulate';
import { Paint, VEHICLES } from './vehicles';

export const DISMISSAL_LIFE = {
  /** A school's gate is the nearest road within this, m. */
  gateReach: 80,
  /** Gates this near on one road are one school's, m (a campus maps several buildings). */
  gateMerge: 40,
  students: [12, 30],
  /** Meters of a school's radius that add a student. */
  metersPerStudent: 1.6,
  maxOnScreen: 220,
  speed: [1, 1.4],
  /** How far each walks before they are gone, m: fewer get further, so the stream thins. */
  reach: [100, 400],
  /** Seconds between one walker's going and the next's setting off from the gate. */
  rest: [30, 90],
  /** How far outside a road's edge students walk, m. */
  shoulder: 1,
  /** Most are children in white shirts. */
  childShare: 0.8,
  whiteShare: 0.8,
  otherPaints: [Paint.blue, Paint.sky, Paint.graphite],
  tricycles: [2, 5],
  tricycleGap: 1.5,
} as const;

export const STUDENT_LABEL = 'Student going home (simulated)';
export const TRICYCLE_LABEL = 'Tricycle waiting for students (simulated)';

const ROAD_KINDS: ReadonlySet<number> = new Set([
  LifeLine.roadMajor,
  LifeLine.roadMid,
  LifeLine.roadMinor,
]);

/** A road walked from a gate, in tile units, with meters walked at each point. */
type Way = { xs: number[]; ys: number[]; meters: number[] };
export type SchoolGate = {
  x: number;
  y: number;
  lng: number;
  lat: number;
  /** The road's width, m. */
  width: number;
  line: number;
  seed: number;
  students: number;
  ways: readonly [Way, Way];
};

export type DismissalTile = { tile: TileAddress; geo: LifeGeometry };

/** The way along `line` from a point on its segment after vertex `v`, in direction `dir`. */
function wayFrom(
  geo: LifeGeometry,
  line: number,
  v: number,
  x: number,
  y: number,
  dir: 1 | -1,
  perMeter: number,
): Way {
  const way: Way = { xs: [x], ys: [y], meters: [0] };
  const first = geo.starts[line]!;
  const last = geo.starts[line + 1]! - 1;
  let at = dir === 1 ? v + 1 : v;
  let walked = 0;
  let [px, py] = [x, y];
  while (at >= first && at <= last && walked < DISMISSAL_LIFE.reach[1]) {
    const nx = geo.coords[at * 2]!,
      ny = geo.coords[at * 2 + 1]!;
    walked += Math.hypot(nx - px, ny - py) / perMeter;
    way.xs.push(nx);
    way.ys.push(ny);
    way.meters.push(walked);
    [px, py] = [nx, ny];
    at += dir;
  }
  return way;
}

const gateCache = new WeakMap<LifeGeometry, SchoolGate[]>();
/** Each school's gate: the nearest road's nearest point, worked out once per geometry. */
export function schoolGates({ tile, geo }: DismissalTile): SchoolGate[] {
  const cached = gateCache.get(geo);
  if (cached) return cached;
  const gates: SchoolGate[] = [];
  const perMeter = 1 / metersPerUnit(tile);
  const reach = DISMISSAL_LIFE.gateReach * perMeter;
  const school = placeCode('school');
  const { places, kinds, starts, coords } = geo;
  for (let i = 0; i < places.length; i += PLACE_STRIDE) {
    if (places[i + 2] !== school) continue;
    const px = places[i]!,
      py = places[i + 1]!;
    if (px < 0 || py < 0 || px >= TILE_EXTENT || py >= TILE_EXTENT) continue;
    let best = reach,
      bestLine = -1,
      bestV = 0,
      bestX = 0,
      bestY = 0;
    for (let line = 0; line < kinds.length; line++) {
      if (!ROAD_KINDS.has(kinds[line]!) || geo.navigationOnly?.[line]) continue;
      for (let v = starts[line]!; v + 1 < starts[line + 1]!; v++) {
        const ax = coords[v * 2]!,
          ay = coords[v * 2 + 1]!,
          dx = coords[v * 2 + 2]! - ax,
          dy = coords[v * 2 + 3]! - ay;
        const t = Math.max(
          0,
          Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)),
        );
        const x = ax + dx * t,
          y = ay + dy * t;
        const d = Math.hypot(px - x, py - y);
        if (d < best) [best, bestLine, bestV, bestX, bestY] = [d, line, v, x, y];
      }
    }
    if (bestLine < 0) continue;
    const radius = places[i + 3]! / perMeter;
    const [small, large] = DISMISSAL_LIFE.students;
    const students = Math.min(large, small + Math.floor(radius / DISMISSAL_LIFE.metersPerStudent));
    const merge = DISMISSAL_LIFE.gateMerge * perMeter;
    const near = gates.find(
      (g) => g.line === bestLine && Math.hypot(g.x - bestX, g.y - bestY) <= merge,
    );
    if (near) {
      near.students = Math.max(near.students, students);
      continue;
    }
    const worldX = tile.x * TILE_EXTENT + bestX,
      worldY = tile.y * TILE_EXTENT + bestY;
    const [lng, lat] = tileToLngLat(tile, { x: bestX, y: bestY });
    gates.push({
      x: bestX,
      y: bestY,
      lng,
      lat,
      width: geo.widths[bestLine] ?? 0,
      line: bestLine,
      seed: utilitySeed(`dismissal:${tile.z}/${Math.round(worldX)}/${Math.round(worldY)}`),
      students,
      ways: [
        wayFrom(geo, bestLine, bestV, bestX, bestY, 1, perMeter),
        wayFrom(geo, bestLine, bestV, bestX, bestY, -1, perMeter),
      ],
    });
  }
  gateCache.set(geo, gates);
  return gates;
}

/** Where `meters` along a way falls, and the way it runs there; undefined past its end. */
function along(way: Way, meters: number) {
  const { xs, ys, meters: at } = way;
  for (let i = 1; i < at.length; i++) {
    if (at[i]! < meters) continue;
    const length = at[i]! - at[i - 1]! || 1;
    const t = (meters - at[i - 1]!) / length;
    const dx = xs[i]! - xs[i - 1]!,
      dy = ys[i]! - ys[i - 1]!;
    const norm = Math.hypot(dx, dy) || 1;
    return { x: xs[i - 1]! + dx * t, y: ys[i - 1]! + dy * t, hx: dx / norm, hy: dy / norm };
  }
  return undefined;
}

export type DismissalInput = {
  tiles: readonly DismissalTile[];
  /** Minutes since classes ended (rhythm.ts `dismissalNow`). */
  after: number;
  /** Shared seconds, which keep them walking at a fixed hour too. */
  time: number;
  center: readonly [number, number];
  bounds?: readonly [number, number, number, number] | undefined;
  crowd: number;
  owns?: (tile: DismissalTile, p: TilePoint) => boolean;
};

const inBounds = (bounds: DismissalInput['bounds'], lng: number, lat: number) =>
  !bounds || (lng >= bounds[0] && lng <= bounds[2] && lat >= bounds[1] && lat <= bounds[3]);

function students(
  input: DismissalInput,
  entry: DismissalTile,
  gate: SchoolGate,
  perMeter: number,
  out: VisibleAgent[],
) {
  const { after, time, bounds, crowd } = input;
  const { seed, width } = gate;
  const [slow, fast] = DISMISSAL_LIFE.speed;
  const [near, far] = DISMISSAL_LIFE.reach;
  const [shortRest, longRest] = DISMISSAL_LIFE.rest;
  for (let w = 0; w < gate.students; w++) {
    if (out.length >= DISMISSAL_LIFE.maxOnScreen) return;
    if (sample(seed, w, 7) >= crowd) continue;
    const speed = slow + (fast - slow) * sample(seed, w, 3);
    const reach = near + (far - near) * sample(seed, w, 4);
    const period = reach / speed + shortRest + (longRest - shortRest) * sample(seed, w, 5);
    const phase = time / period + sample(seed, w, 6);
    const age = (phase - Math.floor(phase)) * period;
    const walked = age * speed;
    if (walked >= reach) continue;
    // When this one set off: none set off before classes end or after the stream dries up.
    const release = after - age / 60;
    if (release < 0 || release >= DISMISSAL.release) continue;
    const way = gate.ways[sample(seed, w, 1) < 0.5 ? 0 : 1];
    const at = along(way, walked);
    if (!at) continue;
    const side = sample(seed, w, 2) < 0.5 ? 1 : -1;
    const offset = (width / 2 + DISMISSAL_LIFE.shoulder) * perMeter * side;
    const p = { x: at.x - at.hy * offset, y: at.y + at.hx * offset };
    if (p.x < 0 || p.y < 0 || p.x >= TILE_EXTENT || p.y >= TILE_EXTENT) continue;
    if (input.owns && !input.owns(entry, p)) continue;
    const [lng, lat] = tileToLngLat(entry.tile, p);
    if (!inBounds(bounds, lng, lat)) continue;
    const flap = Math.floor(walked / 0.6) % 2;
    const look: PersonLook = {
      figure: sample(seed, w, 8) < DISMISSAL_LIFE.childShare ? 'child' : 'adult',
      paint:
        sample(seed, w, 9) < DISMISSAL_LIFE.whiteShare
          ? Paint.white
          : DISMISSAL_LIFE.otherPaints[
              Math.floor(sample(seed, w, 10) * DISMISSAL_LIFE.otherPaints.length)
            ]!,
      lateral: 0,
      back: 0,
      flap,
    };
    out.push({
      kind: 'person',
      lng,
      lat,
      ahead: tileToLngLat(entry.tile, {
        x: p.x + at.hx * perMeter,
        y: p.y + at.hy * perMeter,
      }),
      flap,
      people: [look],
      fieldLabel: STUDENT_LABEL,
    });
  }
}

/** A few tricycles at the curb by the gate, each arriving and leaving at its own time. */
function tricycles(
  input: DismissalInput,
  entry: DismissalTile,
  gate: SchoolGate,
  perMeter: number,
  out: VisibleAgent[],
) {
  const { after, bounds, crowd } = input;
  const { seed, width } = gate;
  if (after >= DISMISSAL.tricyclesLeave) return;
  const spec = VEHICLES.tricycle;
  const [few, many] = DISMISSAL_LIFE.tricycles;
  const count = few + Math.floor((many - few + 1) * sample(seed, 0, 11));
  const side = sample(seed, 0, 12) < 0.5 ? 1 : -1;
  const way = gate.ways[side === 1 ? 0 : 1];
  const curb = Math.max(0, width / 2 - spec.width / 2 - ROAD_MARGIN_M) * perMeter * side;
  for (let t = 0; t < count; t++) {
    if (out.length >= DISMISSAL_LIFE.maxOnScreen) return;
    if (sample(seed, t, 15) >= crowd) continue;
    const arrives = -DISMISSAL.tricycleLead + 8 * sample(seed, t, 13);
    const leaves = DISMISSAL.tricyclesLeave - 20 * sample(seed, t, 14);
    if (after < arrives || after >= leaves) continue;
    const at = along(way, (t + 1) * (spec.length + DISMISSAL_LIFE.tricycleGap));
    if (!at) continue;
    const p = { x: at.x - at.hy * curb, y: at.y + at.hx * curb };
    if (p.x < 0 || p.y < 0 || p.x >= TILE_EXTENT || p.y >= TILE_EXTENT) continue;
    if (input.owns && !input.owns(entry, p)) continue;
    const [lng, lat] = tileToLngLat(entry.tile, p);
    if (!inBounds(bounds, lng, lat)) continue;
    const hx = at.hx * side,
      hy = at.hy * side;
    out.push({
      kind: 'vehicle',
      lng,
      lat,
      ahead: tileToLngLat(entry.tile, { x: p.x + hx * perMeter, y: p.y + hy * perMeter }),
      side: tileToLngLat(entry.tile, { x: p.x - hy * perMeter, y: p.y + hx * perMeter }),
      vehicle: 'tricycle',
      paint: spec.paints[Math.floor(sample(seed, t, 16) * spec.paints.length)]!,
      parked: true,
      flap: 0,
      fieldLabel: TRICYCLE_LABEL,
    });
  }
}

/** Everyone leaving school now, nearest school first, up to the cap. */
export function dismissalLife(input: DismissalInput): VisibleAgent[] {
  const { center, bounds } = input;
  const out: VisibleAgent[] = [];
  const [cx, cy] = center;
  // A stream's reach in degrees, generously: 1° is at least 90 km along either axis here.
  const reach = (DISMISSAL_LIFE.reach[1] + DISMISSAL_LIFE.gateReach) / 90_000;
  const gates = input.tiles
    .flatMap((entry) => schoolGates(entry).map((gate) => ({ entry, gate })))
    .filter(
      ({ gate }) =>
        !bounds ||
        (gate.lng >= bounds[0] - reach &&
          gate.lng <= bounds[2] + reach &&
          gate.lat >= bounds[1] - reach &&
          gate.lat <= bounds[3] + reach),
    )
    .map((item) => ({ ...item, d: (item.gate.lng - cx) ** 2 + (item.gate.lat - cy) ** 2 }))
    .sort((a, b) => a.d - b.d || a.gate.seed - b.gate.seed);
  for (const { entry, gate } of gates) {
    if (out.length >= DISMISSAL_LIFE.maxOnScreen) break;
    const perMeter = 1 / metersPerUnit(entry.tile);
    tricycles(input, entry, gate, perMeter, out);
    students(input, entry, gate, perMeter, out);
  }
  return out;
}
