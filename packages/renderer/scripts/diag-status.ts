/** Matrix coverage and full-length acceptance qualification are separate. */
export function diagnosticCompletion(
  finished: boolean,
  cases: number,
  expected: number,
  selected: number,
  probe: boolean,
) {
  return {
    complete: !probe && finished && cases === expected,
    selectionComplete: finished && cases === selected,
  };
}

/** Older engines must not silently produce empty observer measurements. */
export function requireDiagnosticProfiler(
  profiler: { readonly lifeDiagnostics?: unknown },
  observer: object,
) {
  if (profiler.lifeDiagnostics !== observer)
    throw new Error('Selected engine does not support the life diagnostics profiler hook');
}

const UNWRITTEN_OUTCOME = 255;

export function diagnosticPackingOutcomes(count: number): Uint8Array {
  return new Uint8Array(count).fill(UNWRITTEN_OUTCOME);
}

export function requireDiagnosticPacking(outcomes: Uint8Array) {
  if (outcomes.includes(UNWRITTEN_OUTCOME))
    throw new Error('Selected engine does not write life diagnostics packing outcomes');
}
