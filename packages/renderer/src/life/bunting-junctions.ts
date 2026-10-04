import { METERS_PER_DEGREE } from '@atlas/shared';
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
type Fixture = Row | { kind: 'season-lantern' | 'season-installation' };
export type ProjectedBunting = { from: Point; to: Point };
export type BuntingProjection = {
  scale: string;
  toCell: (lng: number, lat: number) => Point;
  /** Fixed lower zoom, with uniform scaling to the current zoom. Cell aspect belongs in key. */
  base?: { key: string; scale: number; toCell: (lng: number, lat: number) => Point };
};
type Grid = { toCell: BuntingProjection['toCell']; buntingProjection?: BuntingProjection };
const admitted = new WeakMap<readonly Fixture[], { scale: string; rows: readonly Row[] }>();
const ordered = new WeakMap<readonly Fixture[], readonly Row[]>();
type CandidateGeometry = {
  rows: readonly Row[];
  origin: Point;
  base: readonly ProjectedBunting[];
  spans: ProjectedBunting[];
  candidates: readonly number[][];
  valid: Uint8Array;
  accepted: Uint8Array;
};
const prepared = new WeakMap<readonly Fixture[], { key: string; geometry: CandidateGeometry }>();
const BUCKET = 16;
// A one-cell square glyph fits in this circle; two rows need twice this clearance.
const RADIUS = Math.SQRT1_2;
const CLEARANCE2 = 2;

/** Quantize physical width so projection roundoff does not decide equal-width junctions. */
export function buntingWidth(from: Point, to: Point): number {
  const latitude = ((from[1] + to[1]) / 2) * (Math.PI / 180);
  return (
    Math.round(
      Math.hypot((to[0] - from[0]) * Math.cos(latitude), to[1] - from[1]) * METERS_PER_DEGREE * 10,
    ) / 10
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

function buckets(span: ProjectedBunting, visit: (x: number, y: number) => void) {
  // Each hanging span shifts 1.5 cells. This envelope covers shifts and glyph clearance
  // at the base zoom and every larger scale, irrespective of which rows get admitted.
  const padding = 1.5 + RADIUS;
  const minX = Math.floor((Math.min(span.from[0], span.to[0]) - padding) / BUCKET);
  const maxX = Math.floor((Math.max(span.from[0], span.to[0]) + padding) / BUCKET);
  const minY = Math.floor((Math.min(span.from[1], span.to[1]) - padding) / BUCKET);
  const maxY = Math.floor((Math.max(span.from[1], span.to[1]) + padding) / BUCKET);
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) visit(x, y);
}

function prepareCandidates(
  fixtures: readonly Fixture[],
  toCell: Grid['toCell'],
): CandidateGeometry {
  let rows = ordered.get(fixtures);
  if (!rows) {
    const all = fixtures.filter((f): f is Row => f.kind === 'season-bunting');
    rows = [...all.filter((r) => r.priority).sort(compare), ...all.filter((r) => !r.priority)];
    ordered.set(fixtures, rows);
  }
  const base = rows.map((row) => ({ from: toCell(...row.from), to: toCell(...row.to) }));
  const first = base.find((s) => Number.isFinite(s.from[0]) && Number.isFinite(s.from[1]));
  const origin: Point = [first?.from[0] ?? 0, first?.from[1] ?? 0];
  for (const s of base)
    for (const p of [s.from, s.to]) {
      p[0] -= origin[0];
      p[1] -= origin[1];
    }
  const valid = new Uint8Array(rows.length);
  const seen = new Uint32Array(rows.length);
  const candidates: number[][] = rows.map(() => []);
  const spatial = new Map<number, Map<number, number[]>>();
  for (let i = 0; i < rows.length; i++) {
    const span = base[i]!;
    if (
      !Number.isFinite(span.from[0]) ||
      !Number.isFinite(span.from[1]) ||
      !Number.isFinite(span.to[0]) ||
      !Number.isFinite(span.to[1])
    )
      continue;
    valid[i] = 1;
    if (!rows[i]!.priority) continue;
    const dx = span.to[0] - span.from[0],
      dy = span.to[1] - span.from[1];
    buckets(span, (x, y) => {
      for (const j of spatial.get(x)?.get(y) ?? []) {
        if (seen[j] === i + 1) continue;
        seen[j] = i + 1;
        const other = base[j]!;
        const ox = other.to[0] - other.from[0],
          oy = other.to[1] - other.from[1];
        if (Math.abs(dx * oy - dy * ox) > Math.hypot(dx, dy) * Math.hypot(ox, oy) * 1e-3)
          candidates[i]!.push(j);
      }
    });
    buckets(span, (x, y) => {
      let column = spatial.get(x);
      if (!column) spatial.set(x, (column = new Map<number, number[]>()));
      let bucket = column.get(y);
      if (!bucket) column.set(y, (bucket = []));
      bucket.push(i);
    });
  }
  return {
    rows,
    origin,
    base,
    candidates,
    valid,
    accepted: new Uint8Array(rows.length),
    spans: rows.map(() => ({ from: [0, 0], to: [0, 0] })),
  };
}

function admit(geometry: CandidateGeometry, scale: number): Row[] {
  const { rows, base, spans, candidates, valid, accepted } = geometry;
  accepted.fill(0);
  const result: Row[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (!valid[i]) continue;
    const source = base[i]!,
      span = spans[i]!;
    const dx = source.to[0] - source.from[0],
      dy = source.to[1] - source.from[1];
    const length = Math.hypot(dx, dy) || 1;
    const ox = (-dy / length) * 1.5,
      oy = (dx / length) * 1.5;
    span.from[0] = source.from[0] * scale + ox;
    span.from[1] = source.from[1] * scale + oy;
    span.to[0] = source.to[0] * scale + ox;
    span.to[1] = source.to[1] * scale + oy;
    let blocked = false;
    for (const j of candidates[i]!)
      if (accepted[j] && conflict(span, spans[j]!)) {
        blocked = true;
        break;
      }
    if (blocked) continue;
    accepted[i] = 1;
    result.push(rows[i]!);
  }
  return result;
}

/** Full unclipped spans make admission invariant under panning, including offscreen junctions.
 * With a canonical projection, admission is cached at the latest scale per fixture identity.
 * Panning only projects accepted rows; callers without scale metadata use uncached admission.
 * Calendars without corridor priorities keep their original packing behavior.
 */
export function selectBuntingRows(
  fixtures: readonly Fixture[],
  grid: Grid,
): Map<Row, ProjectedBunting> {
  const projection = grid.buntingProjection;
  if (projection) {
    const scaleKey = `${projection.scale}/${projection.base?.key ?? ''}`;
    let cache = admitted.get(fixtures);
    if (!cache || cache.scale !== scaleKey) {
      // Canonical coordinates have no grid-origin translation; offscreen rows still compete.
      const base = projection.base;
      let geometry: CandidateGeometry;
      if (base && base.scale >= 1) {
        let entry = prepared.get(fixtures);
        if (!entry || entry.key !== base.key) {
          entry = { key: base.key, geometry: prepareCandidates(fixtures, base.toCell) };
          prepared.set(fixtures, entry);
        }
        geometry = entry.geometry;
      } else geometry = prepareCandidates(fixtures, projection.toCell);
      cache = { scale: scaleKey, rows: admit(geometry, base && base.scale >= 1 ? base.scale : 1) };
      admitted.set(fixtures, cache);
    }
    return new Map(cache.rows.map((row) => [row, projectBunting(row, grid)]));
  }
  const geometry = prepareCandidates(fixtures, grid.toCell);
  admit(geometry, 1);
  const result = new Map<Row, ProjectedBunting>();
  for (let i = 0; i < geometry.rows.length; i++)
    if (geometry.accepted[i]) {
      const s = geometry.spans[i]!,
        [x, y] = geometry.origin;
      result.set(geometry.rows[i]!, {
        from: [s.from[0] + x, s.from[1] + y],
        to: [s.to[0] + x, s.to[1] + y],
      });
    }
  return result;
}
