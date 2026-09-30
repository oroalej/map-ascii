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
  samples: ProfileSample[];
  stages: Record<ProfileStage, { count: number; medianMs: number | null; p95Ms: number | null }>;
};

/** Allocated only when requested. Samples are bounded; quantiles are computed off the frame path. */
export class FrameProfiler {
  private readonly ring = new Array<ProfileSample | undefined>(PROFILE_CAPACITY);
  private cursor = 0;
  private count = 0;
  private current: ProfileSample | undefined;
  private started = 0;
  constructor(private readonly now: () => number = () => performance.now()) {}
  begin(at: number) {
    this.started = this.now();
    this.current = { at, drawn: false, agents: 0, checks: 0, ms: {} };
  }
  time() {
    return this.now();
  }
  add(stage: ProfileStage, elapsed: number) {
    if (this.current) this.current.ms[stage] = (this.current.ms[stage] ?? 0) + elapsed;
  }
  check() {
    if (this.current) this.current.checks++;
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
    this.ring[this.cursor] = this.current;
    this.cursor = (this.cursor + 1) % PROFILE_CAPACITY;
    this.count = Math.min(PROFILE_CAPACITY, this.count + 1);
    this.current = undefined;
  }
  reset() {
    this.ring.fill(undefined);
    this.cursor = this.count = 0;
    this.current = undefined;
  }
  snapshot(): AtlasProfile {
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
    return { capacity: PROFILE_CAPACITY, samples, stages };
  }
}
