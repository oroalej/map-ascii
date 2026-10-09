import { pointerCell } from '../picking';
import { cellAt } from '../grid';
import { SUB, unpackGlyph } from '../glyphs/select';
import { folkloreHit } from '../folklore-pass';
import { agentAt, describeAgent } from './describe';
import { LIFE_AGENT_MASK } from './turn-signals';
import { readLifeSurface, type LifeSurfaceFrame } from './surface-visibility';
import type { Readback } from '../readback';
import type { FolkloreQuad } from '../folklore-pass';
import type { LifeTap } from './tap';
import { classId } from '../classes';
import { CellBit } from './config';
import { THRONG_MASK_SIDE, THRONG_MASK_WORDS } from './crowd-mask';

export type TapCaptureFrame = LifeSurfaceFrame & {
  generation: number;
  frame: number;
  folklore: readonly FolkloreQuad[];
  crowdMask?: Uint32Array;
};

/** Captures the displayed frame independently of mouse hover and inspection. */
export function captureTap(
  point: readonly [number, number],
  tap: Omit<LifeTap, 'id' | 'agent' | 'folklore'>,
  f: TapCaptureFrame,
  reads: Pick<Readback, 'size' | 'request'>,
  attachment: number,
  current: () => boolean,
  done: (tap: Omit<LifeTap, 'id'>) => void,
) {
  if (f.labelsCover(point)) return;
  const folklore = folkloreHit(f.folklore, point, f.dpr);
  if (folklore && folklore.kind !== 'lower-half') {
    if (current()) done({ ...tap, folklore: folklore.id });
    return;
  }
  const [col, row] = pointerCell(point, f.dpr, f.grid);
  const agent = agentAt(f.owners, f.targets.cols, f.targets.rows, f.agents, [col, row]);
  const [x, y] = cellAt(point, f.dpr, f.grid);
  const sx = Math.min(SUB.cols - 1, Math.floor((x - col) * SUB.cols));
  const sy = Math.min(SUB.rows - 1, Math.floor((y - row) * SUB.rows));
  const fixture = () => {
    if (!tap.signal && !tap.carnival && !tap.candle) {
      if (current()) done(tap);
      return;
    }
    readLifeSurface(
      reads,
      attachment,
      f.targets,
      { col, row, sx, sy, cls: classId('life_person'), flags: CellBit.person, exposeCoarse: true },
      (visible, coarse) => {
        if (visible === undefined || !current()) return;
        done(
          visible
            ? tap
            : {
                ...tap,
                signal: undefined,
                carnival: undefined,
                candle: coarse === classId('building_part') ? tap.candle : undefined,
              },
        );
      },
    );
  };
  if (!agent || !describeAgent(agent)) {
    const mx = Math.floor((x - col) * THRONG_MASK_SIDE);
    const my = Math.floor((y - row) * THRONG_MASK_SIDE);
    const bit = my * THRONG_MASK_SIDE + mx;
    const word = f.crowdMask?.[(row * f.targets.cols + col) * THRONG_MASK_WORDS + (bit >> 5)];
    // Snapshot the displayed mask bit before the mutable raster is packed again.
    const crowd =
      col >= 0 &&
      col < f.targets.cols &&
      row >= 0 &&
      row < f.targets.rows &&
      word !== undefined &&
      (word & (1 << (bit & 31))) !== 0;
    if (crowd) {
      readLifeSurface(
        reads,
        attachment,
        f.targets,
        { col, row, sx, sy, cls: classId('life_person'), flags: CellBit.person },
        (visible) => {
          if (visible === undefined || !current()) return;
          if (visible) done({ ...tap, crowd: true });
          else fixture();
        },
      );
      return;
    }
    fixture();
    return;
  }
  const offset = (row * f.targets.cols + col) * 4;
  readLifeSurface(
    reads,
    attachment,
    f.targets,
    {
      col,
      row,
      sx,
      sy,
      cls: unpackGlyph(f.life[offset]!, f.life[offset + 1]!).cls,
      flags: f.life[offset + 2]! & LIFE_AGENT_MASK,
    },
    (visible) => {
      if (visible === undefined || !current()) return;
      if (visible) done({ ...tap, agent: f.agents.indexOf(agent) });
      else fixture();
    },
  );
}
