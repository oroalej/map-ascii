/** Geographic scanlines keep conservative crowd masks independent of polygon vertex counts. */
import type { EventGround } from './ground-events';

type Point = [number, number];
type Span = [number, number];
type Ring = { epoch: number; intersections: number[] };
type Edge = {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  south: number;
  north: number;
  slope: number;
  ring: Ring;
};
type RingIndex = { bins: Map<number, Edge[]>; large: Edge[]; epoch: number };
const BIN = 0.00025;
export const THRONG_MASK_SIDE = 16;
export const THRONG_MASK_BITS = THRONG_MASK_SIDE * THRONG_MASK_SIDE;
export const THRONG_MASK_WORDS = THRONG_MASK_BITS / 32;
const SIDE = THRONG_MASK_SIDE;
const MAX_ROWS = 4096;
const EMPTY: Point[][] = [];
const indexes = new WeakMap<Point[][], RingIndex>();
function index(rings: Point[][]) {
  const saved = indexes.get(rings);
  if (saved) return saved;
  const result: RingIndex = { bins: new Map(), large: [], epoch: 0 };
  for (const points of rings) {
    const ring: Ring = { epoch: 0, intersections: [] };
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const a = points[j]!,
        b = points[i]!;
      const edge: Edge = {
        ax: a[0],
        ay: a[1],
        bx: b[0],
        by: b[1],
        south: Math.min(a[1], b[1]),
        north: Math.max(a[1], b[1]),
        slope: a[1] === b[1] ? 0 : (b[0] - a[0]) / (b[1] - a[1]),
        ring,
      };
      const first = Math.floor(edge.south / BIN),
        last = Math.floor(edge.north / BIN);
      if (last - first > MAX_ROWS) {
        result.large.push(edge);
        continue;
      }
      for (let row = first; row <= last; row++) {
        let bin = result.bins.get(row);
        if (!bin) result.bins.set(row, (bin = []));
        bin.push(edge);
      }
    }
  }
  indexes.set(rings, result);
  return result;
}
const spanOrder = (a: Span, b: Span) => a[0] - b[0];
const numberOrder = (a: number, b: number) => a - b;
function merge(spans: Span[]) {
  spans.sort(spanOrder);
  let used = 0;
  for (const span of spans) {
    const previous = spans[used - 1];
    if (previous && span[0] <= previous[1]) previous[1] = Math.max(previous[1], span[1]);
    else spans[used++] = span;
  }
  spans.length = used;
  return spans;
}
function contains(spans: readonly Span[], x: number) {
  let lo = 0,
    hi = spans.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (spans[mid]![1] <= x) lo = mid + 1;
    else hi = mid;
  }
  // Reject boundary contact conservatively; touching permission pieces were merged above.
  return lo < spans.length && spans[lo]![0] < x && x < spans[lo]![1];
}
function overlaps(spans: readonly Span[], west: number, east: number) {
  let lo = 0,
    hi = spans.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (spans[mid]![1] < west) lo = mid + 1;
    else hi = mid;
  }
  return lo < spans.length && spans[lo]![0] <= east;
}
/** Exact horizontal polygon spans, plus all boundary edges crossing a vertical strip. */
function scan(source: RingIndex, latitude: number, south = latitude, north = latitude) {
  const spans: Span[] = [],
    touched: Ring[] = [];
  const first = Math.floor(south / BIN),
    last = Math.floor(north / BIN);
  const groups: Iterable<Edge>[] = [source.large];
  if (first === last) groups.push(source.bins.get(first) ?? []);
  else {
    const edges = new Set<Edge>();
    for (let row = first; row <= last; row++)
      for (const edge of source.bins.get(row) ?? []) edges.add(edge);
    groups.push(edges);
  }
  const epoch = ++source.epoch;
  for (const group of groups)
    for (const edge of group) {
      if (edge.north < south || edge.south > north) continue;
      if (edge.ay > latitude !== edge.by > latitude) {
        const ring = edge.ring;
        if (ring.epoch !== epoch) {
          ring.epoch = epoch;
          ring.intersections.length = 0;
          touched.push(ring);
        }
        ring.intersections.push(edge.ax + (latitude - edge.ay) * edge.slope);
      }
      if (south !== north) {
        const x0 =
          edge.ay === edge.by
            ? edge.ax
            : edge.ax + (Math.max(south, edge.south) - edge.ay) * edge.slope;
        const x1 =
          edge.ay === edge.by
            ? edge.bx
            : edge.ax + (Math.min(north, edge.north) - edge.ay) * edge.slope;
        spans.push([Math.min(x0, x1), Math.max(x0, x1)]);
      }
    }
  for (const ring of touched) {
    ring.intersections.sort(numberOrder);
    for (let i = 1; i < ring.intersections.length; i += 2)
      spans.push([ring.intersections[i - 1]!, ring.intersections[i]!]);
  }
  return merge(spans);
}

type Row = {
  lat: number;
  regions: [Span[], Span[], Span[]];
  bridges: [Span[], Span[], Span[]];
  cover: Span[];
  blocked: Span[];
  water: Span[];
};

function insideCell(spans: Row['regions'], west: number, east: number) {
  return spans.every((line) => {
    let lo = 0,
      hi = line.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (line[mid]![1] <= west) lo = mid + 1;
      else hi = mid;
    }
    return lo < line.length && line[lo]![0] < west && east < line[lo]![1];
  });
}
function lines(source: RingIndex, top: number, lat: number, bottom: number): Row['regions'] {
  return [scan(source, top), scan(source, lat), scan(source, bottom)];
}
/** North-up placement gives exact longitude intervals without per-subcell unprojection. */
export class CrowdMaskRaster {
  private rows = new Map<number, Row>();
  private coverage = new Map<number, Span[]>();
  private longitude: number;
  private step: number;
  private regions: RingIndex;
  private blocked: RingIndex;
  private water: RingIndex;
  private bridges: RingIndex;
  constructor(
    ground: EventGround,
    private fromCell: (col: number, row: number) => Point,
    private originCol = 0,
    private originRow = 0,
  ) {
    const start = fromCell(0, 0),
      end = fromCell(1, 0);
    this.step = (end[0] - start[0]) / SIDE;
    this.longitude = start[0] - originCol * SIDE * this.step;
    this.regions = index(ground.regions);
    this.blocked = index(ground.blocked);
    this.water = index(ground.water ?? EMPTY);
    this.bridges = index(ground.bridges ?? EMPTY);
  }
  private row(subrow: number) {
    const saved = this.rows.get(subrow);
    if (saved) return saved;
    const y = subrow / SIDE - this.originRow;
    const top = this.fromCell(0, y)[1],
      bottom = this.fromCell(0, y + 1 / SIDE)[1];
    const lat = this.fromCell(0, y + 0.5 / SIDE)[1];
    const south = Math.min(top, bottom),
      north = Math.max(top, bottom);
    const result: Row = {
      lat,
      regions: lines(this.regions, top, lat, bottom),
      bridges: lines(this.bridges, top, lat, bottom),
      cover: scan(this.regions, lat, south, north),
      blocked: scan(this.blocked, lat, south, north),
      water: scan(this.water, lat, south, north),
    };
    if (this.rows.size >= MAX_ROWS) this.rows.delete(this.rows.keys().next().value!);
    this.rows.set(subrow, result);
    return result;
  }
  point(col: number, row: number, bit: number, out: Point): Point {
    out[0] = this.longitude + (col * SIDE + (bit % SIDE) + 0.5) * this.step;
    out[1] = this.row(row * SIDE + Math.floor(bit / SIDE)).lat;
    return out;
  }
  hasPoint(col: number, row: number, bit: number) {
    return contains(
      this.row(row * SIDE + Math.floor(bit / SIDE)).regions[1],
      this.longitude + (col * SIDE + (bit % SIDE) + 0.5) * this.step,
    );
  }
  covers(col: number, row: number) {
    let cover = this.coverage.get(row);
    if (!cover) {
      const spans: Span[] = [];
      for (let y = 0; y < SIDE; y++)
        for (const span of this.row(row * SIDE + y).cover) spans.push([span[0], span[1]]);
      cover = merge(spans);
      if (this.coverage.size >= MAX_ROWS / SIDE)
        this.coverage.delete(this.coverage.keys().next().value!);
      this.coverage.set(row, cover);
    }
    const x0 = col * SIDE;
    const wholeWest = this.longitude + x0 * this.step;
    const wholeEast = wholeWest + SIDE * this.step;
    return overlaps(cover, Math.min(wholeWest, wholeEast), Math.max(wholeWest, wholeEast));
  }
  mask(col: number, row: number, allows?: (col: number, row: number) => boolean) {
    if (!this.covers(col, row)) return undefined;
    let words: Uint32Array | undefined;
    const x0 = col * SIDE;
    const wholeWest = this.longitude + x0 * this.step;
    const wholeEast = wholeWest + SIDE * this.step;
    for (let y = 0; y < SIDE; y++) {
      const line = this.row(row * SIDE + y);
      if (!overlaps(line.cover, Math.min(wholeWest, wholeEast), Math.max(wholeWest, wholeEast)))
        continue;
      for (let x = 0; x < SIDE; x++) {
        const a = this.longitude + (x0 + x) * this.step,
          b = a + this.step;
        const west = Math.min(a, b),
          east = Math.max(a, b);
        if (
          !insideCell(line.regions, west, east) ||
          overlaps(line.blocked, west, east) ||
          (overlaps(line.water, west, east) && !insideCell(line.bridges, west, east)) ||
          (allows && !allows(col * SIDE + x, row * SIDE + y))
        )
          continue;
        words ??= new Uint32Array(THRONG_MASK_WORDS);
        const bit = y * SIDE + x;
        words[bit >>> 5]! |= (1 << (bit & 31)) >>> 0;
      }
    }
    return words;
  }
}
