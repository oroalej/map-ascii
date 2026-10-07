/** A bounded rejection-only search for complete coarse person groups. */
export const GROUP_PLACEMENT_ATTEMPTS = 4096;
type Offset = readonly [number, number];
type Candidate = { offset: Offset; cells: readonly number[] };
export type GroupRaster = {
  expected: number;
  cells: readonly { col: number; row: number }[];
};
export type GroupPlacement = {
  offsets?: readonly Offset[];
  rigidAttempts: number;
  assignmentAttempts: number;
  exhausted: boolean;
};

export type LonePlacement = {
  offset?: Offset;
  rigidAttempts: number;
  targetCellChecks: number;
};

function candidatesFor(
  members: readonly GroupRaster[],
  offsets: readonly Offset[],
  grid: { cols: number; rows: number },
  permits: (col: number, row: number) => boolean,
): Candidate[][] {
  return members.map((member) => {
    if (member.cells.length !== member.expected) return [];
    return offsets.flatMap((offset) => {
      const cells: number[] = [];
      for (const cell of member.cells) {
        const col = cell.col + offset[0],
          row = cell.row + offset[1];
        if (col < 0 || row < 0 || col >= grid.cols || row >= grid.rows || !permits(col, row))
          return [];
        cells.push(row * grid.cols + col);
      }
      return [{ offset, cells }];
    });
  });
}

function assignCandidates(
  candidates: readonly (readonly Candidate[])[],
  order: readonly number[],
  budget = Infinity,
  coherent?: (member: number, offset: Offset, selected: readonly (Offset | undefined)[]) => boolean,
): Pick<GroupPlacement, 'offsets' | 'assignmentAttempts' | 'exhausted'> {
  const result = {
    assignmentAttempts: 0,
    exhausted: false,
    offsets: undefined as readonly Offset[] | undefined,
  };
  if (candidates.some((choices) => !choices.length)) return result;
  const selected = new Array<Offset | undefined>(candidates.length);
  const occupied = new Set<number>();
  const assign = (depth: number): boolean => {
    if (depth === order.length) return true;
    const i = order[depth]!;
    for (const candidate of candidates[i]!) {
      if (result.assignmentAttempts >= budget) {
        result.exhausted = true;
        return false;
      }
      result.assignmentAttempts++;
      if (
        (coherent && !coherent(i, candidate.offset, selected)) ||
        candidate.cells.some((at) => occupied.has(at))
      )
        continue;
      for (const at of candidate.cells) occupied.add(at);
      selected[i] = candidate.offset;
      if (assign(depth + 1)) return true;
      selected[i] = undefined;
      for (const at of candidate.cells) occupied.delete(at);
      if (result.exhausted) return false;
    }
    return false;
  };
  if (assign(0)) result.offsets = selected.map((offset) => offset!);
  return result;
}

/** Preserve first-ring member and offset traversal; only cache translated addresses. */
export function placeFirstRingGroup(
  members: readonly GroupRaster[],
  grid: { cols: number; rows: number },
  offsets: readonly Offset[],
  permits: (col: number, row: number) => boolean,
): readonly Offset[] | undefined {
  return assignCandidates(
    candidatesFor(members, offsets, grid, permits),
    members.map((_, i) => i),
  ).offsets;
}

// Only the current dimensions are retained. First-ring draw ordering also depends
// on each actor's fractional anchor and deliberately does not use this cache.
let cachedOffsets:
  | {
      width: number;
      height: number;
      all: readonly Offset[];
      ring: readonly Offset[];
    }
  | undefined;
function offsetsFor(grid: { cellWidth: number; cellHeight: number }) {
  if (cachedOffsets?.width === grid.cellWidth && cachedOffsets.height === grid.cellHeight)
    return cachedOffsets;
  const offsets: Offset[] = [];
  for (let dy = -2; dy <= 2; dy++)
    for (let dx = -2; dx <= 2; dx++) offsets.push(Object.freeze([dx, dy] as const));
  offsets.sort(
    (a, b) =>
      (a[0] * grid.cellWidth) ** 2 +
        (a[1] * grid.cellHeight) ** 2 -
        (b[0] * grid.cellWidth) ** 2 -
        (b[1] * grid.cellHeight) ** 2 ||
      a[1] - b[1] ||
      a[0] - b[0],
  );
  cachedOffsets = {
    width: grid.cellWidth,
    height: grid.cellHeight,
    all: Object.freeze(offsets),
    ring: Object.freeze(offsets.filter(([dx, dy]) => Math.max(Math.abs(dx), Math.abs(dy)) === 2)),
  };
  return cachedOffsets;
}

function validRaster(member: GroupRaster) {
  if ((member.expected !== 1 && member.expected !== 4) || member.cells.length !== member.expected)
    return false;
  for (let i = 0; i < member.cells.length; i++) {
    const cell = member.cells[i]!;
    if (!Number.isInteger(cell.col) || !Number.isInteger(cell.row)) return false;
    // Input cells may be outside the grid before translation. Compare coordinates
    // directly so row * cols + col cannot alias two distinct out-of-bounds cells.
    for (let j = 0; j < i; j++)
      if (member.cells[j]!.col === cell.col && member.cells[j]!.row === cell.row) return false;
  }
  return true;
}

/** A single complete coarse figure has only sixteen rigid second-ring choices. */
export function placeCoarseLone(
  member: GroupRaster,
  grid: { cols: number; rows: number; cellWidth: number; cellHeight: number },
  permits: (col: number, row: number) => boolean,
): LonePlacement {
  const result: LonePlacement = { rigidAttempts: 0, targetCellChecks: 0 };
  if (!validRaster(member)) return result;
  for (const offset of offsetsFor(grid).ring) {
    result.rigidAttempts++;
    if (
      member.cells.every((cell) => {
        result.targetCellChecks++;
        const col = cell.col + offset[0],
          row = cell.row + offset[1];
        return col >= 0 && col < grid.cols && row >= 0 && row < grid.rows && permits(col, row);
      })
    ) {
      result.offset = offset;
      break;
    }
  }
  return result;
}

export function placeCoarseGroup(
  members: readonly GroupRaster[],
  grid: { cols: number; rows: number; cellWidth: number; cellHeight: number },
  permits: (col: number, row: number) => boolean,
  budget = GROUP_PLACEMENT_ATTEMPTS,
): GroupPlacement {
  const result: GroupPlacement = {
    rigidAttempts: 0,
    assignmentAttempts: 0,
    exhausted: false,
  };
  if (
    members.length < 2 ||
    members.length > 4 ||
    members.reduce((sum, member) => sum + member.expected, 0) > 16 ||
    members.some((member) => !validRaster(member))
  )
    return result;

  const offsets = offsetsFor(grid);
  const allowed = (col: number, row: number) =>
    col >= 0 && col < grid.cols && row >= 0 && row < grid.rows && permits(col, row);
  // Prefer a common translation; preserve formation before assigning members separately.
  const used = new Set<number>();
  for (const offset of offsets.ring) {
    result.rigidAttempts++;
    used.clear();
    let clear = true;
    for (const member of members) {
      for (const cell of member.cells) {
        const col = cell.col + offset[0],
          row = cell.row + offset[1],
          at = row * grid.cols + col;
        if (used.has(at) || !allowed(col, row)) {
          clear = false;
          break;
        }
        used.add(at);
      }
      if (!clear) break;
    }
    if (clear) {
      result.offsets = members.map(() => offset);
      return result;
    }
  }

  // Filter once and cache addresses. The recursive search allocates no footprint arrays.
  const candidates = candidatesFor(members, offsets.all, grid, permits);
  if (candidates.some((choices) => !choices.length)) return result;
  const order = members
    .map((_, i) => i)
    .sort((a, b) => candidates[a]!.length - candidates[b]!.length || a - b);
  const coherent = (i: number, offset: Offset, selected: readonly (Offset | undefined)[]) => {
    const anchor = members[i]!.cells[0]!;
    for (let j = 0; j < selected.length; j++) {
      const other = selected[j];
      if (!other) continue;
      if (Math.abs(offset[0] - other[0]) > 1 || Math.abs(offset[1] - other[1]) > 1) return false;
      const before = members[j]!.cells[0]!;
      if (
        (anchor.col - before.col) * (anchor.col + offset[0] - before.col - other[0]) < 0 ||
        (anchor.row - before.row) * (anchor.row + offset[1] - before.row - other[1]) < 0
      )
        return false;
    }
    return true;
  };
  Object.assign(result, assignCandidates(candidates, order, budget, coherent));
  return result;
}
