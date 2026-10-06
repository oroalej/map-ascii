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
