/** Device quality changes drawing only; the simulation always receives its original inputs. */
export type QualityChoice = 'auto' | 'high' | 'low';
export type Knobs = {
  crowd: number;
  throng: number;
  maxAgents: number;
  crownSway: boolean;
  groundWind: boolean;
  shadows: boolean;
  clouds: boolean;
  waterDetail: boolean;
  fish: boolean;
  beams: boolean;
  maxDpr: number;
};
const high: Knobs = {
  crowd: 1,
  throng: 1,
  maxAgents: 1200,
  crownSway: true,
  groundWind: true,
  shadows: true,
  clouds: true,
  waterDetail: true,
  fish: true,
  beams: true,
  maxDpr: Infinity,
};
const effects: Knobs = {
  ...high,
  crowd: 0.4,
  throng: 0.5,
  maxAgents: 500,
  crownSway: false,
  groundWind: false,
  shadows: false,
  clouds: false,
  waterDetail: false,
  fish: false,
  beams: false,
};
export const TIERS = [
  { name: 'high', knobs: high },
  { name: 'crowd', knobs: { ...high, crowd: 0.6, throng: 0.7, maxAgents: 700 } },
  { name: 'effects', knobs: effects },
  { name: 'pixels', knobs: { ...effects, crowd: 0.3, maxDpr: 1.25 } },
] as const;
export type QualityState = {
  choice: QualityChoice;
  tier: number;
  name: (typeof TIERS)[number]['name'];
};
export const QUALITY = {
  windowMs: 10_000,
  capacity: 4096,
  minSamples: 45,
  decisionMs: 250,
  slowMs: 25,
  slowHoldMs: 3000,
  severeMs: 40,
  severeHoldMs: 1500,
  cooldownMs: 8000,
  probeMs: 15_000,
  probeFailureMs: 10_000,
  maxProbeMs: 240_000,
  recoverIntervalMs: 20,
  recoverCpuMs: 10,
  staleMs: 1000,
};
type Sample = { at: number; intervalMs: number; cpuMs: number; gpuMs: number | null };
const percentile = (values: number[], q: number) => {
  values.sort((a, b) => a - b);
  return values[Math.min(values.length - 1, Math.floor(values.length * q))]!;
};

export class QualityController {
  private applied: number;
  private selected: QualityChoice;
  private forced?: number;
  private samples: Sample[] = [];
  private firstAt?: number;
  private changedAt = -Infinity;
  private nextCheck = -Infinity;
  private slowAt?: number;
  private severeAt?: number;
  private probeAt?: number;
  private probeWait: number;
  constructor(
    choice: QualityChoice,
    private readonly cfg = QUALITY,
  ) {
    this.selected = choice;
    this.applied = choice === 'low' ? 3 : 0;
    this.probeWait = cfg.probeMs;
  }
  get tier() {
    return this.applied;
  }
  get choice() {
    return this.selected;
  }
  get state(): QualityState {
    return { choice: this.choice, tier: this.tier, name: TIERS[this.tier]!.name };
  }
  setChoice(choice: QualityChoice) {
    if (choice === this.selected) return;
    this.selected = choice;
    this.forced = choice === 'low' ? 3 : 0;
    this.probeAt = undefined;
    this.probeWait = this.cfg.probeMs;
    this.reset();
  }
  reset() {
    this.samples = [];
    this.firstAt = this.slowAt = this.severeAt = undefined;
    this.nextCheck = -Infinity;
  }
  sample(s: Sample) {
    if (
      this.choice !== 'auto' ||
      !Number.isFinite(s.at) ||
      !Number.isFinite(s.intervalMs) ||
      !Number.isFinite(s.cpuMs) ||
      s.intervalMs <= 0 ||
      s.cpuMs < 0
    )
      return;
    if (this.samples.length && s.at <= this.samples.at(-1)!.at) return;
    this.firstAt ??= s.at;
    this.samples.push({ ...s });
    let remove = 0;
    while (remove < this.samples.length && this.samples[remove]!.at < s.at - this.cfg.windowMs)
      remove++;
    remove = Math.max(remove, this.samples.length - this.cfg.capacity);
    if (remove > 0) this.samples.splice(0, remove);
  }
  decide(at: number, quiet: boolean): number | undefined {
    if (this.forced !== undefined) {
      if (!quiet) return;
      const tier = this.forced;
      this.forced = undefined;
      return this.apply(tier, at);
    }
    if (this.choice !== 'auto' || at < this.nextCheck) return;
    this.nextCheck = at + this.cfg.decisionMs;
    const latest = this.samples.at(-1);
    if (!latest || at - latest.at > this.cfg.staleMs) {
      this.slowAt = this.severeAt = undefined;
      return;
    }
    const samples = this.samples.filter((s) => at - s.at <= this.cfg.windowMs);
    if (samples.length < this.cfg.minSamples) return;
    const intervals = samples.map((s) => s.intervalMs);
    const p75 = percentile(intervals, 0.75);
    this.slowAt = p75 > this.cfg.slowMs ? (this.slowAt ?? at) : undefined;
    this.severeAt = p75 > this.cfg.severeMs ? (this.severeAt ?? at) : undefined;
    const down =
      (this.slowAt !== undefined && at - this.slowAt >= this.cfg.slowHoldMs) ||
      (this.severeAt !== undefined && at - this.severeAt >= this.cfg.severeHoldMs);
    if (this.probeAt !== undefined && at - this.probeAt > this.cfg.probeFailureMs) {
      this.probeAt = undefined;
      this.probeWait = this.cfg.probeMs;
    }
    if (!quiet || at - this.changedAt < this.cfg.cooldownMs) return;
    if (down && this.tier < 3) {
      if (this.probeAt !== undefined && at - this.probeAt <= this.cfg.probeFailureMs) {
        this.probeWait = Math.min(this.probeWait * 2, this.cfg.maxProbeMs);
        this.probeAt = undefined;
      }
      return this.apply(this.tier + 1, at);
    }
    if (
      this.tier > 0 &&
      at - this.changedAt >= this.probeWait &&
      at - this.firstAt! >= this.cfg.windowMs &&
      percentile(intervals, 0.9) <= this.cfg.recoverIntervalMs &&
      percentile(
        samples.map((s) => s.cpuMs),
        0.75,
      ) <= this.cfg.recoverCpuMs
    ) {
      this.probeAt = at;
      return this.apply(this.tier - 1, at);
    }
  }
  private apply(tier: number, at: number) {
    this.applied = tier;
    this.changedAt = at;
    this.reset();
    return tier;
  }
}
