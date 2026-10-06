import { expect, it } from 'vitest';
import { diagnosticCompletion } from './diag-status';

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

it.each([30, 60])('never qualifies a full-selection %s-second probe as acceptance', () => {
  expect(diagnosticCompletion(true, 40, 40, 40, true)).toEqual({
    complete: false,
    selectionComplete: true,
  });
});
