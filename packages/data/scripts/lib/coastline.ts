/**
 * Sea polygons from OSM coastline ways (DATA.md §3: `natural=coastline` → sea). OSM draws the
 * coastline with land on the left. The ways are stitched into chains; closed chains are
 * islands, and open chains are clipped to the region bbox and closed along its edge into land
 * polygons. The sea is the bbox minus the land.
 */
import type { BBox } from '@atlas/shared';
import { difference, type Geom } from 'polyclip-ts';

export type Position = [number, number];

/** Stitch ways (node id lists) into chains by shared end nodes. */
export function stitch(ways: readonly (readonly number[])[]): { closed: number[][]; open: number[][] } {
  const byStart = new Map<number, number[]>();
  const byEnd = new Map<number, number[]>();
  const closed: number[][] = [];
  const remove = (chain: number[]) => {
    byStart.delete(chain[0]!);
    byEnd.delete(chain[chain.length - 1]!);
  };
  for (const way of ways) {
    if (way.length < 2) continue;
    let chain = [...way];
    for (;;) {
      if (chain[0] === chain[chain.length - 1]) break;
      const before = byEnd.get(chain[0]!);
      if (before && before !== chain) {
        remove(before);
        chain = [...before, ...chain.slice(1)];
        continue;
      }
      const after = byStart.get(chain[chain.length - 1]!);
      if (after && after !== chain) {
        remove(after);
        chain = [...chain, ...after.slice(1)];
        continue;
      }
      break;
    }
    if (chain[0] === chain[chain.length - 1]) {
      closed.push(chain);
    } else {
      byStart.set(chain[0]!, chain);
      byEnd.set(chain[chain.length - 1]!, chain);
    }
  }
  return { closed, open: [...byStart.values()] };
}

/** A clipped stretch of coastline, and whether its ends lie on the bbox edge. */
type Piece = { coords: Position[]; startsOnEdge: boolean; endsOnEdge: boolean };

const inside = ([x, y]: Position, [w, s, e, n]: BBox) => x >= w && x <= e && y >= s && y <= n;

/** Liang–Barsky: the part of segment a→b inside the bbox, as parameters [t0, t1], or null. */
function clipSegment(a: Position, b: Position, [w, s, e, n]: BBox): [number, number] | null {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  let t0 = 0;
  let t1 = 1;
  for (const [p, q] of [
    [-dx, a[0] - w],
    [dx, e - a[0]],
    [-dy, a[1] - s],
    [dy, n - a[1]],
  ] as const) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }
  return [t0, t1];
}

const lerp = (a: Position, b: Position, t: number): Position => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
];

/** Clip a polyline to the bbox, keeping the pieces inside it. */
export function clipLine(line: readonly Position[], bbox: BBox): Piece[] {
  const pieces: Piece[] = [];
  let current: Piece | null = null;
  if (line.length > 0 && inside(line[0]!, bbox)) {
    current = { coords: [line[0]!], startsOnEdge: false, endsOnEdge: false };
  }
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!;
    const b = line[i]!;
    const clip = clipSegment(a, b, bbox);
    if (!clip) continue;
    const [t0, t1] = clip;
    if (!current) {
      current = { coords: [lerp(a, b, t0)], startsOnEdge: true, endsOnEdge: false };
    }
    if (t1 < 1) {
      current.coords.push(lerp(a, b, t1));
      current.endsOnEdge = true;
      pieces.push(current);
      current = null;
    } else {
      current.coords.push(b);
    }
  }
  if (current) pieces.push(current);
  return pieces.filter((p) => p.coords.length >= 2);
}

/** Position of a point on the bbox edge, counter-clockwise from the south-west corner. */
function perimeterT([x, y]: Position, [w, s, e, n]: BBox): number {
  const width = e - w;
  const height = n - s;
  const distances = [Math.abs(y - s), Math.abs(x - e), Math.abs(y - n), Math.abs(x - w)];
  const edge = distances.indexOf(Math.min(...distances));
  if (edge === 0) return x - w;
  if (edge === 1) return width + (y - s);
  if (edge === 2) return width + height + (e - x);
  return 2 * width + height + (n - y);
}

/**
 * Close clipped coastline pieces into land rings: after each piece exits the bbox, walk the
 * edge counter-clockwise (land stays on the left) to the next piece's entry.
 */
function landRings(pieces: Piece[], bbox: BBox): Position[][] {
  const [w, s, e, n] = bbox;
  const width = e - w;
  const height = n - s;
  const perimeter = 2 * (width + height);
  const corners: { t: number; p: Position }[] = [
    { t: 0, p: [w, s] },
    { t: width, p: [e, s] },
    { t: width + height, p: [e, n] },
    { t: 2 * width + height, p: [w, n] },
  ];
  const ahead = (from: number, to: number) => (((to - from) % perimeter) + perimeter) % perimeter;
  const entries = pieces.map((p) => perimeterT(p.coords[0]!, bbox));
  const exits = pieces.map((p) => perimeterT(p.coords[p.coords.length - 1]!, bbox));
  const used = new Set<number>();
  const rings: Position[][] = [];

  for (let start = 0; start < pieces.length; start++) {
    if (used.has(start)) continue;
    const ring: Position[] = [];
    let i = start;
    for (let guard = 0; guard <= pieces.length; guard++) {
      used.add(i);
      ring.push(...pieces[i]!.coords);
      const t = exits[i]!;
      // The next entry counter-clockwise from this exit.
      let next = -1;
      let best = Infinity;
      pieces.forEach((_, j) => {
        if (used.has(j) && j !== start) return;
        const d = ahead(t, entries[j]!);
        if (d < best) {
          best = d;
          next = j;
        }
      });
      if (next < 0) break;
      for (const corner of [...corners].sort((a, b) => ahead(t, a.t) - ahead(t, b.t))) {
        const d = ahead(t, corner.t);
        if (d > 0 && d < best) ring.push(corner.p);
      }
      if (next === start) break;
      i = next;
    }
    ring.push(ring[0]!);
    rings.push(ring);
  }
  return rings;
}

export type SeaResult =
  | { ok: true; sea: Position[][][]; coastlines: Position[][] }
  | { ok: false; reason: string; coastlines: Position[][] };

/**
 * Sea polygons inside `bbox` from coastline ways. `coords` looks up node positions. When the
 * coastline is broken (a chain ends inside the bbox), returns `ok: false` so the caller can
 * draw the coastline as lines only.
 */
export function seaPolygons(
  ways: readonly (readonly number[])[],
  coords: (node: number) => Position | undefined,
  bbox: BBox,
): SeaResult {
  const toLine = (chain: number[]) =>
    chain.map((id) => coords(id)).filter((p): p is Position => p !== undefined);
  const { closed, open } = stitch(ways);
  const islands = closed.map(toLine).filter((r) => r.length >= 4);
  const openLines = open.map(toLine);
  const coastlines = [...islands, ...openLines];
  if (coastlines.length === 0) return { ok: true, sea: [], coastlines };

  const pieces = openLines.flatMap((line) => clipLine(line, bbox));
  const broken = pieces.find((p) => !p.startsOnEdge || !p.endsOnEdge);
  if (broken) {
    const at = broken.startsOnEdge ? broken.coords[broken.coords.length - 1]! : broken.coords[0]!;
    return {
      ok: false,
      reason: `coastline ends inside the region at ${at[0].toFixed(5)}, ${at[1].toFixed(5)}`,
      coastlines,
    };
  }

  const [w, s, e, n] = bbox;
  const box: Geom = [
    [
      [w, s],
      [e, s],
      [e, n],
      [w, n],
      [w, s],
    ],
  ];
  const land: Geom[] = [...landRings(pieces, bbox), ...islands].map((ring) => [ring]);
  const sea = land.length > 0 ? difference(box, ...land) : [];
  return { ok: true, sea, coastlines };
}
