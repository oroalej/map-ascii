import type {
  ContinuityCounter,
  ContinuitySample,
  TravelerTrace,
  LifeDiagnostics,
} from './life/diagnostics';

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
  'acceptedFrameAge',
  'prepareSlice',
  'activation',
] as const;
export type ProfileStage = (typeof PROFILE_STAGES)[number];
export type ProfileSample = {
  at: number;
  drawn: boolean;
  agents: number;
  checks: number;
  ms: Partial<Record<ProfileStage, number>>;
  continuity?: ContinuitySample;
  /** Individual cooperative slices; ms keeps their complete CPU sum. */
  preparationSlices?: number[];
};
export type AtlasProfile = {
  capacity: number;
  dropped: number;
  spanMs: number;
  gpuRenderer: string | null;
  samples: ProfileSample[];
  stages: Record<ProfileStage, { count: number; medianMs: number | null; p95Ms: number | null }>;
  continuity: ContinuitySample;
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
  private identities = new WeakMap<object, string>();
  private incarnations = new Map<string, number>();
  private selected: string | undefined;
  private selectionOverride = false;
  private trace: TravelerTrace[] = [];
  constructor(
    private readonly now: () => number = () => performance.now(),
    readonly lifeDiagnostics?: LifeDiagnostics,
  ) {}
  registerPopulation(tile: string, movers: readonly object[]) {
    const incarnation = (this.incarnations.get(tile) ?? 0) + 1;
    this.incarnations.set(tile, incarnation);
    movers.forEach((m, ordinal) => this.identities.set(m, `${tile}#${incarnation}:${ordinal}`));
  }
  identity(m: object) {
    return this.identities.get(m);
  }
  tracing(m: object) {
    return this.selected !== undefined && this.identity(m) === this.selected;
  }
  /** Test/debug override; undefined restores automatic first-visible vehicle selection. */
  selectTraveler(id?: string) {
    this.selected = id;
    this.selectionOverride = id !== undefined;
  }
  observeVisible(m: object, eligible: boolean) {
    if (!this.selected && !this.selectionOverride && eligible) this.selected = this.identity(m);
  }
  countContinuity(event: ContinuityCounter, amount = 1) {
    const sample =
      this.current ?? (this.pending ??= { at: 0, drawn: false, agents: 0, checks: 0, ms: {} });
    const data = (sample.continuity ??= { counts: {}, trace: [] });
    data.counts[event] = (data.counts[event] ?? 0) + amount;
  }
  traceTraveler(m: object, value: Omit<TravelerTrace, 'id'>) {
    const id = this.identity(m);
    if (!id || id !== this.selected) return;
    const sample =
      this.current ?? (this.pending ??= { at: 0, drawn: false, agents: 0, checks: 0, ms: {} });
    const data = (sample.continuity ??= { counts: {}, trace: [] });
    if (data.trace.length === PROFILE_CAPACITY) data.trace.shift();
    data.trace.push({ id, ...value });
  }
  clearContinuity(clearIdentities = true) {
    if (clearIdentities) {
      this.identities = new WeakMap();
      this.incarnations.clear();
    }
    this.selected = undefined;
    this.selectionOverride = false;
    this.trace = [];
    if (this.current) delete this.current.continuity;
    if (this.pending) delete this.pending.continuity;
    for (const sample of this.ring) if (sample) delete sample.continuity;
  }
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
  preparationSlice(elapsed: number) {
    const sample =
      this.current ?? (this.pending ??= { at: 0, drawn: false, agents: 0, checks: 0, ms: {} });
    sample.ms.prepareSlice = (sample.ms.prepareSlice ?? 0) + elapsed;
    const slices = (sample.preparationSlices ??= []);
    slices.push(elapsed);
    if (slices.length > PROFILE_CAPACITY) slices.shift();
  }
  /** Also retain measurements that finish between animation callbacks. */
  record(stage: ProfileStage, elapsed: number) {
    this.merge({ at: 0, drawn: false, agents: 0, checks: 0, ms: { [stage]: elapsed } });
  }
  gauge(stage: ProfileStage, value: number) {
    const sample =
      this.current ?? (this.pending ??= { at: 0, drawn: false, agents: 0, checks: 0, ms: {} });
    sample.ms[stage] = value;
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
    if (sample.preparationSlices) {
      const slices = (target.preparationSlices ??= []);
      slices.push(...sample.preparationSlices);
      if (slices.length > PROFILE_CAPACITY) slices.splice(0, slices.length - PROFILE_CAPACITY);
    }
    if (sample.continuity) {
      const data = (target.continuity ??= { counts: {}, trace: [] });
      for (const [event, count] of Object.entries(sample.continuity.counts)) {
        const key = event as ContinuityCounter;
        data.counts[key] = (data.counts[key] ?? 0) + count;
      }
      data.trace.push(...sample.continuity.trace);
      if (data.trace.length > PROFILE_CAPACITY)
        data.trace.splice(0, data.trace.length - PROFILE_CAPACITY);
    }
  }
  draw(elapsed: number, agents: number) {
    if (!this.current) return;
    this.current.drawn = true;
    this.current.agents = agents;
    this.add('draw', elapsed);
  }
  end() {
    if (!this.current) return;
    if (this.current.continuity) {
      this.trace.push(...this.current.continuity.trace);
      if (this.trace.length > PROFILE_CAPACITY)
        this.trace.splice(0, this.trace.length - PROFILE_CAPACITY);
      this.current.continuity.trace = [];
    }
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
    this.clearContinuity(false);
  }
  snapshot(gpuRenderer: string | null = null): AtlasProfile {
    const samples: ProfileSample[] = [];
    for (let i = 0; i < this.count; i++) {
      const sample =
        this.ring[(this.cursor - this.count + i + PROFILE_CAPACITY) % PROFILE_CAPACITY]!;
      samples.push(structuredClone(sample));
    }
    const stages = Object.fromEntries(
      PROFILE_STAGES.map((stage) => {
        const values = samples
          .flatMap((s) =>
            stage === 'prepareSlice' && s.preparationSlices
              ? s.preparationSlices
              : s.ms[stage] === undefined
                ? []
                : [s.ms[stage]],
          )
          .sort((a, b) => a - b);
        const quantile = (q: number) =>
          values.length
            ? values[Math.min(values.length - 1, Math.floor(values.length * q))]!
            : null;
        return [stage, { count: values.length, medianMs: quantile(0.5), p95Ms: quantile(0.95) }];
      }),
    ) as AtlasProfile['stages'];
    const spanMs = samples.length ? samples.at(-1)!.at - samples[0]!.at : 0;
    const continuity: ContinuitySample = { counts: {}, trace: [] };
    for (const sample of samples)
      if (sample.continuity) {
        for (const [event, count] of Object.entries(sample.continuity.counts)) {
          const key = event as ContinuityCounter;
          continuity.counts[key] = (continuity.counts[key] ?? 0) + count;
        }
      }
    continuity.trace = structuredClone(this.trace);
    return {
      capacity: PROFILE_CAPACITY,
      dropped: this.dropped,
      spanMs,
      gpuRenderer,
      samples,
      stages,
      continuity,
    };
  }
}
