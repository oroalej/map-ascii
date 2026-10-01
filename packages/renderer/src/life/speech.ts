import type { CellTargets } from '../gpu';
import { SUB } from '../glyphs/select';
import type { GridPlacement } from '../picking';
import { MAX_PENDING_READS, type Readback } from '../readback';
import type { VisibleAgent } from './simulate';
import type { SpeechCue } from './moments';
import { lifeVisibleOnSurface } from './surface-visibility';

export type SpeechInView = SpeechCue & { point: [number, number] };
export type SpeechFrame = {
  targets: Pick<CellTargets, 'cols' | 'rows' | 'glyphFbo' | 'sub'>;
  grid: GridPlacement;
  dpr: number;
  geometry: string;
  owners: Uint32Array;
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
  private pending: { serial: number; key: string; at: number } | undefined;
  private confirmed = new Map<string, { visible: boolean; at: number }>();
  private output = '';
  constructor(
    private readonly readback: Pick<Readback, 'size' | 'request'>,
    private readonly attachment: number,
    private readonly emit: (cues: SpeechInView[]) => void,
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
      if (!agent.speech || agent.kind !== 'person' || agent.prop || agent.vehicle) continue;
      const [x, y] = frame.toCell(agent.lng, agent.lat);
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
            frame.owners[row * targets.cols + col] !== i + 1
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
        cls: frame.life[at + 1]! & 63,
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
    if (this.pending && (now - this.pending.at >= 250 || !keys.has(this.pending.key))) {
      this.serial++;
      this.pending = undefined;
    }
    this.publish(
      candidates
        .filter((entry) => {
          const result = this.confirmed.get(entry.key);
          return result?.visible && now - result.at < 250;
        })
        .slice(0, frame.size.width <= 640 ? 2 : 3)
        .map((entry) => entry.cue),
    );
    if (this.pending || !candidates.length || this.readback.size > MAX_PENDING_READS - 3) return;
    const due = candidates.filter(
      (entry) => !this.confirmed.has(entry.key) || now - this.confirmed.get(entry.key)!.at >= 120,
    );
    if (!due.length) return;
    const candidate = due[this.cursor++ % due.length]!;
    const serial = ++this.serial;
    this.pending = { serial, key: candidate.key, at: now };
    const bytes: (Uint8Array | undefined)[] = [];
    const done = (index: number) => (data: Uint8Array) => {
      if (this.pending?.serial !== serial) return;
      bytes[index] = data;
      if (!bytes[0] || !bytes[1] || !bytes[2]) return;
      this.pending = undefined;
      if (!this.frame || !this.candidates(this.frame).some((entry) => entry.key === candidate.key))
        return;
      this.confirmed.set(candidate.key, {
        at: now,
        visible: lifeVisibleOnSurface(
          candidate.cls,
          candidate.flags,
          bytes[0][1]! & 63,
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
