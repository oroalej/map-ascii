export const PROFILE_CAPACITY = 4096;
export const PROFILE_STAGES = [
  'callback',
  'draw',
  'step',
  'clearanceBuild',
  'clearanceChecks',
  'visible',
  'pack',
  'upload',
  'sync',
  'terrainRebuild',
  'terrainSnapshot',
  'terrainEncode',
  'lifeLatency',
  'spawn',
  'settle',
  'terrainRoads',
  'terrainRevalidate',
  'tileUpload',
  'replyClone',
  'syncPost',
] as const;
export type ProfileStage = (typeof PROFILE_STAGES)[number];
export type ProfileSample = {
  at: number;
  drawn: boolean;
  agents: number;
  checks: number;
  ms: Partial<Record<ProfileStage, number>>;
};
export type AtlasProfile = {
  capacity: number;
  dropped: number;
  spanMs: number;
  gpuRenderer: string | null;
  samples: ProfileSample[];
  stages: Record<ProfileStage, { count: number; medianMs: number | null; p95Ms: number | null }>;
};

/** Allocated only when requested. Samples are bounded; quantiles are computed off the frame path. */
export class FrameProfiler {
  private readonly ring = new Array<ProfileSample | undefined>(PROFILE_CAPACITY);
  private cursor = 0;
  private count = 0;
  private dropped = 0;
  private current: ProfileSample | undefined;
  private pending: ProfileSample | undefined;
  private started = 0;
  constructor(private readonly now: () => number = () => performance.now()) {}
  begin(at: number) {
    this.started = this.now();
    this.current = { at, drawn: false, agents: 0, checks: 0, ms: {} };
    if (this.pending) {
      this.merge(this.pending);
      this.pending = undefined;
    }
  }
  time() {
    return this.now();
  }
  add(stage: ProfileStage, elapsed: number) {
    if (this.current) this.current.ms[stage] = (this.current.ms[stage] ?? 0) + elapsed;
  }
  /** Also retain measurements that finish between animation callbacks. */
  record(stage: ProfileStage, elapsed: number) {
    this.merge({ at: 0, drawn: false, agents: 0, checks: 0, ms: { [stage]: elapsed } });
  }
  check() {
    if (this.current) this.current.checks++;
  }
  /** Take a worker sample without adding callback timing or retaining it in the ring. */
  drain(): ProfileSample | undefined {
    const sample = this.current;
    this.current = undefined;
    return sample;
  }
  /** Worker replies arrive between callbacks; carry their stages into the next sample. */
  merge(sample: ProfileSample) {
    const target =
      this.current ??
      (this.pending ??= {
        at: sample.at,
        drawn: false,
        agents: 0,
        checks: 0,
        ms: {},
      });
    for (const stage of PROFILE_STAGES)
      if (sample.ms[stage] !== undefined)
        target.ms[stage] = (target.ms[stage] ?? 0) + sample.ms[stage];
    target.checks += sample.checks;
  }
  draw(elapsed: number, agents: number) {
    if (!this.current) return;
    this.current.drawn = true;
    this.current.agents = agents;
    this.add('draw', elapsed);
  }
  end() {
    if (!this.current) return;
    this.add('callback', this.now() - this.started);
    if (this.count === PROFILE_CAPACITY) this.dropped++;
    this.ring[this.cursor] = this.current;
    this.cursor = (this.cursor + 1) % PROFILE_CAPACITY;
    this.count = Math.min(PROFILE_CAPACITY, this.count + 1);
    this.current = undefined;
  }
  reset() {
    this.ring.fill(undefined);
    this.cursor = this.count = 0;
    this.dropped = 0;
    this.current = undefined;
    this.pending = undefined;
  }
  snapshot(gpuRenderer: string | null = null): AtlasProfile {
    const samples: ProfileSample[] = [];
    for (let i = 0; i < this.count; i++) {
      const sample =
        this.ring[(this.cursor - this.count + i + PROFILE_CAPACITY) % PROFILE_CAPACITY]!;
      samples.push({ ...sample, ms: { ...sample.ms } });
    }
    const stages = Object.fromEntries(
      PROFILE_STAGES.map((stage) => {
        const values = samples
          .flatMap((s) => (s.ms[stage] === undefined ? [] : [s.ms[stage]]))
          .sort((a, b) => a - b);
        const quantile = (q: number) =>
          values.length
            ? values[Math.min(values.length - 1, Math.floor(values.length * q))]!
            : null;
        return [stage, { count: values.length, medianMs: quantile(0.5), p95Ms: quantile(0.95) }];
      }),
    ) as AtlasProfile['stages'];
    const spanMs = samples.length ? samples.at(-1)!.at - samples[0]!.at : 0;
    return {
      capacity: PROFILE_CAPACITY,
      dropped: this.dropped,
      spanMs,
      gpuRenderer,
      samples,
      stages,
    };
  }
}
