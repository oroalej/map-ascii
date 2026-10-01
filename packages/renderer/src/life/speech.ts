import type { CellTargets } from '../gpu';
import { SUB, unpackGlyph } from '../glyphs/select';
import type { GridPlacement } from '../picking';
import type { Readback } from '../readback';
import type { VisibleAgent } from './simulate';
import type { SpeechCue } from './moments';
import { lifeVisibleOnSurface } from './surface-visibility';
import type { SpeakerGrid } from './draw';

const CONFIRMATION_MS = 1000;
const RECHECK_MS = 120;

export type SpeechInView = SpeechCue & { point: [number, number] };
export type SpeechFrame = {
  targets: Pick<CellTargets, 'cols' | 'rows' | 'glyphFbo' | 'sub'>;
  grid: GridPlacement;
  dpr: number;
  geometry: string;
  owners: Uint32Array;
  speakers?: SpeakerGrid;
  life: Uint8Array;
  agents: readonly VisibleAgent[];
  toCell: (lng: number, lat: number) => [number, number];
  size: { width: number; height: number };
  labelsCover: (point: readonly [number, number]) => boolean;
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
  private frame: SpeechFrame | null = null;
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
    this.frame = null;
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
        key: `${frame.geometry}/${agent.speech.id}/${agent.speech.exchangeId}/${agent.speech.line}/${col}/${row}`,
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
    this.frame = frame;
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
    if (this.pending || !candidates.length || this.readback.size > 1) return;
    const due = (entry: Candidate) => {
      const result = this.confirmed.get(entry.key);
      return !result || now - result.at >= RECHECK_MS;
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
    const bytes: (Uint8Array | undefined)[] = [];
    const done = (index: number) => (data: Uint8Array) => {
      if (this.pending?.serial !== serial) return;
      bytes[index] = data;
      if (!bytes[0] || !bytes[1] || !bytes[2]) return;
      this.pending = undefined;
      if (!this.frame || !this.candidates(this.frame).some((entry) => entry.key === candidate.key))
        return;
      this.confirmed.set(candidate.key, {
        at: this.clock(),
        visible: lifeVisibleOnSurface(
          candidate.cls,
          candidate.flags,
          unpackGlyph(bytes[0][0]!, bytes[0][1]!).cls,
          bytes[1][0]!,
          bytes[2][0]!,
        ),
      });
    };
    this.readback.request(
      frame.targets.glyphFbo,
      this.attachment,
      { x: candidate.col, y: candidate.row, width: 1, height: 1 },
      done(0),
    );
    const rect = {
      x: candidate.col * SUB.cols + Math.floor(SUB.cols / 2),
      y: candidate.row * SUB.rows + Math.floor(SUB.rows / 2),
      width: 1,
      height: 1,
    };
    this.readback.request(frame.targets.sub.fbo, this.attachment, rect, done(1));
    this.readback.request(frame.targets.sub.fbo, this.attachment + 1, rect, done(2));
  }
}
