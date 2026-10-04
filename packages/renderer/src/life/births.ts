import { FOLLOW, MAX_TILE_AGENTS, usableLines } from './config';
import { LifeLine, inTile } from './geometry';
import { frameBetween } from './frames';
import { bodiesOverlap } from './occupancy';
import type { ContinuityCounter, ContinuityRejection } from './diagnostics';
import type { WorldGroundGuard } from './simulate';
import { lngLatToTile } from '../raster/geometry';
import { bodyCorners, type Body } from './occupancy';
import type { LngLatBounds } from './procession';
import type { Mover, TileLife } from './simulate';

export type LifeViewContext = { bounds: LngLatBounds; spawnMarginM: number };
export type PendingSeed = {
  mover: Mover;
  at: number;
  entrance?: number;
  failures?: number;
  retryAt?: number;
};
export const BIRTHS = {
  attempts: 32,
  grace: 1,
  tileRate: 4,
  worldRate: 16,
  margin: 12,
  maxFailures: 16,
  lifetime: 8,
  retrySeconds: 0.5,
} as const;

/** Two CSS cells in meters; admission alone applies the minimum protected margin. */
export function spawnMargin(cellMeters: number, aspect: number) {
  return 2 * cellMeters * Math.max(1, aspect);
}

export function viewRect(life: TileLife, view: LifeViewContext, margin: number) {
  const [w, s, e, n] = view.bounds;
  const a = lngLatToTile(life.tile, w, n),
    b = lngLatToTile(life.tile, e, s);
  return {
    x0: a.x / life.perMeter - margin,
    y0: a.y / life.perMeter - margin,
    x1: b.x / life.perMeter + margin,
    y1: b.y / life.perMeter + margin,
  };
}
/** Full groups/consists, not just their leading cursor, must be outside the protected view. */
export function outsideView(
  life: TileLife,
  bodies: readonly Body[],
  view: LifeViewContext,
  margin: number,
) {
  if (!bodies.length) return false;
  const r = viewRect(life, view, margin);
  return bodies.every((body) => {
    const p = bodyCorners(body);
    return (
      p.every((v) => v.x < r.x0) ||
      p.every((v) => v.x > r.x1) ||
      p.every((v) => v.y < r.y0) ||
      p.every((v) => v.y > r.y1)
    );
  });
}

type Entrance = { line: number; distance: number; endpoint?: boolean };

/** Deterministic entrances along the original population route. No seed stream is consumed. */
export function entryDistances(
  life: TileLife,
  m: Mover,
  view: LifeViewContext,
  radius: number,
): Entrance[] {
  const r = viewRect(life, view, radius + 0.01),
    pm = life.perMeter;
  const c = life.geo.coords;
  const { first, end } =
    m.kind === 'vehicle' ? life.populationRange(m.line) : { first: m.line, end: m.line + 1 };
  const values: Entrance[] = [];
  for (let line = first; line < end; line++) {
    const start = life.geo.starts[line]!,
      last = life.geo.starts[line + 1]! - 1;
    let along = 0;
    for (let v = start; v < last; v++) {
      const ax = c[v * 2]! / pm,
        ay = c[v * 2 + 1]! / pm;
      const dx = c[v * 2 + 2]! / pm - ax,
        dy = c[v * 2 + 3]! / pm - ay;
      const length = Math.hypot(dx, dy);
      const put = (t: number) => {
        if (t < 0 || t > 1) return;
        const x = ax + dx * t,
          y = ay + dy * t;
        if (x < r.x0 - 0.001 || x > r.x1 + 0.001 || y < r.y0 - 0.001 || y > r.y1 + 0.001) return;
        if (((r.x0 + r.x1) / 2 - x) * dx * m.dir + ((r.y0 + r.y1) / 2 - y) * dy * m.dir <= 0)
          return;
        values.push({ line, distance: (along + t * length) * pm });
      };
      if (dx) {
        put((r.x0 - ax) / dx);
        put((r.x1 - ax) / dx);
      }
      if (dy) {
        put((r.y0 - ay) / dy);
        put((r.y1 - ay) / dy);
      }
      along += length;
    }
  }
  // Mapped route endpoints are valid entrances even when the viewport contains the whole tile.
  const length = life.populationLength(first, end);
  const position = life.populationPiece(
    first,
    end,
    Math.min(length / 2, (radius + 0.01) * pm),
    m.dir,
  );
  values.push({
    line: position.line,
    distance: m.dir === 1 ? position.distance : life.lineLength(position.line) - position.distance,
    endpoint: true,
  });
  return values;
}

function retainSeeds(life: TileLife, keep: (seed: PendingSeed) => boolean) {
  let count = 0;
  for (const seed of life.pending) if (keep(seed)) life.pending[count++] = seed;
  life.pending.length = count;
}

export type BirthContext = {
  view?: LifeViewContext;
  lives: TileLife[];
  credit: number;
  cursor: number;
  owns(life: TileLife, point: { x: number; y: number }): boolean;
  guard(life: TileLife): WorldGroundGuard;
  boatRoom(life: TileLife, mover: Mover): boolean;
  count?: (event: ContinuityCounter) => void;
};

/** Replacement stock is inert until admitted; no background catch-up or population refill. */
export function admitBirths(context: BirthContext, dt: number) {
  const view = context.view;
  const lives = context.lives
    .filter((life) => life.pending.length)
    .sort((a, b) => a.tile.z - b.tile.z || a.tile.x - b.tile.x || a.tile.y - b.tile.y);
  if (!view || !lives.length) {
    context.credit = 0;
    return;
  }
  context.credit = Math.min(BIRTHS.worldRate, context.credit + dt * BIRTHS.worldRate);
  for (const life of lives)
    life.birthCredit = Math.min(BIRTHS.tileRate, life.birthCredit + dt * BIRTHS.tileRate);
  let guard: WorldGroundGuard | undefined;
  const reject = context.count;
  // Expiry is active simulation time; retirement leaves life.elapsed frozen.
  for (const life of lives) {
    retainSeeds(life, (seed) => {
      const expired =
        life.elapsed - seed.at >= BIRTHS.lifetime || (seed.failures ?? 0) >= BIRTHS.maxFailures;
      if (expired) context.count?.('expiredBirths');
      return !expired;
    });
  }
  // Only one neighborhood occupancy build per step, rotating fairly among due tiles.
  let selected: TileLife | undefined;
  for (let i = 0; i < lives.length; i++) {
    const life = lives[context.cursor++ % lives.length]!;
    if (life.pending.some((seed) => (seed.retryAt ?? 0) <= life.elapsed)) {
      selected = life;
      break;
    }
  }
  if (!selected) return;
  const life = selected;
  const due: PendingSeed[] = [];
  retainSeeds(life, (seed) => {
    if (due.length < BIRTHS.attempts && (seed.retryAt ?? 0) <= life.elapsed) {
      due.push(seed);
      return false;
    }
    return true;
  });
  const retry = (seed: PendingSeed) => {
    seed.failures = (seed.failures ?? 0) + 1;
    seed.retryAt = life.elapsed + BIRTHS.retrySeconds;
    if (seed.failures < BIRTHS.maxFailures) life.pending.push(seed);
    else context.count?.('expiredBirths');
  };
  for (const seed of due) {
    context.count?.('attempts');
    const m = seed.mover,
      kind = life.geo.kinds[m.line];
    const invalid =
      kind === undefined ||
      !usableLines[m.kind].includes(kind as LifeLine) ||
      (m.kind === 'vehicle' && life.geo.oneway?.[m.line] && life.geo.oneway[m.line] !== m.dir) ||
      (m.kind === 'boat' && kind === LifeLine.canal && m.vehicle === 'motorboat');
    if (invalid) {
      context.count?.('geometry');
      continue;
    }
    if (life.movers.length >= MAX_TILE_AGENTS) {
      context.count?.('capQuota');
      retry(seed);
      continue;
    }
    let bodies = life.birthBodies(m),
      candidate = m;
    let ordinary = outsideView(life, bodies, view, Math.max(BIRTHS.margin, view.spawnMarginM));
    let entered = false;
    const fallback =
      life.elapsed - seed.at >= BIRTHS.grace &&
      life.birthCredit >= 1 - 1e-9 &&
      context.credit >= 1 - 1e-9;
    if (fallback && !ordinary) {
      const radius = bodies.length
        ? Math.max(
            ...bodies.map(
              (b) =>
                Math.hypot(b.x - m.x / life.perMeter, b.y - m.y / life.perMeter) +
                Math.hypot(b.length, b.width) / 2,
            ),
          )
        : 2;
      const distances = entryDistances(life, m, view, radius);
      const index = (seed.entrance ?? 0) % distances.length;
      seed.entrance = (seed.entrance ?? 0) + 1;
      const entry = distances[index];
      if (entry) {
        const placed = life.placeSeed({ ...m, line: entry.line }, entry.distance);
        const full = placed ? life.birthBodies(placed) : [];
        // Vehicles enter connected road ends offscreen; other route endpoints stay explicit entrances.
        const endpoint =
          entry.endpoint && (m.kind !== 'vehicle' || !life.continuesRoad(entry.line, m.dir === 1));
        if (
          placed &&
          inTile(placed) &&
          context.owns(life, placed) &&
          full.length &&
          (endpoint || outsideView(life, full, view, 0))
        ) {
          candidate = placed;
          bodies = full;
          entered = true;
        }
      }
    }
    ordinary = outsideView(life, bodies, view, Math.max(BIRTHS.margin, view.spawnMarginM));
    if (
      (!ordinary && !entered) ||
      !bodies.length ||
      !inTile(candidate) ||
      !context.owns(life, candidate) ||
      !birthFits(context, life, candidate, (guard ??= context.guard(life)), reject)
    ) {
      retry(seed);
      continue;
    }
    Object.assign(m, candidate);
    life.movers.push(m);
    if (m.kind !== 'boat') guard(life, m);
    if (entered) {
      life.birthCredit = Math.max(0, life.birthCredit - 1);
      context.credit = Math.max(0, context.credit - 1);
    }
    context.count?.('births');
  }
}

function birthFits(
  context: BirthContext,
  life: TileLife,
  m: Mover,
  guard: WorldGroundGuard,
  reject?: (reason: ContinuityRejection) => void,
) {
  if (m.kind === 'vehicle' && !life.junctionIndex.canSpawnVehicle(m)) {
    reject?.('geometry');
    return false;
  }
  if (
    m.kind === 'person' &&
    life
      .birthBodies(m)
      .some(
        (b) =>
          !life.scenes.walkable(
            { x: b.x * life.perMeter, y: b.y * life.perMeter },
            { x: b.x * life.perMeter, y: b.y * life.perMeter },
          ),
      )
  ) {
    reject?.('terrain');
    return false;
  }
  if (m.kind === 'boat') {
    const fits = context.boatRoom(life, m);
    if (!fits) reject?.('occupancy');
    return fits;
  }
  if (m.train) {
    const bodies = life.birthBodies(m);
    if (
      !bodies.length ||
      bodies.some(
        (b) =>
          !life.projectRail({
            ...m,
            x: b.x * life.perMeter,
            y: b.y * life.perMeter,
            hx: b.hx,
            hy: b.hy,
          }),
      )
    )
      return false;
    for (const otherLife of context.lives)
      for (const other of otherLife.movers) {
        if (!other.train || !context.owns(otherLife, other)) continue;
        const f = frameBetween(otherLife.tile, life.tile),
          scale = (f.scale * otherLife.perMeter) / life.perMeter;
        const otherBodies = otherLife.birthBodies(other).map((b) => ({
          ...b,
          x: f.x / life.perMeter + b.x * scale,
          y: f.y / life.perMeter + b.y * scale,
          length: b.length * scale + 2 * FOLLOW.minGap,
          width: b.width * scale,
        }));
        if (bodies.some((a) => otherBodies.some((b) => bodiesOverlap(a, b)))) return false;
      }
  }
  return guard(life, m, undefined, undefined, false, m, reject);
}
