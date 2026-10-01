/** Static utility fixtures. All topology and support positions are already baked. */
import {
  offsetUtility,
  UTILITY,
  utilityRandom,
  utilityRecordId,
  utilitySeed,
  type UtilityRecord,
  type UtilityPole,
  type UtilitySpan,
  type UtilityPoint,
} from '@atlas/shared';
import { MAX_GLYPHS, packGlyph } from '../glyphs/select';
import type { FixtureGrid } from './fixtures';

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
    if (groups.length === previous.length && groups.every((g, i) => g === previous[i]))
      return result;
    previous = groups.slice();
    const records = new Map<string, UtilityRecord>();
    for (const group of groups)
      for (const record of group) records.set(utilityRecordId(record), record);
    result = utilityFixtures([...records.values()]);
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
const detailed = (id: string, zoom: number) =>
  zoom >= 19.5 || (zoom > 19 && utilityRandom(id, 'detail') < (zoom - 19) / 0.5);
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
): number[] {
  const alpha = Math.round(Math.max(0, Math.min(1, (zoom - 18) / 0.5)) * 255);
  if (!alpha || !fixtures.length) return [];
  const owners = new Int32Array(grid.cols * grid.rows).fill(-1);
  const cables = new Uint8Array(owners.length);
  const active = new Set<number>();
  // The camera has no rotation. Expand the geographic indexing segment by the maximum
  // ornament reach, then skip offscreen hardware before projecting individual strokes.
  const outside = (at: UtilityPoint, a: UtilityPoint, b = a) => {
    const expanded = grid.toCell(...offsetUtility(at, UTILITY.buffer, UTILITY.buffer));
    const mx = Math.abs(expanded[0] - a[0]) + 1,
      my = Math.abs(expanded[1] - a[1]) + 1;
    return (
      Math.max(a[0], b[0]) + mx < 0 ||
      Math.min(a[0], b[0]) - mx >= grid.cols ||
      Math.max(a[1], b[1]) + my < 0 ||
      Math.min(a[1], b[1]) - my >= grid.rows
    );
  };
  const stamp = (cell: number, glyph: string, part: number) => {
    const code = glyphIndex(glyph);
    if (code <= 0 || code > MAX_GLYPHS) return;
    const at = cell * 4;
    [out[at], out[at + 1]] = packGlyph(code, part);
    out[at + 2] = 0;
    out[at + 3] = alpha;
    active.add(cell);
  };
  const cellAt = (p: UtilityPoint): number => {
    const c = Math.floor(p[0]),
      r = Math.floor(p[1]);
    return c < 0 || r < 0 || c >= grid.cols || r >= grid.rows ? -1 : r * grid.cols + c;
  };
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
        cell = cellAt([start[0] + dx * t, start[1] + dy * t]);
      if (cell >= 0) visit(cell, mask);
    }
  };
  // Sort even for direct packer callers; normal application conversion already sorts.
  const poles = fixtures
    .filter((f) => f.kind === 'utility-pole')
    .sort((a, b) => (a.pole.id < b.pole.id ? -1 : 1));
  for (let owner = 0; owner < poles.length; owner++) {
    const p = poles[owner]!.pole;
    if (outside(p.at, grid.toCell(...p.at))) continue;
    const point = (along: number, across: number) =>
      grid.toCell(
        ...offsetUtility(
          p.at,
          p.heading[0] * along + p.normal[0] * across,
          p.heading[1] * along + p.normal[1] * across,
        ),
      );
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
    if (detailed(p.id, zoom)) {
      line(point(0, -0.8), point(0, 0.8), (cell, mask) =>
        write(cell, stroke(mask, true), UtilityPart.crossarm),
      );
      for (const n of [-0.8, 0.8]) write(cellAt(point(0, n)), '·', UtilityPart.insulator);
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
      detail = detailed(s.id, zoom);
    const count = detail ? 2 + (s.seed % 3) : 1;
    const from = grid.toCell(...s.from.at),
      to = grid.toCell(...s.to.at);
    if (outside(s.from.at, from, to)) continue;
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
      const offset = (utilityRandom(s.id, `offset-${trace}`) * 2 - 1) * 0.7;
      const a = grid.toCell(
        ...offsetUtility(s.from.at, s.from.normal[0] * offset, s.from.normal[1] * offset),
      );
      const b = grid.toCell(
        ...offsetUtility(s.to.at, s.to.normal[0] * offset, s.to.normal[1] * offset),
      );
      const push =
        (utilityRandom(s.id, `push-${trace}`) * 0.9 + 0.3) *
        (utilitySeed(s.id + trace) & 1 ? 1 : -1);
      const mid = grid.toCell(
        ...offsetUtility(midpoint, (-dy / length) * push, (dx / length) * push),
      );
      line(a, mid, cable);
      line(mid, b, cable);
    }
    if (detail)
      for (const [i, p] of [s.from, s.to].entries())
        if (utilityRandom(s.id, `tangle-${i}`) < 0.2) {
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
