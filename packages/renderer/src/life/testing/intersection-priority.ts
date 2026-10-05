import type { LifeBuilder } from '../geometry';
import type { LifeWorld, TileLife, Mover, WorldGroundGuard } from '../simulate';
import type { JunctionTable, Movement } from '../junctions';
import type { Polygon } from '../occupancy';
import type { LngLatBounds } from '../procession';
import { VEHICLES } from '../vehicles';
import { JUNCTION } from '../config';

/** Inject constructors so exactly the same fixture can measure the PRE and POST source. */
export function priorityFixture(
  Simulation: typeof LifeWorld,
  Builder: typeof LifeBuilder,
  metersPerUnit: (tile: { z: number; x: number; y: number }) => number,
  transit = false,
  close = false,
) {
  const tile = { z: 16, x: 55192, y: 30266 },
    pm = 1 / metersPerUnit(tile),
    b = new Builder(),
    center = { x: 2048, y: 2048 },
    arms = [
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
    ] as const,
    crossings: Polygon[] = [];
  for (const [hx, hy] of arms) {
    b.line(
      [
        center,
        ...(close && hx === 1 ? [{ x: center.x + 20 * pm, y: center.y }] : []),
        { x: center.x + hx * 220 * pm, y: center.y + hy * 220 * pm },
      ],
      0,
      12,
    );
    const x = center.x + hx * 12 * pm,
      y = center.y + hy * 12 * pm;
    const ring = [
      [-1.5, -6.5],
      [1.5, -6.5],
      [1.5, 6.5],
      [-1.5, 6.5],
    ].map(([a, s]) => ({
      x: x + (hx * a! - hy * s!) * pm,
      y: y + (hy * a! + hx * s!) * pm,
    }));
    b.area('crossing', [ring]);
    crossings.push([ring.map((p) => ({ x: p.x / pm, y: p.y / pm }))]);
  }
  const corners = [
    [-12, -12],
    [12, -12],
    [12, 12],
    [-12, 12],
    [-12, -12],
  ].map(([x, y]) => ({
    x: center.x + x! * pm,
    y: center.y + y! * pm,
  }));
  b.line(corners, 3, 3);
  if (transit) {
    b.site({ x: center.x + 14 * pm, y: center.y + 8 * pm }, 0, 2, true);
    b.site({ x: center.x - 14 * pm, y: center.y - 8 * pm }, 0, 2, true);
  }
  if (close)
    b.line(
      [
        { x: center.x + 20 * pm, y: center.y },
        { x: center.x + 20 * pm, y: center.y - 90 * pm },
      ],
      0,
      12,
    );
  const entry = { key: 'intersection-priority', tile, life: b.finish() },
    world = new Simulation();
  world.sync([entry]);
  const life = (world as unknown as { tiles: Map<string, TileLife> }).tiles.get(entry.key)!;
  life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
  if (!transit) life.scenes.sites.length = 0;
  // Remove ambient pausing/running only in the deterministic clearing fixture.
  Object.assign(life, { walkerRng: () => 0.999, runRng: () => 0.999 });
  for (let arm = 0; arm < 4; arm++)
    for (let n = 0; n < 3; n++) {
      const [ox, oy] = arms[arm]!,
        remaining = 35 + 28 * n;
      life.movers.push({
        kind: 'vehicle',
        vehicle: transit ? 'jeepney' : 'car',
        line: arm,
        from: life.geo.starts[arm + 1]! - 1,
        dir: -1,
        d: (220 - remaining) * pm,
        x: center.x + ox * remaining * pm,
        y: center.y + oy * remaining * pm,
        hx: -ox,
        hy: -oy,
        speed: 8 * pm,
        v: 8 * pm,
        paint: 0,
        lane: 0,
        pause: 0,
        rank: 0,
      });
    }
  for (let i = 0; i < 4; i++) {
    const a = corners[i]!,
      next = corners[i + 1]!,
      length = Math.hypot(next.x - a.x, next.y - a.y);
    life.movers.push({
      kind: 'person',
      line: 4,
      from: life.geo.starts[4]! + i,
      dir: 1,
      d: 0,
      x: a.x,
      y: a.y,
      hx: (next.x - a.x) / length,
      hy: (next.y - a.y) / length,
      speed: 1.2 * pm,
      paint: 0,
      lane: 0,
      pause: 12,
      rank: 0,
      group: [{ figure: 'adult', shirt: 3, umbrella: 0, canopy: 0, lateral: 0, back: 0, step: 0 }],
    });
  }
  const cursors = new Map(life.movers.filter((m) => m.kind === 'person').map((m) => [m, m.from]));
  return {
    world,
    life,
    entry,
    center,
    crossings,
    arms,
    beforeStep() {
      for (const m of life.movers)
        if (m.kind === 'vehicle' && m.dir === -1) {
          // Each inbound car takes its legal straight exit, keeping all four arms active.
          m.routing = {
            seed: 1,
            turns: m.routing?.turns ?? 0,
            plan: {
              line: m.line,
              dir: -1,
              vertex: life.geo.starts[m.line]!,
              exit: ((m.line + 2) % 4) * 2,
              radius: 6,
            },
          };
        }
      for (const m of cursors.keys()) {
        // Recovery can reverse an ordinary walker after a collision. The scripted clearing
        // fixture commits to the legal clockwise loop instead; this does not move a walker.
        if (m.dir === -1) {
          const previous = m.from - 1,
            coords = life.geo.coords;
          const length = Math.hypot(
            coords[m.from * 2]! - coords[previous * 2]!,
            coords[m.from * 2 + 1]! - coords[previous * 2 + 1]!,
          );
          m.from = previous;
          m.d = length - m.d;
          m.dir = 1;
          m.hx = -m.hx;
          m.hy = -m.hy;
        }
        m.waiting = 0;
      }
      for (const [m, from] of cursors)
        if (m.from !== from) {
          // Corners are outside every stripe and inward-curb query; provide finite clear windows.
          if (m.d < pm) m.pause = 12;
          cursors.set(m, m.from);
        }
    },
  };
}

type Fixture = ReturnType<typeof priorityFixture>;
type GuardFactory = (
  minimum?: number,
  fresh?: ReadonlySet<TileLife>,
  bounds?: LngLatBounds,
  allBodies?: boolean,
  region?: ReadonlySet<TileLife>,
) => WorldGroundGuard;

/** Test/scratch observation only. Delegation preserves the exact accepted movement and RNG. */
export function observePriority(fixture: Fixture) {
  const { world, life, crossings, arms } = fixture,
    internal = world as unknown as { junctions: JunctionTable; groundGuard: GuardFactory },
    original = internal.groundGuard,
    table = internal.junctions,
    counts = Array.from({ length: 3 }, () => [0, 0, 0, 0]),
    pedestrianEpisodes = [0, 0, 0, 0],
    occupied = [false, false, false, false],
    episodes = new Map<Mover, Map<string, { age: number; reported: boolean }>>(),
    positions = new Map<Mover, { x: number; y: number }>(),
    longEpisodes: { index: number; key: string; age: number }[] = [];
  let guard: WorldGroundGuard | undefined,
    seconds = 0,
    maxWaited = 0,
    peakStall = 0,
    requests = 0,
    unsafeEntries = 0,
    entries = 0,
    insideFreezeSeconds = 0,
    twoCarFreezes = 0;
  const distance = (m: Mover, movement: Movement) => {
    const j = movement.junction,
      pm = life.perMeter;
    // Keep the observer's projection independent of production distance/gating helpers.
    const half = VEHICLES[m.vehicle!].length / 2;
    return (
      ((movement.entry?.x ?? j.x) - m.x) * movement.inHx +
      ((movement.entry?.y ?? j.y) - m.y) * movement.inHy -
      j.radius -
      (JUNCTION.gap + half) * pm
    );
  };
  const armFor = (hx: number, hy: number) => arms.findIndex(([x, y]) => x * hx + y * hy > 0.86);
  internal.groundGuard = function (...args) {
    const base = original.apply(world, args);
    const wrapped: WorldGroundGuard = Object.assign((...call: Parameters<WorldGroundGuard>) => {
      const accepted = base(...call),
        [ownerLife, owner, before] = call;
      if (accepted && ownerLife === life && before && 'kind' in owner && owner.kind === 'vehicle') {
        const m = owner,
          previous = before as Mover,
          movement = table.movement(m);
        if (
          movement &&
          distance(previous, movement) >= -0.05 * life.perMeter &&
          distance(m, movement) < -0.05 * life.perMeter
        ) {
          const entryArm = armFor(-movement.inHx, -movement.inHy),
            exitArm = armFor(movement.outHx, movement.outHy),
            view = base.pedestrians(life);
          entries++;
          const window = Math.min(2, Math.floor(seconds / 60));
          if (entryArm >= 0) counts[window]![entryArm]!++;
          if (
            (entryArm >= 0 && view.walkersInArea(crossings[entryArm]!)) ||
            (exitArm >= 0 && view.walkersInArea(crossings[exitArm]!))
          )
            unsafeEntries++;
        }
      }
      return accepted;
    }, base);
    guard = wrapped;
    return wrapped;
  };
  return {
    table,
    afterStep(dt: number) {
      const snapshots = table.snapshot();
      requests += snapshots.length;
      let frozenInside = 0;
      const seen = new Map<Mover, Set<string>>();
      for (const r of snapshots) {
        const m = life.movers[r.index];
        if (!m || m.kind !== 'vehicle') continue;
        maxWaited = Math.max(maxWaited, table.waited(m));
        const old = positions.get(m),
          moved = !old || Math.hypot(m.x - old.x, m.y - old.y) > 1e-8;
        const stalled =
          (r.since === undefined && r.movement.ahead / life.perMeter <= 3) ||
          (r.since !== undefined && !moved);
        let state = episodes.get(m);
        if (!state)
          episodes.set(m, (state = new Map<string, { age: number; reported: boolean }>()));
        let keys = seen.get(m);
        if (!keys) seen.set(m, (keys = new Set()));
        keys.add(r.movement.key);
        if (stalled && !life.scenes.held(m)) {
          const episode = state.get(r.movement.key) ?? { age: 0, reported: false };
          episode.age += dt;
          state.set(r.movement.key, episode);
          peakStall = Math.max(peakStall, episode.age);
          if (episode.age > 30 && !episode.reported) {
            episode.reported = true;
            longEpisodes.push({ index: r.index, key: r.movement.key, age: episode.age });
          }
        } else state.delete(r.movement.key);
        if (r.inside && !moved) frozenInside++;
      }
      for (const [m, state] of episodes)
        for (const key of state.keys()) if (!seen.get(m)?.has(key)) state.delete(key);
      insideFreezeSeconds = frozenInside >= 2 ? insideFreezeSeconds + dt : 0;
      if (insideFreezeSeconds >= 10 && insideFreezeSeconds - dt < 10) twoCarFreezes++;
      for (const m of life.movers) positions.set(m, { x: m.x, y: m.y });
      if (guard)
        for (let i = 0; i < 4; i++) {
          const now = guard.pedestrians(life).walkersInArea(crossings[i]!);
          if (now && !occupied[i]) pedestrianEpisodes[i]!++;
          occupied[i] = now;
        }
      seconds += dt;
    },
    result() {
      return {
        seconds,
        indexedJunctions: life.junctionIndex.junctions.length,
        requests,
        maxWaited,
        peakStall,
        stallsOver30: longEpisodes.length,
        longEpisodes,
        unresolved: [...episodes].flatMap(([m, state]) =>
          [...state].map(([key, e]) => ({
            index: life.movers.indexOf(m),
            key,
            age: e.age,
          })),
        ),
        crossingsPerArmPer60: counts,
        pedestrianEpisodes,
        entries,
        unsafeEntries,
        twoCarFreezes,
        transitSites: life.scenes.sites.length,
      };
    },
    restore() {
      internal.groundGuard = original;
    },
  };
}
