import { beforeEach, describe, expect, it } from 'vitest';
import { LifeBuilder, LifeLine } from '../geometry';
import { LifeWorld } from '../simulate';
import { worldTiles } from './scenarios';
import { compatible } from '../junctions';
import { FOLLOW, JUNCTION } from '../config';
import { VEHICLES } from '../vehicles';
import { metersPerUnit } from '../../raster/geometry';
import {
  crossroadsSteps,
  type CrossroadsMetrics,
  type CrossroadsVariant,
} from './road-behavior-crossroads';

export function checkCrossroads(variant: CrossroadsVariant, minimum: number, duration = 180) {
  describe(`${variant} crossroads, minimum ${minimum}`, () => {
    let completed = 0,
      filtering = 0;
    const entered = new WeakSet();
    const steps = crossroadsSteps(
      {
        LifeBuilder,
        LifeLine,
        LifeWorld,
        worldTiles,
        compatible,
        FOLLOW,
        JUNCTION,
        VEHICLES,
        metersPerUnit,
      },
      variant,
      minimum,
      duration,
      (life, before) => {
        for (let i = 0; i < life.movers.length; i++) {
          const m = life.movers[i]!,
            old = before[i]!;
          if (old.maneuver?.kind === 'lane' && !m.maneuver && m.chosenLane !== old.chosenLane)
            completed++;
          if (
            !entered.has(m) &&
            m.maneuver?.kind === 'filter' &&
            Math.abs(m.lat ?? 0) > 1e-8 &&
            Math.abs((m.lat ?? 0) - (old.lat ?? 0)) > 1e-8
          ) {
            filtering++;
            entered.add(m);
          }
        }
      },
    );
    const snapshots: { result: CrossroadsMetrics; completed: number; filtering: number }[] = [];
    const advance = () => {
      snapshots.push({ result: structuredClone(steps.next().value), completed, filtering });
    };
    const periods = duration / 30;
    // Each hook advances at most one window. A selected later test still gets the same
    // continuous world, with the same per-hook work budget as a normal 30-second test.
    for (let preceding = 1; preceding < periods; preceding++)
      beforeEach(({ task }) => {
        const selected = Number(task.name.match(/through (\d+) continuous seconds/)![1]) / 30;
        if (preceding < selected && snapshots.length < preceding) advance();
      });
    for (let period = 1; period <= periods; period++)
      it(`retains safety and progress through ${period * 30} continuous seconds`, () => {
        if (snapshots.length < period) advance();
        const { result, completed, filtering } = snapshots[period - 1]!;
        expect(result.seconds).toBe(period * 30);
        expect(result.grantViolations, result.errors.join('\n')).toBe(0);
        expect(result.stopViolations, result.errors.join('\n')).toBe(0);
        expect(result.gapViolations, result.errors.join('\n')).toBe(0);
        expect(result.maxWait).toBeLessThanOrEqual(50);
        expect(result.hardCapFraction).toBeLessThanOrEqual(0.01);
        // Healthy short fixtures cross some arms before all can complete a full minute.
        if (result.seconds < 60) expect(result.partialWindow.length).toBeGreaterThan(0);
        for (const arms of result.windows)
          expect(arms).toEqual(variant === 'original' ? [0, 1, 2, 3] : [2, 3]);
        // PRE's movement-only guard wrapper measured 0 original and 1 mixed rejection per minimum.
        expect(result.guardRejections).toBeLessThanOrEqual(variant === 'original' ? 0 : 2);
        // These terminal assertions require all 180 seconds of acceptance coverage.
        // Secondary-minimum CI files intentionally run only a 30-second smoke window;
        // the independent PRE comparison still exercises every minimum for 180 seconds.
        if (period === 6) {
          expect(result.windows).toHaveLength(3);
          if (variant === 'mixed') {
            expect(completed).toBeGreaterThan(0);
            expect(filtering).toBeGreaterThan(0);
          }
        }
      });
  });
}
