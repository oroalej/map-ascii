import { expect, it } from 'vitest';
import {
  diagnosticCompletion,
  diagnosticPackingOutcomes,
  requireDiagnosticPacking,
  requireDiagnosticProfiler,
  diagnosticFlags,
  diagnosticCases,
  diagnosticHarnessFiles,
  diagnosticObserverHash,
  requireDiagnosticObserver,
} from './diag-status';
import { PackingOutcome } from '../src/life/diagnostics';
import { FrameProfiler } from '../src/profile';
import { LifeDiagnostics } from '../src/life/diagnostics';
import { referenceBodies } from './observe-life';

it.each([
  [true, 40, 40, false, true, true],
  [true, 1, 1, false, false, true],
  [false, 39, 40, false, false, false],
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

it('keeps the forty-case matrix and its acceptance order', () => {
  expect(diagnosticCases).toHaveLength(40);
  expect(new Set(diagnosticCases.map((c) => c.key)).size).toBe(40);
  expect(diagnosticCases[0]?.key).toBe('z17/720/crowd1/fixed');
  expect(diagnosticCases[39]?.key).toBe('z19/1080/crowd0.4/pan');
  expect([...new Set(diagnosticCases.map((c) => c.zoom))]).toEqual([17, 16, 18, 15, 19]);
});

it('parses separated case flags without silently selecting the full matrix', () => {
  expect(diagnosticFlags(['--case', 'z17', '--probe-seconds=30']).prefix).toBe('z17');
  expect(diagnosticFlags([]).output).toBeUndefined();
  for (const args of [
    ['--case'],
    ['--case='],
    ['--cases=z17'],
    ['--case=z99'],
    ['--resume'],
    ['--probe-seconds=30'],
    ['--case=z17', '--probe-seconds=10'],
    ['--case=z17', '--case=z18'],
  ])
    expect(() => diagnosticFlags(args)).toThrow();
});

it('keeps a frozen input root explicit without changing matrix coverage or horizons', () => {
  const flags = diagnosticFlags([
    '--input-root',
    'D:/task/frozen inputs',
    '--baseline=d2d3d656',
    '--output=D:/task/pre.json',
  ]);
  expect(flags.inputRoot).toBe('D:/task/frozen inputs');
  expect(flags.prefix).toBe('');
  expect(flags.probe).toBeUndefined();
  expect(diagnosticFlags(['--input-root=D:/task/inputs']).inputRoot).toBe('D:/task/inputs');
  expect(() => diagnosticFlags(['--input-root'])).toThrow('Missing value');
  expect(() => diagnosticFlags(['--input-root=a', '--input-root=b'])).toThrow('repeated');
});

it('rejects resumes after any executed measurement harness file changes', () => {
  const files = diagnosticHarnessFiles.map((path) => ({ path, content: 'original\r\n' }));
  const prior = diagnosticObserverHash(files);
  expect(() =>
    requireDiagnosticObserver(
      prior,
      diagnosticObserverHash(files.map((f) => ({ ...f, content: 'original\n' }))),
    ),
  ).not.toThrow();
  for (let i = 0; i < files.length; i++) {
    const changed = files.map((file, index) =>
      index === i ? { ...file, content: 'changed' } : file,
    );
    expect(() => requireDiagnosticObserver(prior, diagnosticObserverHash(changed))).toThrow(
      'measurement harness differs',
    );
  }
});

it('converts diagnostic bodies into the reference frame without changing heading', () => {
  expect(
    referenceBodies([{ x: 2, y: 3, length: 4, width: 2, hx: 0, hy: 1 }], {
      x: 10,
      y: 20,
      scale: 2,
    }),
  ).toEqual([{ x: 14, y: 26, length: 8, width: 4, hx: 0, hy: 1 }]);
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
