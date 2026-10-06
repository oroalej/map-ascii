import { expect, it } from 'vitest';
import {
  diagnosticCompletion,
  diagnosticPackingOutcomes,
  requireDiagnosticPacking,
  requireDiagnosticProfiler,
} from './diag-status';
import { PackingOutcome } from '../src/life/diagnostics';
import { FrameProfiler } from '../src/profile';
import { LifeDiagnostics } from '../src/life/diagnostics';

it.each([
  [true, 40, 40, false, true, true],
  [true, 1, 1, false, false, true],
  [false, 39, 40, false, false, false],
  [true, 40, 40, true, false, true],
  [true, 1, 1, true, false, true],
] as const)(
  'qualifies matrix completion independently of selected coverage (%s, %s, %s, probe %s)',
  (finished, cases, selected, probe, complete, selectionComplete) => {
    expect(diagnosticCompletion(finished, cases, 40, selected, probe)).toEqual({
      complete,
      selectionComplete,
    });
  },
);

it('never qualifies a full-selection probe as acceptance', () => {
  expect(diagnosticCompletion(true, 40, 40, 40, true)).toEqual({
    complete: false,
    selectionComplete: true,
  });
});

it('requires the selected profiler to retain the supplied observer', () => {
  const observer = new LifeDiagnostics();
  expect(() =>
    requireDiagnosticProfiler(new FrameProfiler(() => 0, observer), observer),
  ).not.toThrow();
  expect(() => requireDiagnosticProfiler({}, observer)).toThrow('profiler hook');
  expect(() =>
    requireDiagnosticProfiler({ lifeDiagnostics: new LifeDiagnostics() }, observer),
  ).toThrow('profiler hook');
});

it('rejects unwritten packing outcomes and accepts legitimate outside results', () => {
  const outcomes = diagnosticPackingOutcomes(4);
  outcomes.set([PackingOutcome.drawn, PackingOutcome.collision, PackingOutcome.cellGuard]);
  expect(() => requireDiagnosticPacking(outcomes)).toThrow('packing outcomes');
  outcomes[3] = PackingOutcome.outside;
  expect(() => requireDiagnosticPacking(outcomes)).not.toThrow();
  expect(() => requireDiagnosticPacking(new Uint8Array())).not.toThrow();
});
