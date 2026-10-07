import type { LifeBuilder, LifeLine } from '../geometry';
import type { LifeWorld, TileLife, Mover, WorldGroundGuard } from '../simulate';
import type { worldTiles } from './scenarios';
import type { compatible, JunctionTable } from '../junctions';
import type { metersPerUnit } from '../../raster/geometry';
import type { FOLLOW, JUNCTION } from '../config';
import type { VEHICLES } from '../vehicles';

export type CrossroadsRuntime = {
  LifeBuilder: typeof LifeBuilder;
  LifeLine: typeof LifeLine;
  LifeWorld: typeof LifeWorld;
  worldTiles: typeof worldTiles;
  compatible: typeof compatible;
  metersPerUnit: typeof metersPerUnit;
  FOLLOW: typeof FOLLOW;
  JUNCTION: typeof JUNCTION;
  VEHICLES: typeof VEHICLES;
};
export type CrossroadsVariant = 'original' | 'mixed';
export type CrossroadsMetrics = {
  variant: CrossroadsVariant;
  minimum: number;
  seconds: number;
  steps: number;
  hardCaps: number;
  hardCapFraction: number;
  guardAttempts: number;
  guardRejections: number;
  maxWait: number;
  grantViolations: number;
  stopViolations: number;
  gapViolations: number;
  windows: number[][];
  errors: string[];
};
export type CrossroadsObserver = (life: TileLife, before: readonly Mover[]) => void;

/** Type-only dependencies keep PRE and current runtime graphs completely independent. */
export function* crossroadsSteps(
  runtime: CrossroadsRuntime,
  variant: CrossroadsVariant,
  minimum: number,
  duration = 180,
  observe?: CrossroadsObserver,
): Generator<CrossroadsMetrics, CrossroadsMetrics> {
  const {
    LifeBuilder: Builder,
    LifeLine: Line,
    LifeWorld: World,
    worldTiles: tiles,
    compatible: safeGrant,
    metersPerUnit: metric,
    FOLLOW: following,
    JUNCTION: junction,
    VEHICLES: vehicles,
  } = runtime;
  const tile = { z: 16, x: 55192, y: 30266 },
    pm = 1 / metric(tile);
  const center = { x: 2048, y: 2048 },
    b = new Builder();
  const endpoint = (arm: number) => ({
    x: center.x + Math.cos((arm * Math.PI) / 2) * 220 * pm,
    y: center.y + Math.sin((arm * Math.PI) / 2) * 220 * pm,
  });
  for (let arm = 0; arm < 4; arm++)
    b.line(
      [center, endpoint(arm)],
      Line.roadMajor,
      variant === 'mixed' ? 9.6 : 12,
      undefined,
      variant === 'mixed' ? (arm < 2 ? 1 : -1) : 0,
    );
  if (variant === 'mixed') {
    b.line(
      [endpoint(0), { x: endpoint(0).x, y: endpoint(3).y }, endpoint(3)],
      Line.roadMajor,
      9.6,
      undefined,
      1,
    );
    b.line(
      [endpoint(1), { x: endpoint(2).x, y: endpoint(1).y }, endpoint(2)],
      Line.roadMajor,
      9.6,
      undefined,
      1,
    );
  }
  const geo = b.finish(),
    world = new World();
  world.sync([{ key: 'cross', tile, life: geo }]);
  const life = tiles(world).get('cross')!;
  life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
  life.scenes.sites.length = 0;
  const trucks: Mover[] = [];
  for (let arm = 0; arm < 4; arm++) {
    if (variant === 'mixed' && arm < 2) continue;
    const rows =
      variant === 'original'
        ? [35, 63, 91].map((remaining) => ({
            vehicle: 'car' as const,
            remaining,
            lane: 0,
            free: 8,
          }))
        : [
            { vehicle: 'truck' as const, remaining: 120, lane: 0.75, free: 1 },
            { vehicle: 'car' as const, remaining: 134, lane: 0.75, free: 8 },
            { vehicle: 'motorcycle' as const, remaining: 148, lane: 0.75, free: 8 },
            { vehicle: 'car' as const, remaining: 160, lane: 0.1, free: 8 },
            { vehicle: 'motorcycle' as const, remaining: 174, lane: 0.75, free: 8 },
            { vehicle: 'bicycle' as const, remaining: 190, lane: 0.75, free: 5 },
          ];
    for (const row of rows) {
      const hx = -Math.cos((arm * Math.PI) / 2),
        hy = -Math.sin((arm * Math.PI) / 2);
      const m: Mover = {
        kind: 'vehicle',
        vehicle: row.vehicle,
        line: arm,
        from: arm * 2 + 1,
        dir: -1,
        d: (220 - row.remaining) * pm,
        x: center.x - hx * row.remaining * pm,
        y: center.y - hy * row.remaining * pm,
        hx,
        hy,
        speed: row.free * pm,
        v: (variant === 'mixed' ? 1 : 8) * pm,
        paint: 0,
        lane: row.lane,
        pause: 0,
        rank: 0,
      };
      life.movers.push(m);
      if (row.vehicle === 'truck') trucks.push(m);
    }
  }
  if (variant === 'mixed')
    for (const line of [4, 5])
      for (const segment of [0, 1]) {
        const from = geo.starts[line]! + segment,
          next = from + 1;
        const x = geo.coords[from * 2]!,
          y = geo.coords[from * 2 + 1]!;
        const dx = geo.coords[next * 2]! - x,
          dy = geo.coords[next * 2 + 1]! - y,
          length = Math.hypot(dx, dy);
        const hx = dx / length,
          hy = dy / length;
        life.movers.push({
          kind: 'vehicle',
          vehicle: 'car',
          line,
          from,
          dir: 1,
          d: 110 * pm,
          x: x + hx * 110 * pm,
          y: y + hy * 110 * pm,
          hx,
          hy,
          speed: 8 * pm,
          v: 8 * pm,
          paint: 0,
          lane: segment === 0 ? 0.1 : 0.75,
          pause: 0,
          rank: 0,
        });
      }
  const result: CrossroadsMetrics = {
    variant,
    minimum,
    seconds: 0,
    steps: 0,
    hardCaps: 0,
    hardCapFraction: 0,
    guardAttempts: 0,
    guardRejections: 0,
    maxWait: 0,
    grantViolations: 0,
    stopViolations: 0,
    gapViolations: 0,
    windows: [],
    errors: [],
  };
  const guarded = world as unknown as {
    groundGuard: (this: unknown, ...args: unknown[]) => WorldGroundGuard;
  };
  const originalGuard = guarded.groundGuard;
  guarded.groundGuard = function (...args) {
    const guard = originalGuard.apply(this, args);
    const wrapper: (...args: Parameters<WorldGroundGuard>) => boolean = (
      tileLife,
      owner,
      before,
      ...rest
    ) => {
      const movement = before && 'kind' in owner && owner.kind === 'vehicle';
      if (movement) result.guardAttempts++;
      const accepted = guard(tileLife, owner, before, ...rest);
      if (movement && !accepted) result.guardRejections++;
      return accepted;
    };
    return Object.assign(wrapper, guard);
  };
  const table = (world as unknown as { junctions: JunctionTable }).junctions;
  const crossed = new Set<number>();
  let warmSteps = 0,
    warmCaps = 0;
  const violation = (
    kind: 'grantViolations' | 'stopViolations' | 'gapViolations',
    detail: string,
  ) => {
    result[kind]++;
    if (result.errors.length < 8) result.errors.push(detail);
  };
  for (let frame = 0; frame < duration * 30; frame++) {
    if (variant === 'mixed' && frame === 300) for (const truck of trucks) truck.speed = 8 * pm;
    const before = life.movers.map((m) => ({ ...m }));
    const movements = life.movers.map((m) => table.movement(m));
    world.step(1 / 30, undefined, 18, undefined, undefined, undefined, minimum);
    observe?.(life, before);
    const holders = table.snapshot().filter((r) => r.since !== undefined);
    for (let a = 0; a < holders.length; a++)
      for (let c = a + 1; c < holders.length; c++)
        if (!safeGrant(holders[a]!.movement, holders[c]!.movement))
          violation('grantViolations', `frame ${frame}: incompatible grants`);
    for (let i = 0; i < life.movers.length; i++) {
      const m = life.movers[i]!,
        old = before[i]!;
      result.maxWait = Math.max(result.maxWait, table.waited(m));
      if ((m.routing?.turns ?? 0) > (old.routing?.turns ?? 0)) {
        const move = movements[i];
        if (
          variant === 'original' ||
          (old.line >= 2 &&
            old.line < 4 &&
            move &&
            Math.hypot(move.junction.x - center.x, move.junction.y - center.y) < 1)
        )
          crossed.add(old.line);
      }
      const move = table.movement(m);
      if (
        move &&
        !table.granted(m) &&
        move.ahead >= 0 &&
        m.line === move.line &&
        m.dir === move.dir
      ) {
        const distance = Math.hypot(m.x - move.junction.x, m.y - move.junction.y) / pm;
        if (
          distance <
          move.junction.radius / pm + junction.gap + vehicles[m.vehicle!].length / 2 - 0.05
        )
          violation('stopViolations', `frame ${frame}: actor ${i} crosses an ungranted stop`);
      }
      for (let j = i + 1; j < life.movers.length; j++) {
        const other = life.movers[j]!;
        if (other.line !== m.line || other.dir !== m.dir || other.from !== m.from) continue;
        const a = life.groundBodies(m, 0)[0]!,
          c = life.groundBodies(other, 0)[0]!;
        // Shared pose can already be on a junction fillet while the cursor retains its segment.
        // Strip the independent lateral yaw; only straight road poses use this projected-gap gate.
        const straight = (owner: Mover, body: typeof a) => {
          const slope = (owner.roadYaw ?? 0) + (owner.latYaw ?? 0),
            scale = Math.hypot(1, slope);
          return (
            Math.hypot(
              body.hx - (owner.hx - owner.hy * slope) / scale,
              body.hy - (owner.hy + owner.hx * slope) / scale,
            ) < 1e-6
          );
        };
        if (!straight(m, a) || !straight(other, c)) continue;
        const project = (body: typeof a) => ({
          length:
            (Math.abs(body.hx * m.hx + body.hy * m.hy) * body.length +
              Math.abs(-body.hy * m.hx + body.hx * m.hy) * body.width) /
            2,
          width:
            (Math.abs(body.hx * m.hx + body.hy * m.hy) * body.width +
              Math.abs(-body.hy * m.hx + body.hx * m.hy) * body.length) /
            2,
        });
        const pa = project(a),
          pc = project(c),
          dx = c.x - a.x,
          dy = c.y - a.y;
        if (Math.abs(-dx * m.hy + dy * m.hx) >= pa.width + pc.width + following.roadGap) continue;
        const gap = Math.abs(dx * m.hx + dy * m.hy) - pa.length - pc.length;
        if (gap < following.minGap - 1e-6)
          violation('gapViolations', `frame ${frame}: actors ${i}/${j} bumper gap ${gap}`);
      }
    }
    if (frame === 299) {
      warmSteps = life.motionStats.steps;
      warmCaps = life.motionStats.hardCaps;
    }
    result.steps = life.motionStats.steps - warmSteps;
    result.hardCaps = life.motionStats.hardCaps - warmCaps;
    result.hardCapFraction = result.steps ? result.hardCaps / result.steps : 0;
    result.seconds = (frame + 1) / 30;
    if ((frame + 1) % 1800 === 0) {
      result.windows.push([...crossed].sort());
      crossed.clear();
    }
    // Thirty-second chunks keep each unit test cheap without restarting the continuous 180 s run.
    if ((frame + 1) % 900 === 0) yield result;
  }
  return result;
}

export function runCrossroads(...args: Parameters<typeof crossroadsSteps>): CrossroadsMetrics {
  const steps = crossroadsSteps(...args);
  let next = steps.next();
  while (!next.done) next = steps.next();
  return next.value;
}
