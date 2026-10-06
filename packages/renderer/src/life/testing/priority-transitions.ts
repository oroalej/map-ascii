import type { Mover } from '../simulate';
import { observePriority, type priorityFixture } from './intersection-priority';

type Fixture = ReturnType<typeof priorityFixture>;

/** Dedicated transition inputs; the canonical diagnostic fixture remains unchanged. */
export function preparePriorityTransitions(f: Fixture, pedestrianPause: number): void {
  const selected = f.life.movers.filter((m, i) => m.kind !== 'vehicle' || i % 3 === 0);
  f.life.movers.splice(0, f.life.movers.length, ...selected);
  for (const m of f.life.movers) {
    if (m.kind === 'person') {
      m.pause = pedestrianPause;
      continue;
    }
    if (m.kind !== 'vehicle') continue;
    const [x, y] = f.arms[m.line]!,
      pm = f.life.perMeter,
      geo = f.life.geo;
    let from = geo.starts[m.line + 1]! - 1;
    while (
      from > geo.starts[m.line]! + 1 &&
      Math.hypot(
        geo.coords[(from - 1) * 2]! - f.center.x,
        geo.coords[(from - 1) * 2 + 1]! - f.center.y,
      ) >=
        19 * pm
    )
      from--;
    m.from = from;
    m.d =
      Math.hypot(geo.coords[from * 2]! - f.center.x, geo.coords[from * 2 + 1]! - f.center.y) -
      19 * pm;
    m.x = f.center.x + x * 19 * pm;
    m.y = f.center.y + y * 19 * pm;
    m.speed = m.v = 0;
  }
}

export function observePriorityTransitions(f: Fixture) {
  const observer = observePriority(f),
    table = observer.table;
  const previous = new Map<Mover, Set<string>>(),
    closedKeys = new Map<Mover, Set<string>>();
  const state = { overWait: false, expired: false, closed: false, revoked: false, reopened: false };
  return {
    state,
    beforeStep() {
      previous.clear();
      for (const m of f.life.movers)
        for (const r of table.holds(m))
          if (!r.inside && r.since !== undefined) {
            let keys = previous.get(m);
            if (!keys) previous.set(m, (keys = new Set()));
            keys.add(r.movement.key);
          }
    },
    afterStep() {
      const view = observer.pedestrians();
      for (const r of table.snapshot()) {
        const m = f.life.movers[r.index];
        if (!m) continue;
        state.overWait ||= table.waited(m, r.key) >= 10;
        state.expired ||= r.surrenderedAt !== undefined;
        const p = r.movement;
        const blocked =
          !!view &&
          [p.entry, p.exit].some((arm) =>
            f.life.junctionCrossings
              .forArm(p.junction, arm)
              .some((c) => f.life.pedestrianCrossings.blocked(c, view)),
          ) &&
          !f.life.junctionClear(p, view);
        // Live revocation follows walker motion; readiness is refreshed on the next request pass.
        if (blocked && !r.inside && r.since === undefined && r.surrenderedAt === undefined) {
          state.closed = true;
          let keys = closedKeys.get(m);
          if (!keys) closedKeys.set(m, (keys = new Set()));
          keys.add(r.key);
          state.revoked ||= r.ready && previous.get(m)?.has(r.key) === true;
        }
        state.reopened ||=
          closedKeys.get(m)?.has(r.key) === true && !blocked && r.ready && r.since !== undefined;
      }
    },
    restore() {
      observer.restore();
    },
  };
}
