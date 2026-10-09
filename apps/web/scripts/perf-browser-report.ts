import { isAbsolute } from 'node:path';

/** Matched browser scenes (`pnpm perf:browser --scene <scene> --output <absolute path>`). */
export const SCENES = ['idle', 'pan', 'zoom', 'night', 'fiesta'] as const;
export type Scene = (typeof SCENES)[number];
export type BrowserOptions = {
  /** `--startup` hands every argument to startup-browser.ts. */
  startup: boolean;
  /** The legacy `--pan` capture, kept for its existing root report. */
  pan: boolean;
  scene?: Scene;
  output?: string;
};

export function browserOptions(args: readonly string[]): BrowserOptions {
  if (args.includes('--startup')) return { startup: true, pan: false };
  const values = new Map<string, string>();
  let pan = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') continue;
    if (arg === '--pan') {
      pan = true;
      continue;
    }
    const [key, inline] = arg.split('=', 2);
    if (key !== '--scene' && key !== '--output')
      throw new Error(`Unknown perf:browser argument: ${arg}`);
    const value = inline ?? args[++i];
    if (!value || value.startsWith('--') || values.has(key)) throw new Error(`Invalid ${key}`);
    values.set(key, value);
  }
  const scene = values.get('--scene');
  const output = values.get('--output');
  if (scene !== undefined && !SCENES.includes(scene as Scene))
    throw new Error(`--scene must be one of ${SCENES.join(', ')}`);
  if (scene !== undefined && pan) throw new Error('Use --scene pan instead of --pan with --scene');
  if (scene !== undefined && (!output || !isAbsolute(output)))
    throw new Error('--scene requires --output with an absolute task-folder path');
  if (scene === undefined && output !== undefined) throw new Error('--output requires --scene');
  return {
    startup: false,
    pan,
    ...(scene !== undefined && { scene: scene as Scene }),
    ...(output !== undefined && { output }),
  };
}

/** The parts of a downloaded `atlas-profile.json` the summary reads. */
type Sample = { at: number; drawn: boolean; ms: Partial<Record<string, number>> };
export type CapturedProfile = {
  dropped: number;
  spanMs: number;
  samples: readonly Sample[];
};
export type CapturedStats = { lifeMs: number; cellPassMs: number; frameMs: number; fps: number };
export type LongTask = { startTime: number; duration: number };

/** Stages reported per scene; a stage never recorded is `missing`, not zero cost. */
export const SUMMARY_STAGES = [
  'callback',
  'draw',
  'replyClone',
  'activation',
  'sync',
  'syncPost',
  'pack',
  'upload',
  'step',
  'visible',
] as const;
export type StageSummary =
  { missing: true; count: 0; p95Ms: null } | { missing: false; count: number; p95Ms: number };

const quantile = (sorted: readonly number[], q: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]! : null;
const sorted = (values: number[]) => values.sort((a, b) => a - b);

/** Intervals between successive drawn samples, in capture order. */
export function drawnIntervals(samples: readonly Sample[]): number[] {
  const out: number[] = [];
  let previous: number | undefined;
  for (const sample of samples) {
    if (!sample.drawn) continue;
    if (previous !== undefined && sample.at > previous) out.push(sample.at - previous);
    previous = sample.at;
  }
  return out;
}

export function summarize(
  profile: CapturedProfile,
  stats: CapturedStats | undefined,
  longTasks: readonly LongTask[],
) {
  const intervals = sorted(drawnIntervals(profile.samples));
  const drawn = profile.samples.filter((s) => s.drawn);
  const span = drawn.length > 1 ? drawn.at(-1)!.at - drawn[0]!.at : 0;
  const stages = Object.fromEntries(
    SUMMARY_STAGES.map((stage): [string, StageSummary] => {
      const values = sorted(
        profile.samples.flatMap((s) => (s.ms[stage] === undefined ? [] : [s.ms[stage]])),
      );
      return [
        stage,
        values.length
          ? { missing: false, count: values.length, p95Ms: quantile(values, 0.95)! }
          : { missing: true, count: 0, p95Ms: null },
      ];
    }),
  ) as Record<(typeof SUMMARY_STAGES)[number], StageSummary>;
  const drawnCallbacks = sorted(
    drawn.flatMap((s) => (s.ms.callback === undefined ? [] : [s.ms.callback])),
  );
  return {
    samples: profile.samples.length,
    droppedSamples: profile.dropped,
    drawnFrames: drawn.length,
    drawnFps: span > 0 ? ((drawn.length - 1) * 1000) / span : null,
    frameIntervalP50Ms: quantile(intervals, 0.5),
    frameIntervalP95Ms: quantile(intervals, 0.95),
    callbackP95Ms: stages.callback.p95Ms,
    drawnCallbackP95Ms: quantile(drawnCallbacks, 0.95),
    stages,
    smoothed: stats
      ? { lifeMs: stats.lifeMs, cellPassMs: stats.cellPassMs, frameMs: stats.frameMs }
      : null,
    longTasks: {
      count: longTasks.length,
      totalMs: longTasks.reduce((sum, task) => sum + task.duration, 0),
    },
  };
}
export type SceneSummary = ReturnType<typeof summarize>;
