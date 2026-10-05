import { expect } from 'vitest';
import { LifeWorld } from '../simulate';
import { LifeBuilder } from '../geometry';
import type { JunctionTable } from '../junctions';
import { metersPerUnit } from '../../raster/geometry';
import { priorityFixture } from './intersection-priority';
import { completeScenarioState } from './scenarios';

export function* priorityReplaySteps(hz: number) {
  const fixtures = [0, 1].map(() => priorityFixture(LifeWorld, LifeBuilder, metersPerUnit));
  const tables = fixtures.map(
    (f) => (f.world as unknown as { junctions: JunctionTable }).junctions,
  );
  for (const f of fixtures) {
    const selected = f.life.movers.filter((m, i) => m.kind !== 'vehicle' || i % 3 === 0);
    f.life.movers.splice(0, f.life.movers.length, ...selected);
    for (const m of f.life.movers) if (m.kind === 'vehicle') m.speed = m.v = 0;
    for (const index of [0, 1]) {
      const m = f.life.movers[index]!,
        [x, y] = f.arms[m.line]!,
        pm = f.life.perMeter;
      m.d = (220 - 19) * pm;
      m.x = 2048 + x * 19 * pm;
      m.y = 2048 + y * 19 * pm;
    }
    for (const m of f.life.movers) if (m.kind === 'person') m.pause = 28;
  }
  let overWait = false,
    expired = false,
    closed = false,
    reopened = false;
  let firstSince: number | undefined;
  for (let frame = 0; frame < 52 * hz; frame++) {
    for (const f of fixtures) {
      if (frame === 24 * hz)
        for (const m of f.life.movers) if (m.kind === 'vehicle') m.speed = 8 * f.life.perMeter;
      f.beforeStep();
      f.world.step(1 / hz, undefined, 18, undefined, undefined, { rain: 0, minutes: 720 }, 0.9);
    }
    const rows = tables[0]!.snapshot();
    overWait ||= rows.some(
      (r) => tables[0]!.waited(fixtures[0]!.life.movers[r.index]!, r.key) >= 10,
    );
    const first = rows.find((r) => r.index === 0);
    firstSince ??= first?.since;
    expired ||= firstSince !== undefined && first?.since !== firstSince && frame < 24 * hz;
    closed ||= frame > 28 * hz && rows.some((r) => !r.ready);
    reopened ||= closed && rows.some((r) => r.ready && r.since !== undefined);
    if (frame % hz === 0)
      expect(completeScenarioState(fixtures[1]!.world)).toEqual(
        completeScenarioState(fixtures[0]!.world),
      );
    if ((frame + 1) % (13 * hz) === 0 && frame + 1 < 52 * hz) yield;
  }
  expect({ overWait, expired, closed, reopened }).toEqual({
    overWait: true,
    expired: true,
    closed: true,
    reopened: true,
  });
  expect(completeScenarioState(fixtures[1]!.world)).toEqual(
    completeScenarioState(fixtures[0]!.world),
  );
}

export function priorityReplay(hz: number) {
  for (const _ of priorityReplaySteps(hz)) {
    /* resume the same pair of worlds */
  }
}
