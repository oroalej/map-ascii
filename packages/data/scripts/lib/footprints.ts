import type { LngLat, SiteDetail } from '@atlas/shared';
import { union } from 'polyclip-ts';
import type { MultiPolygon } from 'geojson';
import { localFrame as frame } from './geo';

type MultiPoly = ReturnType<typeof union>;

function strokePieces(points: LngLat[], width: number): LngLat[][][] {
  const half = width / 2;
  const pieces: LngLat[][][] = points.map(([x, y]) => {
    const ring = Array.from({ length: 17 }, (_, i): LngLat => {
      const a = ((i % 16) * Math.PI) / 8;
      return [x + Math.cos(a) * half, y + Math.sin(a) * half];
    });
    return [ring];
  });
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!,
      b = points[i]!;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length === 0) continue;
    const nx = (-(b[1] - a[1]) / length) * half,
      ny = ((b[0] - a[0]) / length) * half;
    pieces.push([
      [
        [a[0] + nx, a[1] + ny],
        [b[0] + nx, b[1] + ny],
        [b[0] - nx, b[1] - ny],
        [a[0] - nx, a[1] - ny],
        [a[0] + nx, a[1] + ny],
      ],
    ]);
  }
  return pieces;
}

/** Union rim and wider bench sections in one meter frame, retaining the planted hole. */
export function seatingFootprint(
  line: LngLat[],
  width: number,
  spans: SiteDetail['seating'][number]['bench_spans'] = [],
): MultiPolygon {
  const f = frame(line[0]!);
  const points = line.map(f.toMeters);
  const pieces = strokePieces(points, width);
  for (const span of spans)
    pieces.push(...strokePieces(points.slice(span.start, span.end + 1), span.width_m));
  // A balanced union avoids thousands of near-coincident edges in one sweep.
  // Round local coordinates to micrometers before clipping (far below tile precision).
  let merged: MultiPoly[] = pieces.map((piece) => [
    piece.map((ring) =>
      ring.map(([x, y]) => [Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6] as LngLat),
    ),
  ]);
  while (merged.length > 1) {
    const next: MultiPoly[] = [];
    for (let i = 0; i < merged.length; i += 2)
      next.push(i + 1 < merged.length ? union(merged[i]!, merged[i + 1]!) : merged[i]!);
    merged = next;
  }
  return {
    type: 'MultiPolygon',
    coordinates: merged[0]!.map((p) => p.map((r) => r.map((p) => f.toLngLat(p)))),
  };
}
