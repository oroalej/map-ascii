/** Pure legacy lamp placement shared by the tile worker and utility pipeline. */
import { DEFAULT_ROAD_WIDTH_M } from './constants';
export type TilePoint = { x: number; y: number };
export const LAMP_PLACEMENT = {
  spacing: 30,
  setback: 0.5,
  minSide: 0.7,
  median: 25,
  minMedian: 2,
  minGap: 12,
} as const;
const STREETLIGHT = LAMP_PLACEMENT;
/** Lamp eligibility follows display road class, including tertiary roads in road_mid. */
export const isLitRoad = (className: unknown, region: unknown): boolean =>
  region !== true && (className === 'road_major' || className === 'road_mid');
/** A lit road line: its points (tile units) and carriageway width, m (0: unknown). */
export type LitLine = { points: readonly TilePoint[]; width: number };

/** A lamp placed along a line or at a junction, before it is kept or dropped. */
export type LampCandidate = {
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
): LampCandidate[] {
  const out: LampCandidate[] = [];
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
function junctionLamps(lines: readonly LitLine[], unitMeters: number): LampCandidate[] {
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
  const out: LampCandidate[] = [];
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
export function inLampMedian(
  lamp: LampCandidate,
  lines: readonly LitLine[],
  unitMeters: number,
): boolean {
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

/** Retained positions in legacy order, with provenance for shared utility supports. */
export function placeLampSupports(
  lines: readonly LitLine[],
  unitMeters: number,
  extent: number,
  origin: TilePoint = { x: 0, y: 0 },
): LampCandidate[] {
  const gap = STREETLIGHT.minGap / unitMeters;
  const kept: LampCandidate[] = [];
  const candidates = [
    ...junctionLamps(lines, unitMeters),
    ...lines.flatMap((line, l) => lampsAlong(line, l, unitMeters, origin)),
  ];
  for (const lamp of candidates) {
    const { x, y } = lamp;
    if (x < 0 || x >= extent || y < 0 || y >= extent) continue;
    if (kept.some((k) => Math.hypot(k.x - x, k.y - y) < gap)) continue;
    if (!lamp.junction && inLampMedian(lamp, lines, unitMeters)) continue;
    kept.push(lamp);
  }
  return kept;
}
