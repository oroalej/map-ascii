/** Resolve whole hanging rows before cell ownership can leave two partial directions. */
type Point = [number, number];
export type BuntingPriority = { width: number; corridor: number; road: string };
type Row = {
  kind: 'season-bunting';
  id: string;
  from: Point;
  to: Point;
  style?: 'red-yellow-rectangles';
  priority?: BuntingPriority;
};
type Fixture = Row | { kind: 'season-lantern' };
export type ProjectedBunting = { from: Point; to: Point };
type Grid = { toCell: (lng: number, lat: number) => Point };
const ordered = new WeakMap<readonly Fixture[], readonly Row[]>();
const BUCKET = 16;
// A one-cell square glyph fits in this circle; two rows need twice this clearance.
const RADIUS = Math.SQRT1_2;
const CLEARANCE2 = 2;

/** Quantize physical width so projection roundoff does not decide equal-width junctions. */
export function buntingWidth(from: Point, to: Point): number {
  const latitude = ((from[1] + to[1]) / 2) * (Math.PI / 180);
  return (
    Math.round(Math.hypot((to[0] - from[0]) * Math.cos(latitude), to[1] - from[1]) * 1113200) / 10
  );
}

function compare(a: Row, b: Row): number {
  const ap = a.priority!,
    bp = b.priority!;
  return (
    Number(!!b.style) - Number(!!a.style) ||
    bp.width - ap.width ||
    ap.corridor - bp.corridor ||
    a.priority!.road.localeCompare(b.priority!.road) ||
    a.id.localeCompare(b.id)
  );
}

export function projectBunting(row: Row, grid: Grid): ProjectedBunting {
  const from = grid.toCell(...row.from),
    to = grid.toCell(...row.to);
  const dx = to[0] - from[0],
    dy = to[1] - from[1],
    length = Math.hypot(dx, dy) || 1;
  const ox = (-dy / length) * 1.5,
    oy = (dx / length) * 1.5;
  return { from: [from[0] + ox, from[1] + oy], to: [to[0] + ox, to[1] + oy] };
}

function distance2(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0],
    dy = b[1] - a[1],
    length2 = dx * dx + dy * dy;
  const u = length2
    ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2))
    : 0;
  return (p[0] - a[0] - u * dx) ** 2 + (p[1] - a[1] - u * dy) ** 2;
}

function conflict(a: ProjectedBunting, b: ProjectedBunting): boolean {
  const ax = a.to[0] - a.from[0],
    ay = a.to[1] - a.from[1];
  const bx = b.to[0] - b.from[0],
    by = b.to[1] - b.from[1];
  const cross = ax * by - ay * bx;
  // Parallel rows along the same street remain eligible at every zoom.
  if (Math.abs(cross) <= Math.hypot(ax, ay) * Math.hypot(bx, by) * 1e-3) return false;
  const dx = b.from[0] - a.from[0],
    dy = b.from[1] - a.from[1];
  const u = (dx * by - dy * bx) / cross,
    v = (dx * ay - dy * ax) / cross;
  if (u >= 0 && u <= 1 && v >= 0 && v <= 1) return true;
  return (
    Math.min(
      distance2(a.from, b.from, b.to),
      distance2(a.to, b.from, b.to),
      distance2(b.from, a.from, a.to),
      distance2(b.to, a.from, a.to),
    ) <= CLEARANCE2
  );
}

function buckets(span: ProjectedBunting, visit: (key: string) => void) {
  const minX = Math.floor((Math.min(span.from[0], span.to[0]) - RADIUS) / BUCKET);
  const maxX = Math.floor((Math.max(span.from[0], span.to[0]) + RADIUS) / BUCKET);
  const minY = Math.floor((Math.min(span.from[1], span.to[1]) - RADIUS) / BUCKET);
  const maxY = Math.floor((Math.max(span.from[1], span.to[1]) + RADIUS) / BUCKET);
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) visit(`${x}/${y}`);
}

/** Full unclipped spans make admission invariant under panning, including offscreen junctions.
 * Priority order is cached with fixture inputs; only nearby accepted rows are compared per frame.
 * Calendars without corridor priorities keep their original packing behavior.
 */
export function selectBuntingRows(
  fixtures: readonly Fixture[],
  grid: Grid,
): Map<Row, ProjectedBunting> {
  let rows = ordered.get(fixtures);
  if (!rows) {
    const all = fixtures.filter((f): f is Row => f.kind === 'season-bunting');
    rows = [...all.filter((r) => r.priority).sort(compare), ...all.filter((r) => !r.priority)];
    ordered.set(fixtures, rows);
  }
  const accepted = new Map<Row, ProjectedBunting>();
  const spatial = new Map<string, ProjectedBunting[]>();
  for (const row of rows) {
    const span = projectBunting(row, grid);
    if (![...span.from, ...span.to].every(Number.isFinite)) continue;
    if (!row.priority) {
      accepted.set(row, span);
      continue;
    }
    const candidates = new Set<ProjectedBunting>();
    buckets(span, (key) => spatial.get(key)?.forEach((s) => candidates.add(s)));
    if ([...candidates].some((s) => conflict(span, s))) continue;
    accepted.set(row, span);
    buckets(span, (key) => {
      const bucket = spatial.get(key);
      if (bucket) bucket.push(span);
      else spatial.set(key, [span]);
    });
  }
  return accepted;
}
