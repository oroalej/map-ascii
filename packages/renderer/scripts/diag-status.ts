import { createHash } from 'node:crypto';

export const diagnosticCases = [17, 16, 18, 15, 19].flatMap((zoom) =>
  [720, 1080].flatMap((minutes) =>
    [1, 0.4].flatMap((crowd) =>
      (['fixed', 'pan'] as const).map((mode) => ({
        key: `z${zoom}/${minutes}/crowd${crowd}/${mode}`,
        zoom,
        minutes,
        crowd,
        mode,
      })),
    ),
  ),
);

export function diagnosticFlags(args: readonly string[]) {
  const values = new Map<string, string>();
  let resume = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') continue;
    if (arg === '--resume' && !resume) {
      resume = true;
      continue;
    }
    const match = /^(--output|--case|--baseline|--probe-seconds)(?:=(.*))?$/.exec(arg);
    if (!match || values.has(match[1]!))
      throw new Error(`Unknown or repeated diagnostic option: ${arg}`);
    const value = match[2] ?? args[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${match[1]}`);
    values.set(match[1]!, value);
  }
  const output = values.get('--output'),
    prefix = values.get('--case') ?? '',
    baseline = values.get('--baseline');
  const probe = values.get('--probe-seconds');
  if (resume && !output) throw new Error('--resume requires an existing --output report');
  if (probe && (!prefix || baseline || !['30', '60'].includes(probe)))
    throw new Error(
      '--probe-seconds=30|60 requires a case prefix and the current engine; probes do not satisfy acceptance',
    );
  if (baseline && !output)
    throw new Error('--baseline requires --output so snapshots stay beside the report');
  if (!diagnosticCases.some((c) => c.key.startsWith(prefix)))
    throw new Error(`No diagnostic cases match ${JSON.stringify(prefix)}`);
  return { output, prefix, baseline, probe, resume };
}

/** The currently executed observer and measurement harness qualify immutable engine snapshots. */
export const diagnosticHarnessFiles = [
  'packages/renderer/src/life/diagnostics.ts',
  ...['diag-life', 'diag-status', 'observe-life', 'archive', 'snapshot', 'paired'].map(
    (name) => `packages/renderer/scripts/${name}.ts`,
  ),
];

export function diagnosticObserverHash(files: readonly { path: string; content: string }[]) {
  const hash = createHash('sha256');
  for (const file of files)
    hash.update(file.path).update('\0').update(file.content.replace(/\r\n/g, '\n')).update('\0');
  return hash.digest('hex');
}

export function requireDiagnosticObserver(previous: unknown, current: string) {
  if (previous !== current)
    throw new Error('Cannot resume: diagnostic measurement harness differs');
}

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
