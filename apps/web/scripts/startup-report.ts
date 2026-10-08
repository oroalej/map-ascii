import { isAbsolute } from 'node:path';

export type StartupOptions = {
  runs: number;
  output: string;
  baseline?: string | undefined;
  control: boolean;
  interleaved: boolean;
};
export type StartupSample = {
  arm: string;
  run: number;
  readyMs?: number;
  error?: string;
  workerTargets?: number;
};
export function startupOptions(args: readonly string[]): StartupOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (['--startup', '--control', '--interleaved'].includes(arg)) {
      flags.add(arg);
      continue;
    }
    const [key, inline] = arg.split('=', 2);
    if (!['--runs', '--output', '--baseline'].includes(key!))
      throw new Error(`Unknown startup argument: ${arg}`);
    const value = inline ?? args[++i];
    if (!value || value.startsWith('--') || values.has(key!)) throw new Error(`Invalid ${key}`);
    values.set(key!, value);
  }
  const runs = Number(values.get('--runs') ?? 8),
    output = values.get('--output');
  if (!Number.isInteger(runs) || runs < 2 || runs % 2 !== 0)
    throw new Error('--runs must be a positive even count of at least two per arm');
  if (!output || !isAbsolute(output))
    throw new Error('--output must be an absolute task-folder path');
  const baseline = values.get('--baseline');
  if (baseline && !isAbsolute(baseline))
    throw new Error('--baseline must be an absolute export-directory path');
  if (baseline && flags.has('--control')) throw new Error('--control cannot use --baseline');
  return {
    runs,
    output,
    baseline,
    control: flags.has('--control'),
    interleaved: flags.has('--interleaved'),
  };
}
export function startupOrder(options: StartupOptions) {
  const arms = options.control
    ? ['controlA', 'controlB']
    : options.baseline
      ? ['baseline', 'candidate']
      : ['candidate'];
  if (!options.interleaved)
    return arms.flatMap((arm) => Array.from({ length: options.runs }, (_, run) => ({ arm, run })));
  return Array.from({ length: options.runs }, (_, run) =>
    (run % 2 ? [...arms].reverse() : arms).map((arm) => ({ arm, run })),
  ).flat();
}
export function startupSummary(samples: readonly StartupSample[], options: StartupOptions) {
  const arms: Record<string, { medianMs: number; p75Ms: number; samples: number }> = {};
  for (const { arm, run } of startupOrder(options)) {
    const matching = samples.filter((s) => s.arm === arm && s.run === run);
    if (
      matching.length !== 1 ||
      matching[0]!.error ||
      !Number.isFinite(matching[0]!.readyMs) ||
      matching[0]!.readyMs! < 0
    )
      throw new Error(`Missing or failed startup sample ${arm}/${run}`);
  }
  if (samples.length !== startupOrder(options).length)
    throw new Error('Unexpected startup samples');
  for (const arm of new Set(samples.map((s) => s.arm))) {
    const values = samples
      .filter((s) => s.arm === arm)
      .map((s) => s.readyMs!)
      .sort((a, b) => a - b);
    arms[arm] = {
      medianMs: (values[values.length / 2 - 1]! + values[values.length / 2]!) / 2,
      p75Ms: values[Math.ceil(values.length * 0.75) - 1]!,
      samples: values.length,
    };
  }
  return {
    arms,
    controlSpreadMs: options.control
      ? Math.abs(arms.controlA!.medianMs - arms.controlB!.medianMs)
      : null,
    budgetMs: 2500,
    budgetMet: Object.fromEntries(
      Object.entries(arms).map(([arm, value]) => [arm, value.medianMs < 2500]),
    ),
  };
}
