export const quantile = (values: readonly number[], q: number) => {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
};
export const summary = (values: readonly number[]) => ({
  median: quantile(values, 0.5),
  p95: quantile(values, 0.95),
});
export const pooledSummary = <R>(runs: readonly R[], samples: (run: R) => number[]) =>
  summary(runs.flatMap(samples));
export const withinControl = (change: { medianGain: number; p95Change: number }, limit = 0.05) =>
  Math.abs(change.medianGain) <= limit && Math.abs(change.p95Change) <= limit;

type Arm<R> = { sample(frame: number, retained: boolean): void; result(): R };
type Protocol = {
  calibration: number;
  warmup: number;
  samples: number;
  runs: number;
  interleaved: boolean;
};

/** Fresh arms per pair; discard calibration and balance which arm runs first. */
export function pairedRuns<A, B>(before: () => Arm<A>, after: () => Arm<B>, protocol: Protocol) {
  const { calibration, warmup, samples, runs, interleaved } = protocol;
  if (
    ![calibration, warmup, samples, runs].every((n) => Number.isInteger(n) && n >= 0) ||
    !samples ||
    !runs ||
    runs % 2
  )
    throw new Error('Use nonnegative frame counts, positive samples and even paired runs');
  const calibrationA = before(),
    calibrationB = after();
  for (let frame = 0; frame < calibration; frame++) {
    const first = frame % 2 ? calibrationB : calibrationA,
      second = frame % 2 ? calibrationA : calibrationB;
    first.sample(frame, false);
    second.sample(frame, false);
  }
  const oldRuns: A[] = [],
    currentRuns: B[] = [];
  for (let run = 0; run < runs; run++) {
    const a = before(),
      b = after();
    const first = run % 2 ? b : a,
      second = run % 2 ? a : b;
    if (interleaved) {
      for (let frame = 0; frame < warmup + samples; frame++) {
        first.sample(frame, frame >= warmup);
        second.sample(frame, frame >= warmup);
      }
    } else {
      for (const arm of [first, second])
        for (let frame = 0; frame < warmup + samples; frame++) arm.sample(frame, frame >= warmup);
    }
    oldRuns.push(a.result());
    currentRuns.push(b.result());
  }
  return { oldRuns, currentRuns };
}
