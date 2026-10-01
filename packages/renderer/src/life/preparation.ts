import type { FrameProfiler } from '../profile';
import { EXTENT, lngLatToTile } from '../raster/geometry';
import type { LifeViewContext } from './births';
import { overlaps } from './frames';
import type { LifeWorld, LifeTile, TileLife } from './simulate';

export const PREPARATION = { queued: 8, ready: 4, sliceMs: 2 } as const;
type Job = { entry: LifeTile; work: Generator<void, TileLife, void> };

/** Private resumable instances: only complete tiles may enter the live world. */
export class LifePreparation {
  private wanted: readonly LifeTile[] = [];
  private queued: Job[] = [];
  private running?: Job;
  private ready = new Map<string, TileLife>();
  private activation?: Generator<void, void, void>;
  private activationEntries?: LifeTile[];
  private activationPlan?: LifeTile[];
  private activatingKeys?: string;
  private bootstrap?: Set<string>;
  private bootstrapBounds?: string;
  private focus?: readonly [number, number];
  private view?: LifeViewContext;
  private epoch: number;
  private dirty = false;
  constructor(
    private readonly world: LifeWorld,
    private readonly profiler?: FrameProfiler,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.epoch = world.preparationEpoch;
  }

  clear() {
    this.wanted = [];
    this.queued = [];
    this.running = undefined;
    this.ready.clear();
    this.activation = undefined;
    this.activationEntries = undefined;
    this.activationPlan = undefined;
    this.activatingKeys = undefined;
    this.bootstrap = undefined;
    this.view = undefined;
    this.dirty = false;
    this.epoch = this.world.preparationEpoch;
  }

  sync(entries: readonly LifeTile[], focus?: readonly [number, number], view?: LifeViewContext) {
    if (this.epoch !== this.world.preparationEpoch) this.clear();
    if (!view) {
      this.clear();
      this.world.sync(entries, focus);
      return;
    }
    this.wanted = entries;
    this.focus = focus;
    this.view = view;
    this.dirty = true;
    if (!this.bootstrap && !this.world.hasBootstrapped() && entries.length) {
      this.bootstrap = new Set(entries.map((entry) => entry.key));
      this.bootstrapBounds = view.bounds.join(',');
    }
    const keep = new Set(entries.map((entry) => entry.key));
    this.queued = this.queued.filter((job) => keep.has(job.entry.key));
    if (this.running && !keep.has(this.running.entry.key)) this.running = undefined;
    for (const key of this.ready.keys()) if (!keep.has(key)) this.ready.delete(key);
    if (
      this.activatingKeys !==
      this.entries()
        .map((entry) => entry.key)
        .sort()
        .join('|')
    ) {
      this.activation = undefined;
      this.activationEntries = undefined;
      this.activatingKeys = undefined;
      this.activationPlan = undefined;
    }
    this.fill();
  }

  private ordered() {
    const rank = (entry: LifeTile) => {
      if (!this.view) return [0, 0];
      const [west, south, east, north] = this.view.bounds;
      const a = lngLatToTile(entry.tile, west, north),
        b = lngLatToTile(entry.tile, east, south);
      const visible = a.x < EXTENT && b.x > 0 && a.y < EXTENT && b.y > 0;
      const x = (a.x + b.x) / 2 - EXTENT / 2,
        y = (a.y + b.y) / 2 - EXTENT / 2;
      return [visible ? 0 : 1, (x * x + y * y) / 2 ** (2 * entry.tile.z)];
    };
    return [...this.wanted].sort((a, b) => {
      const ar = rank(a),
        br = rank(b);
      return ar[0]! - br[0]! || ar[1]! - br[1]! || a.key.localeCompare(b.key);
    });
  }

  private fill() {
    const previous = new Map(this.queued.map((job) => [job.entry.key, job]));
    this.queued = [];
    for (const entry of this.ordered()) {
      if (this.queued.length >= PREPARATION.queued) break;
      if (
        this.ready.has(entry.key) ||
        this.running?.entry.key === entry.key ||
        this.world.active(entry.key)
      )
        continue;
      this.queued.push(previous.get(entry.key) ?? { entry, work: this.prepare(entry) });
    }
  }

  private entries() {
    const entries = this.ordered().filter(
      (entry) => this.ready.has(entry.key) || this.world.active(entry.key),
    );
    const keys = new Set(entries.map((entry) => entry.key));
    const unready = this.wanted.filter((entry) => !keys.has(entry.key));
    for (const old of this.world.activeEntries())
      if (!keys.has(old.key) && unready.some((entry) => overlaps(old.tile, entry.tile)))
        entries.push(old);
    return entries;
  }
  private *prepare(entry: LifeTile): Generator<void, TileLife, void> {
    const life = this.world.resident(entry.key) ?? (yield* this.world.prepareTile(entry));
    return life;
  }

  /** Only the complete bounded ready set commits at the start of an accepted frame. */
  commit() {
    if (this.epoch !== this.world.preparationEpoch) {
      this.clear();
      return;
    }
    if (!this.view) return;
    this.world.updateView(this.view);
    for (const [key, life] of this.ready)
      if (this.world.preparedExpired(key, life)) {
        this.ready.delete(key);
        this.activation = undefined;
        this.activationEntries = undefined;
        this.activationPlan = undefined;
        this.activatingKeys = undefined;
        this.dirty = true;
        this.fill();
      }
    if (!this.dirty && !this.ready.size) return;
    const ordered = this.ordered();
    const entries = this.activationEntries ?? this.entries();
    // Retain an old coarse/fine owner until its overlapping replacement is complete.
    const active = this.world.activeEntries();
    if (
      !this.activationEntries &&
      (this.ready.size || ordered.some((entry) => !this.world.active(entry.key)))
    )
      return;
    const start = this.profiler?.time();
    const keys = new Set(entries.map((entry) => entry.key));
    if (
      this.activationEntries ||
      active.length !== keys.size ||
      active.some((entry) => !keys.has(entry.key))
    )
      this.world.sync(
        entries,
        this.focus,
        this.view,
        this.ready,
        !!this.bootstrap && [...this.ready.keys()].every((key) => this.bootstrap!.has(key)),
      );
    if (this.activationEntries) {
      for (const key of this.ready.keys()) this.bootstrap?.delete(key);
      this.ready.clear();
      this.activationEntries = undefined;
      this.activatingKeys = undefined;
      this.activationPlan = undefined;
      if (start !== undefined) this.profiler!.add('activation', this.profiler!.time() - start);
    }
    this.fill();
    this.dirty = false;
  }

  camera(bounds: LifeViewContext['bounds'] | undefined, spawnMarginM: number) {
    if (bounds && this.bootstrapBounds !== bounds.join(',')) this.bootstrap?.clear();
    if (this.view && bounds) this.view = { bounds, spawnMarginM: Math.max(12, spawnMarginM) };
  }

  /** Called after active simulation. Large loops cooperate through the same eager builder. */
  slice() {
    if (this.epoch !== this.world.preparationEpoch) {
      this.clear();
      return;
    }
    if (!this.view || this.activationEntries) return;
    if (!this.running && !this.queued.length && !this.ready.size) return;
    const start = this.now();
    do {
      if (
        !this.running &&
        !this.activation &&
        this.ready.size &&
        (this.ready.size >= PREPARATION.ready || !this.queued.length)
      ) {
        const entries = this.entries();
        this.activatingKeys = entries
          .map((entry) => entry.key)
          .sort()
          .join('|');
        this.activationPlan = entries;
        this.activation = this.world.prepareActivation(entries, new Map(this.ready));
      }
      if (this.activation) {
        if (this.activation.next().done) {
          this.activation = undefined;
          this.activationEntries = this.activationPlan;
          break;
        }
        continue;
      }
      this.running ??= this.queued.shift();
      if (!this.running) break;
      const next = this.running.work.next();
      if (next.done) {
        this.ready.set(this.running.entry.key, next.value);
        this.running = undefined;
        this.fill();
      }
    } while (this.now() - start < PREPARATION.sliceMs);
    this.profiler?.add('prepareSlice', this.now() - start);
  }

  /** Bounded diagnostics for tests; never exposes private instances or iterators. */
  stats() {
    return {
      queued: this.queued.length,
      running: !!this.running || !!this.activation,
      ready: this.ready.size,
    };
  }
}
