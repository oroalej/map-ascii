/** Static utility fixtures. All topology and support positions are already baked. */
import {
  offsetUtility,
  UTILITY,
  bandVisibility,
  UTILITY_ZOOM,
  UTILITY_DETAIL_ZOOM,
  utilitySeed,
  type UtilityRecord,
  type UtilityPole,
  type UtilitySpan,
  type UtilityPoint,
} from '@atlas/shared';
import { MAX_GLYPHS, packGlyph } from '../glyphs/select';
import type { FixtureGrid } from './fixtures';
import { sameReferenceMembers } from '../cache-inputs';

export const UtilityPart = {
  utilityCap: 17,
  crossarm: 18,
  insulator: 19,
  transformer: 20,
  cable: 21,
  tangle: 22,
} as const;
export type UtilityFixture =
  { kind: 'utility-pole'; pole: UtilityPole } | { kind: 'utility-span'; span: UtilitySpan };

/** Full endpoints make a span independent of the endpoint tiles' residency. */
export function utilityFixtures(records: readonly UtilityRecord[]): UtilityFixture[] {
  const poles = new Map<string, UtilityPole>(),
    spans = new Map<string, UtilitySpan>();
  for (const r of records) {
    if (r.kind === 'pole') poles.set(r.pole.id, r.pole);
    else {
      spans.set(r.span.id, r.span);
      poles.set(r.span.from.id, r.span.from);
      poles.set(r.span.to.id, r.span.to);
    }
  }
  return [
    ...[...poles.values()]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((pole): UtilityFixture => ({ kind: 'utility-pole', pole })),
    ...[...spans.values()]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((span): UtilityFixture => ({ kind: 'utility-span', span })),
  ];
}

/** Cache the merged network only while the contributing payload references remain identical. */
export function createUtilityFixtureCache() {
  let previous: readonly (readonly UtilityRecord[])[] = [],
    result: UtilityFixture[] = [];
  return (groups: readonly (readonly UtilityRecord[])[]) => {
    if (sameReferenceMembers(groups, previous)) return result;
    previous = groups.slice();
    // Conversion already deduplicates poles and spans, including buffered tile copies.
    result = utilityFixtures(groups.flat());
    return result;
  };
}

/** Liang–Barsky clipping, including horizontal/vertical and zero-length segments. */
export function clipUtilityLine(
  a: UtilityPoint,
  b: UtilityPoint,
  cols: number,
  rows: number,
): [UtilityPoint, UtilityPoint] | null {
  if (![...a, ...b].every(Number.isFinite) || cols <= 0 || rows <= 0) return null;
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  let lo = 0,
    hi = 1;
  for (const [p, q] of [
    [-dx, a[0]],
    [dx, cols - 1e-6 - a[0]],
    [-dy, a[1]],
    [dy, rows - 1e-6 - a[1]],
  ] as const) {
    if (p === 0) {
      if (q < 0) return null;
    } else if (p < 0) lo = Math.max(lo, q / p);
    else hi = Math.min(hi, q / p);
  }
  return lo > hi
    ? null
    : [
        [a[0] + dx * lo, a[1] + dy * lo],
        [a[0] + dx * hi, a[1] + dy * hi],
      ];
}
const draw = (seed: number, purpose: string) => utilitySeed(`:${purpose}`, seed) / 0x100000000;

export const utilityOpacity = (zoom: number) =>
  Math.round(bandVisibility(UTILITY_ZOOM, zoom) * 255);

/** Small, stable hardware variations; topology and the concrete-cap visual stay unchanged. */
export const utilityPoleVariant = (id: string): 'single' | 'double' | 'bracket' =>
  (['single', 'double', 'bracket'] as const)[utilitySeed(`${id}:hardware`) % 3]!;
export type UtilityPackingScratch = { owners: Int32Array; cables: Uint8Array };
export const createUtilityPackingScratch = (): UtilityPackingScratch => ({
  owners: new Int32Array(0),
  cables: new Uint8Array(0),
});
const direction = (a: UtilityPoint, b: UtilityPoint, grid: FixtureGrid) => {
  const dx = (b[0] - a[0]) * grid.cellWidth,
    dy = (b[1] - a[1]) * grid.cellHeight;
  return Math.abs(dy) < Math.abs(dx) * 0.4
    ? 1
    : Math.abs(dx) < Math.abs(dy) * 0.4
      ? 2
      : dx * dy < 0
        ? 4
        : 8;
};
const stroke = (mask: number, heavy = false) =>
  mask === 1
    ? heavy
      ? '━'
      : '─'
    : mask === 2
      ? heavy
        ? '┃'
        : '│'
      : mask === 4
        ? '╱'
        : mask === 8
          ? '╲'
          : mask === 12
            ? '╳'
            : '┼';

/** Compose after ALL legacy hardware. A shared support may replace only its own lamp base. */
export function packUtilityFixtures(
  out: Uint8Array,
  grid: FixtureGrid,
  fixtures: readonly UtilityFixture[],
  zoom: number,
  glyphIndex: (glyph: string) => number,
  sharedBases: ReadonlyMap<string, number>,
  scratch: UtilityPackingScratch = createUtilityPackingScratch(),
): number[] {
  const alpha = utilityOpacity(zoom);
  const detailVisibility = bandVisibility(UTILITY_DETAIL_ZOOM, zoom);
  if (!alpha || !fixtures.length) return [];
  const size = grid.cols * grid.rows;
  if (scratch.owners.length !== size) {
    scratch.owners = new Int32Array(size);
    scratch.cables = new Uint8Array(size);
  }
  const { owners, cables } = scratch;
  owners.fill(-1);
  cables.fill(0);
  const active = new Set<number>();
  const projected = new Map<
    string,
    { center: UtilityPoint; along?: UtilityPoint; across?: UtilityPoint }
  >();
  const project = (pole: UtilityPole) => {
    let pose = projected.get(pole.id);
    if (!pose) {
      const center = grid.toCell(...pole.at);
      pose = { center };
      projected.set(pole.id, pose);
    }
    return pose;
  };
  const localPoint = (pole: UtilityPole, along: number, across: number): UtilityPoint => {
    const pose = project(pole);
    if (!along && !across) return pose.center;
    if (!pose.along) {
      const a = grid.toCell(...offsetUtility(pole.at, ...pole.heading));
      const n = grid.toCell(...offsetUtility(pole.at, ...pole.normal));
      pose.along = [a[0] - pose.center[0], a[1] - pose.center[1]];
      pose.across = [n[0] - pose.center[0], n[1] - pose.center[1]];
    }
    // Bounded metre-scale ornaments use local cell directions; support centers remain exact.
    return [
      pose.center[0] + pose.along[0] * along + pose.across![0] * across,
      pose.center[1] + pose.along[1] * along + pose.across![1] * across,
    ];
  };
  // Mercator scale is bounded by the latitude extrema. Compute conservative ornament
  // padding twice for the network, not once for every offscreen support and span.
  let south: UtilityPole | undefined, north: UtilityPole | undefined;
  const extent = (pole: UtilityPole) => {
    if (!south || pole.at[1] < south.at[1]) south = pole;
    if (!north || pole.at[1] > north.at[1]) north = pole;
  };
  for (const fixture of fixtures) {
    if (fixture.kind === 'utility-pole') extent(fixture.pole);
    else {
      extent(fixture.span.from);
      extent(fixture.span.to);
    }
  }
  let mx = 1,
    my = 1;
  for (const pole of [south!, north!]) {
    const center = project(pole).center;
    const expanded = grid.toCell(...offsetUtility(pole.at, UTILITY.buffer, UTILITY.buffer));
    mx = Math.max(mx, Math.abs(expanded[0] - center[0]) + 1);
    my = Math.max(my, Math.abs(expanded[1] - center[1]) + 1);
  }
  const outside = (a: UtilityPoint, b = a) => {
    return (
      Math.max(a[0], b[0]) + mx < 0 ||
      Math.min(a[0], b[0]) - mx >= grid.cols ||
      Math.max(a[1], b[1]) + my < 0 ||
      Math.min(a[1], b[1]) - my >= grid.rows
    );
  };
  const glyphCodes = new Map<
    string,
    { code: number; part: number; bytes?: readonly [number, number] }
  >();
  const stamp = (cell: number, glyph: string, part: number) => {
    let cached = glyphCodes.get(glyph);
    if (!cached) {
      cached = { code: glyphIndex(glyph), part: -1 };
      glyphCodes.set(glyph, cached);
    }
    if (cached.code <= 0 || cached.code > MAX_GLYPHS) return;
    if (cached.part !== part) {
      cached.bytes = packGlyph(cached.code, part);
      cached.part = part;
    }
    const at = cell * 4;
    const [lo, hi] = cached.bytes!;
    if (out[at] === lo && out[at + 1] === hi && out[at + 3] === alpha) return;
    [out[at], out[at + 1]] = [lo, hi];
    out[at + 2] = 0;
    out[at + 3] = alpha;
    active.add(cell);
  };
  const cellAtXY = (x: number, y: number): number => {
    const c = Math.floor(x),
      r = Math.floor(y);
    return c < 0 || r < 0 || c >= grid.cols || r >= grid.rows ? -1 : r * grid.cols + c;
  };
  const cellAt = (p: UtilityPoint) => cellAtXY(p[0], p[1]);
  const line = (a: UtilityPoint, b: UtilityPoint, visit: (cell: number, mask: number) => void) => {
    const clipped = clipUtilityLine(a, b, grid.cols, grid.rows);
    if (!clipped) return;
    const [start, end] = clipped,
      mask = direction(a, b, grid);
    const dx = end[0] - start[0],
      dy = end[1] - start[1];
    const steps = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) * 2);
    for (let i = 0; i <= steps; i++) {
      const t = steps ? i / steps : 0,
        cell = cellAtXY(start[0] + dx * t, start[1] + dy * t);
      if (cell >= 0) visit(cell, mask);
    }
  };
  // Sort even for direct packer callers; normal application conversion already sorts.
  const poles = fixtures.filter((f) => f.kind === 'utility-pole');
  if (poles.some((f, i) => i > 0 && poles[i - 1]!.pole.id > f.pole.id))
    poles.sort((a, b) => (a.pole.id < b.pole.id ? -1 : 1));
  for (let owner = 0; owner < poles.length; owner++) {
    const p = poles[owner]!.pole;
    if (outside(project(p).center)) continue;
    const point = (along: number, across: number) => localPoint(p, along, across);
    const write = (cell: number, glyph: string, part: number) => {
      if (cell < 0) return;
      const occupied = out[cell * 4 + 3]! > 0;
      const shared =
        part === UtilityPart.utilityCap &&
        p.sharedLamp &&
        sharedBases.get(p.sharedLamp) === cell &&
        (out[cell * 4 + 1]! & 63) === 1;
      if (occupied && owners[cell] !== owner && !shared) return;
      stamp(cell, glyph, part);
      owners[cell] = owner;
    };
    if (draw(utilitySeed(p.id), 'detail') < detailVisibility) {
      const variant = utilityPoleVariant(p.id);
      const arms = variant === 'double' ? [-0.6, 0.6] : variant === 'bracket' ? [0.7] : [0];
      if (variant === 'bracket')
        line(point(0, 0), point(0.7, 0), (cell, mask) =>
          write(cell, stroke(mask, true), UtilityPart.crossarm),
        );
      for (const along of arms) {
        line(point(along, -0.8), point(along, 0.8), (cell, mask) =>
          write(cell, stroke(mask, true), UtilityPart.crossarm),
        );
        for (const n of [-0.8, 0.8]) write(cellAt(point(along, n)), '·', UtilityPart.insulator);
      }
      if (p.transformer)
        for (let u = -1; u <= 1; u += 0.25)
          for (let v = 0.6; v <= 1.6; v += 0.25)
            write(cellAt(point(u, v)), '▣', UtilityPart.transformer);
    }
    write(cellAt(point(0, 0)), '●', UtilityPart.utilityCap);
  }
  const cable = (cell: number, mask: number) => {
    if (!out[cell * 4 + 3]) cables[cell]! |= mask;
  };
  for (const f of fixtures) {
    if (f.kind !== 'utility-span') continue;
    const { span: s } = f,
      seed = utilitySeed(s.id),
      detail = draw(seed, 'detail') < detailVisibility;
    const count = detail ? 2 + (s.seed % 3) : 1;
    const from = project(s.from).center,
      to = project(s.to).center;
    if (outside(from, to)) continue;
    const midpoint: UtilityPoint = [
      (s.from.at[0] + s.to.at[0]) / 2,
      (s.from.at[1] + s.to.at[1]) / 2,
    ];
    const dx = (s.to.at[0] - s.from.at[0]) * Math.cos((midpoint[1] * Math.PI) / 180),
      dy = s.to.at[1] - s.from.at[1];
    const length = Math.hypot(dx, dy);
    if (!length) continue;
    for (let trace = 0; trace < count; trace++) {
      if (!detail) {
        line(from, to, cable);
        continue;
      }
      const offset = (draw(seed, `offset-${trace}`) * 2 - 1) * 0.7;
      const a = localPoint(s.from, 0, offset);
      const b = localPoint(s.to, 0, offset);
      const push =
        (draw(seed, `push-${trace}`) * 0.9 + 0.3) * (utilitySeed(String(trace), seed) & 1 ? 1 : -1);
      const mid = grid.toCell(
        ...offsetUtility(midpoint, (-dy / length) * push, (dx / length) * push),
      );
      line(a, mid, cable);
      line(mid, b, cable);
    }
    if (detail)
      for (const [i, p] of [s.from, s.to].entries())
        if (draw(seed, `tangle-${i}`) < 0.2) {
          const sign = i ? -1 : 1;
          const cell = cellAt(
            grid.toCell(
              ...offsetUtility(p.at, (dx / length) * 1.5 * sign, (dy / length) * 1.5 * sign),
            ),
          );
          if (cell >= 0 && !out[cell * 4 + 3]) cables[cell]! |= 16;
        }
  }
  for (let cell = 0; cell < cables.length; cell++) {
    const mask = cables[cell]!;
    if (mask)
      stamp(
        cell,
        mask & 16 ? '∞' : stroke(mask),
        mask & 16 ? UtilityPart.tangle : UtilityPart.cable,
      );
  }
  return [...active];
}

export const utilityViewportVisibility = (
  cells: readonly number[],
  cols: number,
  visible?: FixtureGrid['visible'],
) => cells.some((cell) => !visible || visible(cell % cols, Math.floor(cell / cols)));
