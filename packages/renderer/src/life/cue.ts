import { SUB, unpackGlyph } from '../glyphs/select';
import type { Readback } from '../readback';
import type { VisibleAgent } from './simulate';
import type { CueReadback } from './cue-readback';
import { canReadLifeSurface, readLifeSurface, type LifeSurfaceFrame } from './surface-visibility';
import type { SpeakerGrid } from './draw';

const CONFIRMATION_MS = 1000;
const RECHECK_MS = 400;

export type CueInView<C> = C & { point: [number, number] };
export type CueConfig<C> = {
  pick(agent: VisibleAgent): C | undefined;
  key(cue: C): string;
  member(agent: VisibleAgent, cue: C): number | undefined;
  requiresSpeakers(agent: VisibleAgent, cue: C): boolean;
  displayed: readonly [number, number];
  group?(cue: C): string | undefined;
  order?(this: void, cue: C): number;
  spread?: number;
  kind: 'speech' | 'emoji';
};
export type CueFrame = LifeSurfaceFrame & {
  speakers?: SpeakerGrid;
  toCell: (lng: number, lat: number) => [number, number];
  size: { width: number; height: number };
};
type Candidate<C> = {
  key: string;
  cue: CueInView<C>;
  col: number;
  row: number;
  cls: number;
  flags: number;
};

/** One three-texel batch at a time, sharing the existing eight-read queue. Never blocks GL. */
export class CueController<C extends { id: string }> {
  private latencies = new Float64Array(8);
  private latencyCursor = 0;
  private maxLatency = 0;
  private serial = 0;
  private cursor = 0;
  private spareCursor = 0;
  private pending: { serial: number; key: string; at: number } | undefined;
  private confirmed = new Map<string, { visible: boolean; at: number }>();
  private output = '';
  constructor(
    private readonly readback: Pick<Readback, 'size' | 'request'>,
    private readonly attachment: number,
    private readonly emit: (cues: CueInView<C>[]) => void,
    private readonly config: CueConfig<C>,
    private readonly clock: () => number = () => performance.now(),
    private readonly arbiter?: CueReadback,
    private readonly speechPoints: () => readonly (readonly [number, number])[] = () => [],
  ) {}

  private ready = new Map<string, number>();
  private continuation?: string;
  clear() {
    if (this.config.kind === 'speech') this.arbiter?.speechWork(false);
    this.ready.clear();
    this.continuation = undefined;
    this.serial++;
    this.latencies.fill(0);
    this.latencyCursor = 0;
    this.maxLatency = 0;
    this.pending = undefined;
    this.confirmed.clear();
    this.publish([]);
  }
  private publish(cues: CueInView<C>[]) {
    const key = cues.map((cue) => `${this.config.key(cue)}/${cue.point.join('/')}`).join('|');
    if (key === this.output) return;
    this.output = key;
    this.emit(cues);
  }
  private candidates(frame: CueFrame): Candidate<C>[] {
    const out: Candidate<C>[] = [],
      { targets, grid, dpr } = frame;
    for (let i = 0; i < frame.agents.length; i++) {
      const agent = frame.agents[i]!;
      const cue = this.config.pick(agent);
      if (!cue) continue;
      if (this.config.requiresSpeakers(agent, cue) && !frame.speakers) continue;
      const member = this.config.member(agent, cue);
      const [x, y] = frame.speakers?.points.get(i + 1) ?? frame.toCell(agent.lng, agent.lat);
      const point: [number, number] = [
        (x * grid.cellWidth - grid.shiftX) / dpr,
        (y * grid.cellHeight - grid.shiftY) / dpr,
      ];
      if (
        point[0] < 8 ||
        point[1] < 8 ||
        point[0] > frame.size.width - 8 ||
        point[1] > frame.size.height - 8 ||
        frame.labelsCover(point)
      )
        continue;
      // A detailed figure's center can be blank. Find its nearest surviving painted cell.
      let nearest: { col: number; row: number; distance: number } | undefined;
      for (let dy = -3; dy <= 3; dy++)
        for (let dx = -3; dx <= 3; dx++) {
          const col = Math.floor(x) + dx,
            row = Math.floor(y) + dy;
          if (
            col < 0 ||
            row < 0 ||
            col >= targets.cols ||
            row >= targets.rows ||
            frame.owners[row * targets.cols + col] !== i + 1 ||
            (frame.speakers &&
              member !== undefined &&
              frame.speakers.members[row * targets.cols + col] !== member + 1)
          )
            continue;
          const distance = (col + 0.5 - x) ** 2 + (row + 0.5 - y) ** 2;
          if (!nearest || distance < nearest.distance) nearest = { col, row, distance };
        }
      if (!nearest) continue;
      const { col, row } = nearest,
        at = (row * targets.cols + col) * 4;
      out.push({
        key: `${frame.geometry}/${this.config.key(cue)}`,
        cue: { ...cue, point },
        col,
        row,
        cls: unpackGlyph(frame.life[at]!, frame.life[at + 1]!).cls,
        flags: frame.life[at + 2]!,
      });
    }
    // Prefer the map's center, leaving room around edge controls and attribution.
    const distance = (entry: Candidate<C>) =>
      (entry.cue.point[0] - frame.size.width / 2) ** 2 +
      (entry.cue.point[1] - frame.size.height / 2) ** 2;
    const groups = this.groups(out).filter((group) => {
      const pair = this.config.group?.(group[0]!.cue);
      return (
        !pair ||
        (group.length === 2 &&
          frame.agents.filter((a) => {
            const cue = this.config.pick(a);
            return cue && this.config.group?.(cue) === pair;
          }).length === 2)
      );
    });
    const order = this.config.order;
    if (order)
      for (const group of groups)
        if (group.length > 1) group.sort((a, b) => order(a.cue) - order(b.cue));
    groups.sort(
      (a, b) => distance(a[0]!) - distance(b[0]!) || a[0]!.cue.id.localeCompare(b[0]!.cue.id),
    );
    const selected: Candidate<C>[] = [],
      cap = frame.size.width <= 640 ? 4 : 6;
    for (const group of groups) if (selected.length + group.length <= cap) selected.push(...group);
    return selected;
  }
  private groups(candidates: readonly Candidate<C>[]): Candidate<C>[][] {
    const groups = new Map<string, Candidate<C>[]>();
    for (const c of candidates) {
      const id = this.config.group?.(c.cue) ?? c.key;
      const group = groups.get(id) ?? [];
      group.push(c);
      groups.set(id, group);
    }
    return [...groups.values()];
  }
  update(frame: CueFrame | null, now: number) {
    if (!frame) {
      this.clear();
      return;
    }
    const candidates = this.candidates(frame),
      keys = new Set(candidates.map((entry) => entry.key));
    for (const key of this.confirmed.keys()) if (!keys.has(key)) this.confirmed.delete(key);
    for (const key of this.ready.keys()) if (!keys.has(key)) this.ready.delete(key);
    if (this.pending && (now - this.pending.at >= CONFIRMATION_MS || !keys.has(this.pending.key))) {
      this.serial++;
      this.pending = undefined;
    }
    const limit = this.config.displayed[frame.size.width <= 640 ? 1 : 0];
    const displayed: Candidate<C>[] = [];
    for (const group of this.groups(candidates)) {
      if (
        displayed.length + group.length > limit ||
        group.some((entry) => {
          const result = this.confirmed.get(entry.key);
          return !result?.visible || now - result.at >= CONFIRMATION_MS;
        })
      )
        continue;
      const spread = this.config.spread;
      if (
        spread &&
        group.some((entry) =>
          [...displayed.map((c) => c.cue.point), ...this.speechPoints()].some(
            (point) =>
              Math.hypot(entry.cue.point[0] - point[0], entry.cue.point[1] - point[1]) < spread,
          ),
        )
      )
        continue;
      displayed.push(...group);
    }
    this.publish(displayed.map((entry) => entry.cue));
    // Leave headroom for picks arriving while this three-read batch is in flight.
    if (this.pending || !candidates.length || !canReadLifeSurface(this.readback)) {
      if (this.config.kind === 'speech')
        this.arbiter?.speechWork(!!this.pending || !!candidates.length);
      return;
    }
    // Finish a rotation before confirmations expire, including a spare candidate.
    const refreshSlots = Math.min(limit, candidates.length) + Number(candidates.length > limit);
    const refreshAge = Math.max(
      0,
      Math.min(RECHECK_MS, CONFIRMATION_MS - this.maxLatency * refreshSlots - 100),
    );
    const due = (entry: Candidate<C>) => {
      const result = this.confirmed.get(entry.key);
      return !result || now - result.at >= refreshAge;
    };
    const spares = candidates.filter((entry) => !displayed.includes(entry) && due(entry));
    const spare = spares.length ? spares[this.spareCursor % spares.length] : undefined;
    const scheduled = [...displayed.filter(due), ...(spare ? [spare] : [])];
    if (this.config.kind === 'speech')
      this.arbiter?.speechWork(
        scheduled.length > 0,
        Math.min(
          Infinity,
          ...displayed.map((c) => this.confirmed.get(c.key)!.at + CONFIRMATION_MS),
        ),
      );
    if (!scheduled.length) return;
    const continuation = candidates.find((c) => c.key === this.continuation && due(c));
    const candidate = continuation ?? scheduled[this.cursor % scheduled.length]!;
    if (!this.ready.has(candidate.key)) this.ready.set(candidate.key, now);
    const release = this.arbiter?.acquire(this.config.kind, now);
    if (this.arbiter && !release) return;
    if (!continuation) this.cursor++;
    if (candidate === spare) this.spareCursor++;
    const serial = ++this.serial;
    // A slow frame can spend most of the watchdog interval drawing before this request.
    // Start its timeout when the GPU batch is issued, rather than at the RAF timestamp.
    this.pending = { serial, key: candidate.key, at: Math.max(now, this.clock()) };
    const issuedAt = this.pending.at;
    readLifeSurface(
      this.readback,
      this.attachment,
      frame.targets,
      {
        col: candidate.col,
        row: candidate.row,
        sx: Math.floor(SUB.cols / 2),
        sy: Math.floor(SUB.rows / 2),
        cls: candidate.cls,
        flags: candidate.flags,
      },
      (visible) => {
        if (this.pending?.serial !== serial) return;
        const completedAt = this.clock();
        this.latencies[this.latencyCursor++ % this.latencies.length] = Math.max(
          0,
          completedAt - (this.arbiter ? (this.ready.get(candidate.key) ?? issuedAt) : issuedAt),
        );
        this.maxLatency = 0;
        for (const latency of this.latencies) this.maxLatency = Math.max(this.maxLatency, latency);
        this.arbiter?.completed(Math.max(0, completedAt - issuedAt));
        this.ready.delete(candidate.key);
        const pair = this.config.group?.(candidate.cue);
        this.continuation =
          pair && visible
            ? candidates.find(
                (c) =>
                  c.key !== candidate.key &&
                  this.config.group?.(c.cue) === pair &&
                  !this.confirmed.has(c.key),
              )?.key
            : undefined;
        this.pending = undefined;
        // The shared grids may already contain the next draw. update() filters this
        // captured key against that frame before publishing its current position.
        this.confirmed.set(candidate.key, {
          at: completedAt,
          visible,
        });
      },
      release,
    );
  }
}
