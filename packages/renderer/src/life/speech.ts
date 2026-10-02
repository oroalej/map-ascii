import { SUB, unpackGlyph } from '../glyphs/select';
import type { Readback } from '../readback';
import type { SpeechCue } from './moments';
import { canReadLifeSurface, readLifeSurface, type LifeSurfaceFrame } from './surface-visibility';
import type { SpeakerGrid } from './draw';

const CONFIRMATION_MS = 1000;
const RECHECK_MS = 400;

export type SpeechInView = SpeechCue & { point: [number, number] };
export type SpeechFrame = LifeSurfaceFrame & {
  speakers?: SpeakerGrid;
  toCell: (lng: number, lat: number) => [number, number];
  size: { width: number; height: number };
};
type Candidate = {
  key: string;
  cue: SpeechInView;
  col: number;
  row: number;
  cls: number;
  flags: number;
};

/** One three-texel batch at a time, sharing the existing eight-read queue. Never blocks GL. */
export class SpeechController {
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
    private readonly emit: (cues: SpeechInView[]) => void,
    private readonly clock: () => number = () => performance.now(),
  ) {}

  clear() {
    this.serial++;
    this.latencies.fill(0);
    this.latencyCursor = 0;
    this.maxLatency = 0;
    this.pending = undefined;
    this.confirmed.clear();
    this.publish([]);
  }
  private publish(cues: SpeechInView[]) {
    const key = cues
      .map((cue) => `${cue.id}/${cue.exchangeId}/${cue.line}/${cue.point.join('/')}`)
      .join('|');
    if (key === this.output) return;
    this.output = key;
    this.emit(cues);
  }
  private candidates(frame: SpeechFrame): Candidate[] {
    const out: Candidate[] = [],
      { targets, grid, dpr } = frame;
    for (let i = 0; i < frame.agents.length; i++) {
      const agent = frame.agents[i]!;
      if (!agent.speech || agent.kind !== 'person' || agent.prop || agent.aboard) continue;
      if ((agent.vehicle || agent.speech.member !== undefined) && !frame.speakers) continue;
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
              frame.speakers.members[row * targets.cols + col] !== (agent.speech.member ?? 0) + 1)
          )
            continue;
          const distance = (col + 0.5 - x) ** 2 + (row + 0.5 - y) ** 2;
          if (!nearest || distance < nearest.distance) nearest = { col, row, distance };
        }
      if (!nearest) continue;
      const { col, row } = nearest,
        at = (row * targets.cols + col) * 4;
      out.push({
        key: `${frame.geometry}/${agent.speech.id}/${agent.speech.exchangeId}/${agent.speech.line}/${agent.speech.member ?? 0}`,
        cue: { ...agent.speech, point },
        col,
        row,
        cls: unpackGlyph(frame.life[at]!, frame.life[at + 1]!).cls,
        flags: frame.life[at + 2]!,
      });
    }
    // Prefer the map's center, leaving room around edge controls and attribution.
    const distance = (entry: Candidate) =>
      (entry.cue.point[0] - frame.size.width / 2) ** 2 +
      (entry.cue.point[1] - frame.size.height / 2) ** 2;
    return out
      .sort((a, b) => distance(a) - distance(b) || a.cue.id.localeCompare(b.cue.id))
      .slice(0, frame.size.width <= 640 ? 4 : 6);
  }
  update(frame: SpeechFrame | null, now: number) {
    if (!frame) {
      this.clear();
      return;
    }
    const candidates = this.candidates(frame),
      keys = new Set(candidates.map((entry) => entry.key));
    for (const key of this.confirmed.keys()) if (!keys.has(key)) this.confirmed.delete(key);
    if (this.pending && (now - this.pending.at >= CONFIRMATION_MS || !keys.has(this.pending.key))) {
      this.serial++;
      this.pending = undefined;
    }
    const limit = frame.size.width <= 640 ? 2 : 3;
    const displayed = candidates
      .filter((entry) => {
        const result = this.confirmed.get(entry.key);
        return result?.visible && now - result.at < CONFIRMATION_MS;
      })
      .slice(0, limit);
    this.publish(displayed.map((entry) => entry.cue));
    // Leave headroom for picks arriving while this three-read batch is in flight.
    if (this.pending || !candidates.length || !canReadLifeSurface(this.readback)) return;
    // Finish a rotation before confirmations expire, including a spare candidate.
    const refreshSlots = Math.min(limit, candidates.length) + Number(candidates.length > limit);
    const refreshAge = Math.max(
      0,
      Math.min(RECHECK_MS, CONFIRMATION_MS - this.maxLatency * refreshSlots - 100),
    );
    const due = (entry: Candidate) => {
      const result = this.confirmed.get(entry.key);
      return !result || now - result.at >= refreshAge;
    };
    const spares = candidates.filter((entry) => !displayed.includes(entry) && due(entry));
    const spare = spares.length ? spares[this.spareCursor % spares.length] : undefined;
    const scheduled = [...displayed.filter(due), ...(spare ? [spare] : [])];
    if (!scheduled.length) return;
    const candidate = scheduled[this.cursor++ % scheduled.length]!;
    if (candidate === spare) this.spareCursor++;
    const serial = ++this.serial;
    // A slow frame can spend most of the watchdog interval drawing before this request.
    // Start its timeout when the GPU batch is issued, rather than at the RAF timestamp.
    this.pending = { serial, key: candidate.key, at: Math.max(now, this.clock()) };
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
          completedAt - this.pending.at,
        );
        this.maxLatency = 0;
        for (const latency of this.latencies) this.maxLatency = Math.max(this.maxLatency, latency);
        this.pending = undefined;
        // The shared grids may already contain the next draw. update() filters this
        // captured key against that frame before publishing its current position.
        this.confirmed.set(candidate.key, {
          at: completedAt,
          visible,
        });
      },
    );
  }
}
